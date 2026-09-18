package broker

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gravitational/teleport/api/types"

	"github.com/dinho/k8s-teleport/services/teleport-access/internal/assertion"
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
    approvers: {teleport_roles: [approver], emails: [oncall@example.com]}
    notify: {channels: [{adapter: slack, target: "#access"}], mention_approvers: true}
`

var identityKey = []byte("test-identity-signing-key-0123456789")

func newSvc(t *testing.T, webhook string) (*Service, *fake.API) {
	t.Helper()
	f := fake.New()
	f.Me = "bot-access-broker"
	addUser := func(name string, roles []string, email string) {
		u, _ := types.NewUser(name)
		u.SetRoles(roles)
		if email != "" {
			u.SetTraits(map[string][]string{"email": {email}})
		}
		f.Users[name] = u
	}
	addUser("alice", []string{"requester"}, "alice@example.com")
	addUser("bob", []string{"requester", "approver"}, "bob@example.com")
	addUser("carol", []string{"requester"}, "carol@example.com")             // not an approver; oncall email belongs to someone else
	addUser("dave", []string{"requester"}, "oncall@example.com")             // approver by email allow-list
	addUser("Alice", []string{"requester", "approver"}, "ALICE@example.com") // same human as alice, different case
	p, err := policy.Parse([]byte(testPolicy))
	if err != nil {
		t.Fatal(err)
	}
	st, _ := NewStore("")
	return &Service{API: f, Policy: policy.NewEngine(p), Store: st, Log: slog.New(slog.NewTextHandler(testWriter{t}, nil)), Mode: ModeSetState, SelfUser: "bot-access-broker",
		FallbackApproverRoles: []string{"approver"}, Notifier: &Notifier{URL: webhook, Secret: "s", Log: slog.Default()}}, f
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(b []byte) (int, error) {
	w.t.Log(strings.TrimSpace(string(b)))
	return len(b), nil
}

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

func assertionFor(t *testing.T, sub, email string) string {
	t.Helper()
	now := time.Now().Unix()
	h, err := assertion.Sign(identityKey, assertion.Payload{Sub: sub, Email: email, Platform: "slack", PlatformUserID: "U-" + sub, Aud: assertion.AudienceBroker, Iat: now, Exp: now + 30, JTI: uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func stateOf(t *testing.T, f *fake.API, id string) types.RequestState {
	t.Helper()
	got, _ := f.GetAccessRequests(context.Background(), types.AccessRequestFilter{ID: id})
	if len(got) != 1 {
		t.Fatalf("request %s not found", id)
	}
	return got[0].GetState()
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

func TestMixedRoleRequestsAreNotAutoApproved(t *testing.T) {
	svc, f := newSvc(t, "")
	for _, roles := range [][]string{{"dev-ssh", "k8s-admin"}, {"dev-ssh", "prod-ssh"}} {
		r := request(t, f, "alice", roles, time.Hour)
		if err := svc.Handle(context.Background(), r); err != nil {
			t.Fatal(err)
		}
		if st := stateOf(t, f, r.GetName()); st != types.RequestState_PENDING {
			t.Fatalf("%v: state = %v, want PENDING", roles, st)
		}
		rec, _ := svc.Store.Get(r.GetName())
		if rec.Decision.Action != policy.ActionRequireApproval {
			t.Fatalf("%v: decision = %+v", roles, rec.Decision)
		}
	}
	r := request(t, f, "alice", []string{"dev-ssh", "editor"}, time.Hour)
	_ = svc.Handle(context.Background(), r)
	if st := stateOf(t, f, r.GetName()); st != types.RequestState_DENIED {
		t.Fatalf("[dev-ssh editor]: state = %v, want DENIED", st)
	}
	// Resource-only request (no roles): never auto-approved.
	rr, err := types.NewAccessRequestWithResources(uuid.NewString(), "alice", nil, []types.ResourceAccessID{{Id: types.ResourceID{ClusterName: "test", Kind: types.KindNode, Name: "ssh-dev-0"}}})
	if err != nil {
		t.Fatal(err)
	}
	rr.SetAccessExpiry(time.Now().Add(time.Hour))
	if _, err := f.CreateAccessRequestV2(context.Background(), rr); err != nil {
		t.Fatal(err)
	}
	_ = svc.Handle(context.Background(), rr)
	if st := stateOf(t, f, rr.GetName()); st == types.RequestState_APPROVED {
		t.Fatal("request without roles must not be auto-approved")
	}
}

func TestServiceBeltAndBracesDowngrade(t *testing.T) {
	// Engine that would auto-approve the pair via one rule while a role alone requires approval.
	p, err := policy.Parse([]byte(`
kind: ApprovalPolicy
defaults: {action: require_approval, max_ttl: 8h}
rules:
  - {name: k8s, match: {roles: ['k8s-*'], requested_ttl_max: 30m}, action: require_approval}
  - {name: pair, match: {roles: ['dev-*', 'k8s-*']}, action: auto_approve}
`))
	if err != nil {
		t.Fatal(err)
	}
	svc, f := newSvc(t, "")
	svc.Policy = policy.NewEngine(p)
	r := request(t, f, "alice", []string{"dev-ssh", "k8s-admin"}, 10*time.Minute)
	if err := svc.Handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if st := stateOf(t, f, r.GetName()); st != types.RequestState_PENDING {
		t.Fatalf("state = %v, want PENDING", st)
	}
}

func TestDenyRule(t *testing.T) {
	svc, f := newSvc(t, "")
	r := request(t, f, "alice", []string{"editor"}, time.Hour)
	if err := svc.Handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if st := stateOf(t, f, r.GetName()); st != types.RequestState_DENIED {
		t.Fatalf("state = %v", st)
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
	if len(ev.ApproverEmails) != 3 || ev.ApproverEmails[0] != "oncall@example.com" {
		t.Fatalf("approver emails = %v", ev.ApproverEmails)
	}
	if st := stateOf(t, f, r.GetName()); st != types.RequestState_PENDING {
		t.Fatal("request should still be pending")
	}

	// self approval
	if _, err := svc.Approve(context.Background(), r.GetName(), Approver{TeleportUser: "alice", Adapter: "slack"}, "me"); err != ErrSelfApproval {
		t.Fatalf("want ErrSelfApproval, got %v", err)
	}
	// case-variant self approval: "Alice" holds approver but is the same person as "alice".
	if _, err := svc.Approve(context.Background(), r.GetName(), Approver{TeleportUser: "Alice", Adapter: "slack"}, "me"); err != ErrSelfApproval {
		t.Fatalf("case-variant self approval: want ErrSelfApproval, got %v", err)
	}
	// approver whose asserted email equals the requester's email trait
	if _, err := svc.Approve(context.Background(), r.GetName(), Approver{TeleportUser: "bob", Email: "ALICE@example.com", Adapter: "slack"}, "me"); err != ErrSelfApproval {
		t.Fatalf("email self approval: want ErrSelfApproval, got %v", err)
	}
	// non-approver (unknown user)
	if _, err := svc.Approve(context.Background(), r.GetName(), Approver{TeleportUser: "erin", Adapter: "slack"}, "x"); err != ErrNotApprover {
		t.Fatalf("want ErrNotApprover, got %v", err)
	}
	// email allow-list only counts when the email is one of the approver's own traits
	if _, err := svc.Approve(context.Background(), r.GetName(), Approver{TeleportUser: "carol", Email: "oncall@example.com", Adapter: "slack"}, "x"); err != ErrNotApprover {
		t.Fatalf("email not in traits: want ErrNotApprover, got %v", err)
	}
	// empty approver
	if _, err := svc.Approve(context.Background(), r.GetName(), Approver{}, "x"); err != ErrNotApprover {
		t.Fatalf("empty approver: want ErrNotApprover, got %v", err)
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

	// email allow-list approval by the user who owns that email trait
	r2 := request(t, f, "alice", []string{"prod-ssh"}, 2*time.Hour)
	_ = svc.Handle(context.Background(), r2)
	<-events
	if _, err := svc.Approve(context.Background(), r2.GetName(), Approver{TeleportUser: "dave", Email: "OnCall@Example.com", Adapter: "slack"}, "ok"); err != nil {
		t.Fatalf("email allow-list approval by trait owner: %v", err)
	}
	<-events
}

func TestHTTPAPIErrorsAndAuth(t *testing.T) {
	svc, f := newSvc(t, "")
	r := request(t, f, "alice", []string{"prod-ssh"}, time.Hour)
	_ = svc.Handle(context.Background(), r)
	h := svc.Handler("tok", identityKey)
	do := func(method, path, body, token, assertionHdr string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if assertionHdr != "" {
			req.Header.Set(assertion.Header, assertionHdr)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	approve := "/v1/requests/" + r.GetName() + "/approve"
	if rec := do("GET", "/v1/requests", "", "", ""); rec.Code != 401 {
		t.Fatalf("no auth -> %d", rec.Code)
	}
	rec := do("GET", "/v1/requests?state=pending", "", "tok", "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"decision"`) {
		t.Fatalf("list -> %d %s", rec.Code, rec.Body.String())
	}
	// no assertion -> 401 even with the bearer token
	if rec := do("POST", approve, `{"reason":"x"}`, "tok", ""); rec.Code != 401 {
		t.Fatalf("approve without assertion -> %d %s", rec.Code, rec.Body.String())
	}
	// wrong audience -> 401
	now := time.Now().Unix()
	mcpAud, _ := assertion.Sign(identityKey, assertion.Payload{Sub: "bob", Aud: assertion.AudienceMCP, Iat: now, Exp: now + 30, JTI: uuid.NewString()})
	if rec := do("POST", approve, `{"reason":"x"}`, "tok", mcpAud); rec.Code != 401 {
		t.Fatalf("approve with mcp-audience assertion -> %d", rec.Code)
	}
	// body-supplied approver -> 400 (unknown field)
	if rec := do("POST", approve, `{"approver":{"teleport_user":"bob","adapter":"cli"},"reason":"ok"}`, "tok", assertionFor(t, "bob", "bob@example.com")); rec.Code != 400 {
		t.Fatalf("body approver -> %d %s", rec.Code, rec.Body.String())
	}
	// self approval via assertion
	rec = do("POST", approve, `{"reason":"x"}`, "tok", assertionFor(t, "alice", "alice@example.com"))
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), "self_approval") {
		t.Fatalf("self approval -> %d %s", rec.Code, rec.Body.String())
	}
	// case-variant self approval via assertion
	rec = do("POST", approve, `{"reason":"x"}`, "tok", assertionFor(t, "Alice", ""))
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), "self_approval") {
		t.Fatalf("case-variant self approval -> %d %s", rec.Code, rec.Body.String())
	}
	// email-only path with an email that is not the user's trait -> 403
	rec = do("POST", approve, `{"reason":"x"}`, "tok", assertionFor(t, "carol", "oncall@example.com"))
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), "not_approver") {
		t.Fatalf("email trait mismatch -> %d %s", rec.Code, rec.Body.String())
	}
	// replayed assertion -> 401
	a := assertionFor(t, "bob", "bob@example.com")
	rec = do("POST", approve, `{"reason":"ok"}`, "tok", a)
	if rec.Code != 200 {
		t.Fatalf("approve -> %d %s", rec.Code, rec.Body.String())
	}
	if rec := do("POST", "/v1/requests/"+r.GetName()+"/deny", `{"reason":"late"}`, "tok", a); rec.Code != 401 {
		t.Fatalf("replayed assertion -> %d %s", rec.Code, rec.Body.String())
	}
	rec = do("POST", "/v1/requests/"+r.GetName()+"/deny", `{"reason":"late"}`, "tok", assertionFor(t, "bob", "bob@example.com"))
	if rec.Code != 409 {
		t.Fatalf("second decision -> %d", rec.Code)
	}
	if rec := do("GET", "/v1/users/by-email?email=Bob@Example.com", "", "tok", ""); !strings.Contains(rec.Body.String(), `"bob"`) {
		t.Fatalf("by-email -> %s", rec.Body.String())
	}
	rec = do("GET", "/v1/users/bob/roles", "", "tok", "")
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "traits") || strings.Contains(rec.Body.String(), "bob@example.com") {
		t.Fatalf("roles must not leak traits -> %d %s", rec.Code, rec.Body.String())
	}
	if rec := do("GET", "/v1/policy", "", "tok", ""); rec.Code != 404 {
		t.Fatalf("/v1/policy should be gone -> %d", rec.Code)
	}
	if rec := do("POST", "/v1/policy/evaluate", `{"requester":"alice","roles":["dev-ssh"],"junk":1}`, "tok", ""); rec.Code != 400 {
		t.Fatalf("unknown field -> %d", rec.Code)
	}
	if rec := do("POST", "/v1/policy/evaluate", `{"requester":"alice","roles":["`+strings.Repeat("x", 70000)+`"]}`, "tok", ""); rec.Code != 400 {
		t.Fatalf("oversized body -> %d", rec.Code)
	}
	if rec := do("GET", "/healthz", "", "", ""); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"status":"ok"}` {
		t.Fatalf("healthz -> %d %s", rec.Code, rec.Body.String())
	}
	if rec := do("GET", "/readyz", "", "", ""); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"status":"ok"}` {
		t.Fatalf("readyz -> %d %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerWithoutIdentityKeyFailsClosed(t *testing.T) {
	svc, f := newSvc(t, "")
	r := request(t, f, "alice", []string{"prod-ssh"}, time.Hour)
	_ = svc.Handle(context.Background(), r)
	h := svc.Handler("tok", nil)
	req := httptest.NewRequest("POST", "/v1/requests/"+r.GetName()+"/approve", strings.NewReader(`{"reason":"x"}`))
	req.Header.Set("Authorization", "Bearer tok")
	req.Header.Set(assertion.Header, assertionFor(t, "bob", ""))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("no key -> %d", rec.Code)
	}
}

func TestStoreAtomicPersistAndCorruptFile(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "sub", "state.json")
	st, err := NewStore(file)
	if err != nil {
		t.Fatal(err)
	}
	st.Put(&Record{ID: "a", User: "alice", SeenAt: time.Now().Add(-48 * time.Hour)})
	st.Put(&Record{ID: "b", User: "bob", SeenAt: time.Now(), ResolvedAt: time.Now().Add(-8 * 24 * time.Hour)})
	entries, _ := os.ReadDir(filepath.Dir(file))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
	st2, err := NewStore(file)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := st2.Get("a"); !ok {
		t.Fatal("record not persisted")
	}
	st2.Prune(7*24*time.Hour, 24*time.Hour)
	if _, ok := st2.Get("b"); ok {
		t.Fatal("old resolved record should be pruned")
	}
	if rec, _ := st2.Get("a"); rec.ResolvedAt.IsZero() || rec.Resolution == nil || rec.Resolution.State != "expired" {
		t.Fatalf("stale pending record should be expired: %+v", rec)
	}
	if err := os.WriteFile(file, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewStore(file); err == nil {
		t.Fatal("corrupt state file must refuse to load")
	}
}

func TestSignature(t *testing.T) {
	sig := Sign("s", "123", []byte(`{"a":1}`))
	if !strings.HasPrefix(sig, "sha256=") || len(sig) != 71 {
		t.Fatalf("sig = %s", sig)
	}
}
