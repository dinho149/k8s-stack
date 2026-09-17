package broker

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gravitational/teleport/api/types"

	"github.com/dinho/k8s-teleport/services/teleport-access/internal/policy"
	"github.com/dinho/k8s-teleport/services/teleport-access/internal/teleport/fake"
)

const testPolicy = `
kind: ApprovalPolicy
defaults: {action: require_approval, max_ttl: 8h, approvers: {teleport_roles: [approver]}}
rules:
  - {name: never, match: {roles: [editor]}, action: deny}
  - {name: auto, match: {roles: ['dev-*']}, action: auto_approve, ttl_cap: 4h}
  - name: prod
    match: {roles: ['prod-*']}
    action: require_approval
    approvers: {teleport_roles: [approver]}
    notify: {channels: [{adapter: slack, target: "#access"}], mention_approvers: true}
`

func newSvc(t *testing.T, webhook string) (*Service, *fake.API) {
	t.Helper()
	f := fake.New()
	f.Me = "bot-access-broker"
	alice, _ := types.NewUser("alice")
	alice.SetRoles([]string{"requester"})
	alice.SetTraits(map[string][]string{"email": {"alice@example.com"}})
	bob, _ := types.NewUser("bob")
	bob.SetRoles([]string{"requester", "approver"})
	bob.SetTraits(map[string][]string{"email": {"bob@example.com"}})
	f.Users["alice"], f.Users["bob"] = alice, bob
	p, err := policy.Parse([]byte(testPolicy))
	if err != nil {
		t.Fatal(err)
	}
	return &Service{API: f, Policy: policy.NewEngine(p), Store: NewStore(""), Log: slog.New(slog.NewTextHandler(testWriter{t}, nil)), Mode: ModeSetState, SelfUser: "bot-access-broker",
		FallbackApproverRoles: []string{"approver"}, Notifier: &Notifier{URL: webhook, Secret: "s", Log: slog.Default()}}, f
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(b []byte) (int, error) { w.t.Log(strings.TrimSpace(string(b))); return len(b), nil }

func request(t *testing.T, f *fake.API, user string, roles []string, ttl time.Duration) types.AccessRequest {
	t.Helper()
	r, err := types.NewAccessRequest(uuid.NewString(), user, roles...)
	if err != nil {
		t.Fatal(err)
	}
	r.SetRequestReason("test")
	r.SetAccessExpiry(time.Now().Add(ttl))
	created, err := f.CreateAccessRequestV2(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	return created
}

func TestAutoApproveIsIdempotentAndAnnotated(t *testing.T) {
	var calls atomic.Int32
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var ev Event
		_ = json.NewDecoder(r.Body).Decode(&ev)
		if ev.Type != "request.resolved" || ev.Resolution == nil || ev.Resolution.Mode != "auto" {
			t.Errorf("unexpected event %+v", ev)
		}
		if r.Header.Get("X-Broker-Signature") == "" {
			t.Error("unsigned webhook")
		}
	}))
	defer hook.Close()
	svc, f := newSvc(t, hook.URL)
	var updates []types.AccessRequestUpdate
	f.OnSetState = func(u types.AccessRequestUpdate) error { updates = append(updates, u); return nil }

	r := request(t, f, "alice", []string{"dev-ssh"}, time.Hour)
	if err := svc.Handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if err := svc.Handle(context.Background(), r); err != nil { // duplicate event
		t.Fatal(err)
	}
	if len(updates) != 1 || updates[0].State != types.RequestState_APPROVED || updates[0].Annotations["access-broker/rule"][0] != "auto" {
		t.Fatalf("updates = %+v", updates)
	}
	time.Sleep(200 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("webhook calls = %d", calls.Load())
	}
}

func TestDenyRule(t *testing.T) {
	svc, f := newSvc(t, "")
	r := request(t, f, "alice", []string{"editor"}, time.Hour)
	if err := svc.Handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	got, _ := f.GetAccessRequests(context.Background(), types.AccessRequestFilter{ID: r.GetName()})
	if got[0].GetState() != types.RequestState_DENIED {
		t.Fatalf("state = %v", got[0].GetState())
	}
}

func TestRequireApprovalThenHumanDecision(t *testing.T) {
	events := make(chan Event, 4)
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var ev Event
		_ = json.NewDecoder(r.Body).Decode(&ev)
		events <- ev
	}))
	defer hook.Close()
	svc, f := newSvc(t, hook.URL)
	r := request(t, f, "alice", []string{"prod-ssh"}, 2*time.Hour)
	if err := svc.Handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	ev := <-events
	if ev.Type != "request.pending_review" || ev.Notify == nil || ev.Notify.Channels[0].Target != "#access" || ev.RequesterEmail != "alice@example.com" {
		t.Fatalf("pending event = %+v", ev)
	}
	if len(ev.ApproverEmails) != 1 || ev.ApproverEmails[0] != "bob@example.com" {
		t.Fatalf("approver emails = %v", ev.ApproverEmails)
	}
	got, _ := f.GetAccessRequests(context.Background(), types.AccessRequestFilter{ID: r.GetName()})
	if got[0].GetState() != types.RequestState_PENDING {
		t.Fatal("request should still be pending")
	}

	// self approval
	if _, err := svc.Approve(context.Background(), r.GetName(), Approver{TeleportUser: "alice", Adapter: "slack"}, "me"); err != ErrSelfApproval {
		t.Fatalf("want ErrSelfApproval, got %v", err)
	}
	// non-approver (unknown user)
	if _, err := svc.Approve(context.Background(), r.GetName(), Approver{TeleportUser: "carol", Adapter: "slack"}, "x"); err != ErrNotApprover {
		t.Fatalf("want ErrNotApprover, got %v", err)
	}
	// bob approves via prefix id
	upd, err := svc.Approve(context.Background(), r.GetName()[:8], Approver{TeleportUser: "bob", Email: "bob@example.com", Adapter: "slack", PlatformUserID: "U1"}, "incident 42")
	if err != nil {
		t.Fatal(err)
	}
	if upd.GetState() != types.RequestState_APPROVED || !strings.Contains(upd.GetResolveReason(), "bob") {
		t.Fatalf("approved = %v %q", upd.GetState(), upd.GetResolveReason())
	}
	ev = <-events
	if ev.Type != "request.resolved" || ev.Resolution.By != "bob" || ev.Resolution.Mode != "chat" {
		t.Fatalf("resolved event = %+v", ev)
	}
	// second decision -> not pending
	if _, err := svc.Deny(context.Background(), r.GetName(), Approver{TeleportUser: "bob"}, "late"); err != ErrNotPending {
		t.Fatalf("want ErrNotPending, got %v", err)
	}
}

func TestHTTPAPIErrorsAndAuth(t *testing.T) {
	svc, f := newSvc(t, "")
	r := request(t, f, "alice", []string{"prod-ssh"}, time.Hour)
	_ = svc.Handle(context.Background(), r)
	h := svc.Handler("tok")
	do := func(method, path, body, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	if rec := do("GET", "/v1/requests", "", ""); rec.Code != 401 {
		t.Fatalf("no auth -> %d", rec.Code)
	}
	rec := do("GET", "/v1/requests?state=pending", "", "tok")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"decision"`) {
		t.Fatalf("list -> %d %s", rec.Code, rec.Body.String())
	}
	rec = do("POST", "/v1/requests/"+r.GetName()+"/approve", `{"approver":{"teleport_user":"alice","adapter":"cli"},"reason":"x"}`, "tok")
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), "self_approval") {
		t.Fatalf("self approval -> %d %s", rec.Code, rec.Body.String())
	}
	rec = do("POST", "/v1/requests/"+r.GetName()+"/approve", `{"approver":{"teleport_user":"bob","adapter":"cli"},"reason":"ok"}`, "tok")
	if rec.Code != 200 {
		t.Fatalf("approve -> %d %s", rec.Code, rec.Body.String())
	}
	rec = do("POST", "/v1/requests/"+r.GetName()+"/deny", `{"approver":{"teleport_user":"bob","adapter":"cli"},"reason":"late"}`, "tok")
	if rec.Code != 409 {
		t.Fatalf("second decision -> %d", rec.Code)
	}
	if rec := do("GET", "/v1/users/by-email?email=Bob@Example.com", "", "tok"); !strings.Contains(rec.Body.String(), `"bob"`) {
		t.Fatalf("by-email -> %s", rec.Body.String())
	}
	if rec := do("GET", "/healthz", "", ""); rec.Code != 200 {
		t.Fatalf("healthz -> %d", rec.Code)
	}
}

func TestSignature(t *testing.T) {
	sig := Sign("s", "123", []byte(`{"a":1}`))
	if !strings.HasPrefix(sig, "sha256=") || len(sig) != 71 {
		t.Fatalf("sig = %s", sig)
	}
}
