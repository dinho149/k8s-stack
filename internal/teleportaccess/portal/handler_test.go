package portal

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gravitational/teleport/api/client/proto"
	"github.com/gravitational/teleport/api/types"

	"github.com/yeaboi/k8s-stack/internal/teleportaccess/accessapi"
	"github.com/yeaboi/k8s-stack/internal/teleportaccess/assertion"
	"github.com/yeaboi/k8s-stack/internal/teleportaccess/policy"
	"github.com/yeaboi/k8s-stack/internal/teleportaccess/teleport/fake"
)

const (
	serviceToken = "portal-service-token-0123456789-0123456789"
	brokerToken  = "broker-api-token-0123456789-0123456789-ab"
)

var signingKey = []byte("portal-test-identity-signing-key-0123456789")

func node(t *testing.T, name string, labels map[string]string) *proto.PaginatedResource {
	t.Helper()
	n, err := types.NewServerWithLabels(name, types.KindNode, types.ServerSpecV2{Hostname: name, Addr: "10.0.0.1:3022"}, labels)
	if err != nil {
		t.Fatal(err)
	}
	return &proto.PaginatedResource{Resource: &proto.PaginatedResource_Node{Node: n.(*types.ServerV2)}}
}

// brokerStub verifies what the portal sends: the bearer, a valid broker-audience assertion signed
// with the shared key and platform "portal", and a body carrying only the reason. It answers with
// whatever status/code the test sets.
type brokerStub struct {
	*httptest.Server
	status   atomic.Int32
	code     string
	lastSub  string
	lastPlat string
	lastPID  string
	lastBody string
	calls    atomic.Int32
}

func newBrokerStub(t *testing.T) *brokerStub {
	t.Helper()
	s := &brokerStub{}
	s.status.Store(200)
	verifier := assertion.NewVerifier(signingKey, assertion.AudienceBroker)
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+brokerToken {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"missing or invalid bearer token","code":"unauthorized"}`))
			return
		}
		claims, err := verifier.Verify(r.Header.Get(assertion.Header))
		if err != nil {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"bad assertion","code":"unauthorized"}`))
			return
		}
		s.lastSub, s.lastPlat, s.lastPID = claims.Sub, claims.Platform, claims.PlatformUserID
		b, _ := io.ReadAll(r.Body)
		s.lastBody = string(b)
		st := int(s.status.Load())
		w.WriteHeader(st)
		if st != 200 {
			_, _ = w.Write([]byte(`{"error":"refused","code":"` + s.code + `"}`))
		} else {
			_, _ = w.Write([]byte(`{"id":"x"}`))
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func newPortal(t *testing.T, fallback string) (*httptest.Server, *fake.API, *brokerStub) {
	t.Helper()
	f := fake.New()
	req, _ := types.NewRole("requester", types.RoleSpecV6{Allow: types.RoleConditions{Request: &types.AccessRequestConditions{Roles: []string{"dev-ssh", "prod-ssh"}}}})
	dev, _ := types.NewRole("dev-ssh", types.RoleSpecV6{Allow: types.RoleConditions{Logins: []string{"dev"}, NodeLabels: types.Labels{"env": {"dev"}}}})
	prod, _ := types.NewRole("prod-ssh", types.RoleSpecV6{Allow: types.RoleConditions{Logins: []string{"dev"}, NodeLabels: types.Labels{"env": {"prod"}}}})
	f.Roles["requester"], f.Roles["dev-ssh"], f.Roles["prod-ssh"] = req, dev, prod
	for name, roles := range map[string][]string{"alice": {"requester"}, "bob": {"requester", "approver"}, "bot-x": {"requester"}} {
		u, _ := types.NewUser(name)
		u.SetRoles(roles)
		u.SetTraits(map[string][]string{"email": {name + "@example.com"}})
		f.Users[name] = u
		f.Requestable[name] = []string{"dev-ssh", "prod-ssh"}
	}
	f.Resources = &proto.ListUnifiedResourcesResponse{Resources: []*proto.PaginatedResource{node(t, "ssh-dev-0", map[string]string{"env": "dev"}), node(t, "ssh-prod-0", map[string]string{"env": "prod"})}}
	p, err := policy.Parse([]byte("kind: ApprovalPolicy\ndefaults: {action: require_approval, max_ttl: 8h}\nrules:\n  - {name: auto, match: {roles: ['dev-*']}, action: auto_approve, ttl_cap: 1h}\n"))
	if err != nil {
		t.Fatal(err)
	}
	svc := accessapi.New(accessapi.Deps{API: f, Policy: policy.NewEngine(p), Edition: "community", ClusterName: "test", Version: "18"})
	stub := newBrokerStub(t)
	h := Handler(Config{
		ServiceToken: serviceToken, API: f,
		Mapper: NewMapper(map[string]string{"local-developer": "alice", "ghost": "nobody", "robot": "bot-x"}, fallback),
		Broker: NewBrokerClient(stub.URL, brokerToken, signingKey),
		Ready:  func(context.Context) error { return nil },
	}, svc)
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	return ts, f, stub
}

type resp struct {
	status int
	body   map[string]any
	raw    string
}

func do(t *testing.T, ts *httptest.Server, method, path, subject, body string, extra map[string]string) resp {
	t.Helper()
	req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+serviceToken)
	if subject != "" {
		req.Header.Set(SubjectHeader, subject)
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return resp{status: r.StatusCode, body: m, raw: string(b)}
}

func TestAuthFailsClosed(t *testing.T) {
	ts, f, stub := newPortal(t, FallbackUsername)
	cases := []struct {
		name    string
		headers map[string]string
		subject string
		status  int
		code    string
	}{
		{"no bearer", map[string]string{"Authorization": ""}, "alice", 401, "unauthorized"},
		{"wrong bearer", map[string]string{"Authorization": "Bearer nope"}, "alice", 401, "unauthorized"},
		{"no subject", nil, "", 403, "unmapped_subject"},
		{"subject with whitespace", nil, "ali ce", 403, "unmapped_subject"},
		{"unmapped subject (bad charset)", nil, "some one@corp", 403, "unmapped_subject"},
		{"mapped to unknown teleport user", nil, "ghost", 403, "unknown_user"},
		{"mapped to a bot", nil, "robot", 403, "unknown_user"},
		{"username fallback to unknown user", nil, "erin", 403, "unknown_user"},
		{"spoofed verified header is ignored", map[string]string{"X-Ta-Verified-User": "bob", "X-Teleport-User": "bob"}, "nobody-here", 403, "unknown_user"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := do(t, ts, "GET", "/v1/me", tc.subject, "", tc.headers)
			if r.status != tc.status || r.body["code"] != tc.code {
				t.Fatalf("want %d %s, got %d %s", tc.status, tc.code, r.status, r.raw)
			}
		})
	}
	if reqs, _ := f.GetAccessRequests(context.Background(), types.AccessRequestFilter{}); len(reqs) != 0 || stub.calls.Load() != 0 {
		t.Fatal("rejected callers must never reach Teleport writes or the broker")
	}
	// health needs no auth
	if r := do(t, ts, "GET", "/healthz", "", "", map[string]string{"Authorization": ""}); r.status != 200 {
		t.Fatalf("healthz = %d", r.status)
	}
	// cross-origin browser requests are refused even with valid credentials
	if r := do(t, ts, "POST", "/v1/requests/preview", "alice", `{"roles":["dev-ssh"],"reason":"testing access"}`, map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"}); r.status != 403 {
		t.Fatalf("cross-origin = %d", r.status)
	}
}

func TestIdentityMapping(t *testing.T) {
	ts, _, _ := newPortal(t, FallbackNone)
	// explicit map wins
	if r := do(t, ts, "GET", "/v1/me", "local-developer", "", nil); r.status != 200 || r.body["user"] != "alice" || r.body["email"] != "alice@example.com" {
		t.Fatalf("map hit = %d %s", r.status, r.raw)
	}
	// no fallback: a username-shaped subject is still unmapped
	if r := do(t, ts, "GET", "/v1/me", "bob", "", nil); r.status != 403 || r.body["code"] != "unmapped_subject" {
		t.Fatalf("fallback none = %d %s", r.status, r.raw)
	}
	ts2, _, _ := newPortal(t, FallbackUsername)
	if r := do(t, ts2, "GET", "/v1/me", "bob", "", nil); r.status != 200 || r.body["user"] != "bob" || r.body["is_approver"] != true {
		t.Fatalf("fallback username = %d %s", r.status, r.raw)
	}
}

func TestMapperLoad(t *testing.T) {
	m := NewMapper(map[string]string{" a ": " alice "}, FallbackNone)
	if u, ok := m.Resolve("a"); !ok || u != "alice" {
		t.Fatalf("trimmed mapping: %q %v", u, ok)
	}
	if _, ok := m.Resolve(""); ok {
		t.Fatal("empty subject must not resolve")
	}
	dir := t.TempDir()
	file := dir + "/identities.json"
	if err := writeFile(file, `{"local-developer": "alice"}`); err != nil {
		t.Fatal(err)
	}
	m, err := LoadMapper(file, FallbackUsername)
	if err != nil {
		t.Fatal(err)
	}
	if u, _ := m.Resolve("local-developer"); u != "alice" {
		t.Fatal("file mapping not loaded")
	}
	if u, _ := m.Resolve("octocat"); u != "octocat" {
		t.Fatal("username fallback")
	}
	_ = writeFile(file, `{"x": "not a user name"}`)
	if _, err := LoadMapper(file, FallbackNone); err == nil {
		t.Fatal("invalid target user must be rejected at load")
	}
}

func TestRequestFlowAndScoping(t *testing.T) {
	ts, f, _ := newPortal(t, FallbackUsername)
	// preview never creates
	r := do(t, ts, "POST", "/v1/requests/preview", "alice", `{"roles":["dev-ssh"],"reason":"testing access","ttl":"9h"}`, nil)
	if r.status != 200 || r.body["dry_run"] != true || r.body["ttl"] != "1h0m0s" {
		t.Fatalf("preview = %d %s", r.status, r.raw)
	}
	if reqs, _ := f.GetAccessRequests(context.Background(), types.AccessRequestFilter{}); len(reqs) != 0 {
		t.Fatal("preview must not create")
	}
	// guards surface as 400 with the shared messages; unknown fields are rejected
	if r := do(t, ts, "POST", "/v1/requests", "alice", `{"roles":["dev-ssh"],"reason":"short"}`, nil); r.status != 400 || r.body["code"] != "bad_request" {
		t.Fatalf("short reason = %d %s", r.status, r.raw)
	}
	if r := do(t, ts, "POST", "/v1/requests", "alice", `{"roles":["dev-ssh"],"reason":"testing access","user":"bob"}`, nil); r.status != 400 || r.body["code"] != "bad_json" {
		t.Fatalf("identity field in body must be rejected: %d %s", r.status, r.raw)
	}
	// create with an idempotency key: the second call replays, no second request
	body := `{"roles":["prod-ssh"],"reason":"incident 123"}`
	r1 := do(t, ts, "POST", "/v1/requests", "alice", body, map[string]string{"Idempotency-Key": "k1"})
	r2 := do(t, ts, "POST", "/v1/requests", "alice", body, map[string]string{"Idempotency-Key": "k1"})
	if r1.status != 201 || r2.status != 201 || r1.raw != r2.raw {
		t.Fatalf("idempotent create: %d %d\n%s\n%s", r1.status, r2.status, r1.raw, r2.raw)
	}
	reqs, _ := f.GetAccessRequests(context.Background(), types.AccessRequestFilter{})
	if len(reqs) != 1 || reqs[0].GetUser() != "alice" {
		t.Fatalf("exactly one request for alice, got %v", reqs)
	}
	id := reqs[0].GetName()
	// scoping: alice lists hers, bob (approver) sees the queue, alice cannot see the queue
	if r := do(t, ts, "GET", "/v1/requests?state=pending", "alice", "", nil); r.status != 200 || len(r.body["requests"].([]any)) != 1 {
		t.Fatalf("list mine = %d %s", r.status, r.raw)
	}
	if r := do(t, ts, "GET", "/v1/requests?state=bogus", "alice", "", nil); r.status != 400 {
		t.Fatalf("bad state = %d", r.status)
	}
	if r := do(t, ts, "GET", "/v1/approvals", "alice", "", nil); r.status != 403 || r.body["code"] != "teleport_denied" {
		t.Fatalf("non-approver queue = %d %s", r.status, r.raw)
	}
	if r := do(t, ts, "GET", "/v1/approvals", "bob", "", nil); r.status != 200 || len(r.body["requests"].([]any)) != 1 {
		t.Fatalf("approver queue = %d %s", r.status, r.raw)
	}
	// bob's own pending request is not in bob's queue
	do(t, ts, "POST", "/v1/requests", "bob", `{"roles":["prod-ssh"],"reason":"bob needs prod"}`, nil)
	if r := do(t, ts, "GET", "/v1/approvals", "bob", "", nil); len(r.body["requests"].([]any)) != 1 {
		t.Fatalf("own request must be excluded from the queue: %s", r.raw)
	}
	if r := do(t, ts, "GET", "/v1/requests/"+id, "alice", "", nil); r.status != 200 || r.body["id"] != id {
		t.Fatalf("get own = %d %s", r.status, r.raw)
	}
	// resources are scoped for requesters
	if r := do(t, ts, "GET", "/v1/resources?q=ssh&kind=node", "alice", "", nil); r.status != 200 || r.body["scoped"] != true {
		t.Fatalf("search = %d %s", r.status, r.raw)
	}
	if r := do(t, ts, "GET", "/v1/roles/dev-ssh", "alice", "", nil); r.status != 200 || r.body["requestable"] != true {
		t.Fatalf("role detail = %d %s", r.status, r.raw)
	}
	if r := do(t, ts, "GET", "/v1/roles/bot-x", "alice", "", nil); r.status != 404 {
		t.Fatalf("hidden role = %d", r.status)
	}
	if r := do(t, ts, "GET", "/v1/cluster", "alice", "", nil); r.status != 200 || r.body["edition"] != "community" {
		t.Fatalf("cluster = %d %s", r.status, r.raw)
	}
}

func TestDecisionsGoThroughTheBroker(t *testing.T) {
	ts, f, stub := newPortal(t, FallbackUsername)
	r := do(t, ts, "POST", "/v1/requests", "alice", `{"roles":["prod-ssh"],"reason":"incident 123"}`, nil)
	id := r.body["request"].(map[string]any)["id"].(string)

	// requester is not an approver: refused before the broker is called
	if r := do(t, ts, "POST", "/v1/requests/"+id+"/approve", "alice", `{"reason":"me"}`, nil); r.status != 403 || r.body["code"] != "not_approver" || stub.calls.Load() != 0 {
		t.Fatalf("self approve = %d %s", r.status, r.raw)
	}
	// deny needs a reason
	if r := do(t, ts, "POST", "/v1/requests/"+id+"/deny", "bob", `{}`, nil); r.status != 400 || r.body["code"] != "bad_reason" {
		t.Fatalf("deny without reason = %d %s", r.status, r.raw)
	}
	// unknown request
	if r := do(t, ts, "POST", "/v1/requests/00000000-0000-0000-0000-000000000000/approve", "bob", `{"reason":"x"}`, nil); r.status != 404 {
		t.Fatalf("unknown request = %d", r.status)
	}
	// broker refusals pass through with their codes
	for _, tc := range []struct {
		status int
		code   string
	}{{403, "self_approval"}, {403, "not_approver"}, {409, "not_pending"}, {501, "native_mode"}} {
		stub.status.Store(int32(tc.status))
		stub.code = tc.code
		if r := do(t, ts, "POST", "/v1/requests/"+id+"/approve", "bob", `{"reason":"ok"}`, nil); r.status != tc.status || r.body["code"] != tc.code {
			t.Fatalf("broker %d %s -> %d %s", tc.status, tc.code, r.status, r.raw)
		}
	}
	// a broker 401 is OUR misconfiguration, reported as 502 broker_auth (never as the person's fault)
	stub.status.Store(401)
	if r := do(t, ts, "POST", "/v1/requests/"+id+"/approve", "bob", `{"reason":"ok"}`, nil); r.status != 502 || r.body["code"] != "broker_auth" {
		t.Fatalf("broker 401 -> %d %s", r.status, r.raw)
	}
	// success: the broker saw a portal-platform assertion for bob with the portal subject, and only the reason in the body
	stub.status.Store(200)
	_ = f.SetAccessRequestState(context.Background(), types.AccessRequestUpdate{RequestID: id, State: types.RequestState_APPROVED})
	r = do(t, ts, "POST", "/v1/requests/"+id+"/approve", "bob", `{"reason":"incident 123 confirmed"}`, nil)
	if r.status != 200 || r.body["state"] != "APPROVED" {
		t.Fatalf("approve = %d %s", r.status, r.raw)
	}
	if stub.lastSub != "bob" || stub.lastPlat != PlatformName || stub.lastPID != "bob" || stub.lastBody != `{"reason":"incident 123 confirmed"}` {
		t.Fatalf("broker saw sub=%q platform=%q pid=%q body=%q", stub.lastSub, stub.lastPlat, stub.lastPID, stub.lastBody)
	}
	// broker down
	stub.Close()
	if r := do(t, ts, "POST", "/v1/requests/"+id+"/deny", "bob", `{"reason":"no"}`, nil); r.status != 502 || r.body["code"] != "broker_unavailable" {
		t.Fatalf("broker down -> %d %s", r.status, r.raw)
	}
}

func TestIdempotencyExpiry(t *testing.T) {
	i := newIdempotency(time.Minute)
	now := time.Unix(1_700_000_000, 0)
	i.now = func() time.Time { return now }
	i.put("alice", "k", 201, "v")
	if _, ok := i.get("alice", "k"); !ok {
		t.Fatal("fresh entry must hit")
	}
	if _, ok := i.get("bob", "k"); ok {
		t.Fatal("keys are per subject")
	}
	now = now.Add(2 * time.Minute)
	if _, ok := i.get("alice", "k"); ok {
		t.Fatal("expired entry must miss")
	}
}

func writeFile(path, content string) error {
	return writeFileMode(path, content)
}
