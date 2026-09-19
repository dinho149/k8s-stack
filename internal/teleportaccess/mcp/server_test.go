package mcpserver

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gravitational/teleport/api/client/proto"
	"github.com/gravitational/teleport/api/types"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/yeaboi/k8s-stack/internal/teleportaccess/accessapi"
	"github.com/yeaboi/k8s-stack/internal/teleportaccess/assertion"
	"github.com/yeaboi/k8s-stack/internal/teleportaccess/policy"
	"github.com/yeaboi/k8s-stack/internal/teleportaccess/teleport/fake"
)

var identityKey = []byte("mcp-test-identity-signing-key-0123456789")

const sharedToken = "shared-token-0123456789-0123456789-abc"

func node(t *testing.T, name string, labels map[string]string) *proto.PaginatedResource {
	t.Helper()
	n, err := types.NewServerWithLabels(name, types.KindNode, types.ServerSpecV2{Hostname: name, Addr: "10.0.0.1:3022"}, labels)
	if err != nil {
		t.Fatal(err)
	}
	return &proto.PaginatedResource{Resource: &proto.PaginatedResource_Node{Node: n.(*types.ServerV2)}}
}

func newServer(t *testing.T, stdio Principal) (*Server, *fake.API) {
	t.Helper()
	f := fake.New()
	req, _ := types.NewRole("requester", types.RoleSpecV6{Allow: types.RoleConditions{Request: &types.AccessRequestConditions{Roles: []string{"dev-ssh", "prod-ssh"}}}})
	dev, _ := types.NewRole("dev-ssh", types.RoleSpecV6{Allow: types.RoleConditions{Logins: []string{"dev"}, NodeLabels: types.Labels{"env": {"dev"}}}})
	prod, _ := types.NewRole("prod-ssh", types.RoleSpecV6{Allow: types.RoleConditions{Logins: []string{"dev"}, NodeLabels: types.Labels{"env": {"prod"}}}})
	bot, _ := types.NewRole("bot-access-broker", types.RoleSpecV6{Allow: types.RoleConditions{NodeLabels: types.Labels{"*": {"*"}}}})
	editor, _ := types.NewRole("editor", types.RoleSpecV6{})
	f.Roles["requester"], f.Roles["dev-ssh"], f.Roles["prod-ssh"], f.Roles["bot-access-broker"], f.Roles["editor"] = req, dev, prod, bot, editor
	alice, _ := types.NewUser("alice")
	alice.SetRoles([]string{"requester"})
	f.Users["alice"] = alice
	bob, _ := types.NewUser("bob")
	bob.SetRoles([]string{"requester", "approver"})
	f.Users["bob"] = bob
	f.Requestable["alice"] = []string{"dev-ssh", "prod-ssh"}
	f.Requestable["bob"] = []string{"dev-ssh", "prod-ssh"}
	f.Resources = &proto.ListUnifiedResourcesResponse{Resources: []*proto.PaginatedResource{
		node(t, "ssh-dev-0", map[string]string{"env": "dev"}), node(t, "ssh-prod-0", map[string]string{"env": "prod"}), node(t, "ssh-lab-0", map[string]string{"env": "lab"}),
	}}
	p, err := policy.Parse([]byte("kind: ApprovalPolicy\ndefaults: {action: require_approval, max_ttl: 8h}\nrules:\n  - {name: never, match: {roles: ['editor']}, action: deny}\n  - {name: auto, match: {roles: ['dev-*']}, action: auto_approve, ttl_cap: 1h}\n"))
	if err != nil {
		t.Fatal(err)
	}
	return New(Deps{API: f, Policy: policy.NewEngine(p), Stdio: stdio, Edition: "community", ClusterName: "test", Version: "18"}), f
}

func setup(t *testing.T, stdio Principal) (*mcp.ClientSession, *fake.API) {
	t.Helper()
	srv, f := newServer(t, stdio)
	ct, st := mcp.NewInMemoryTransports()
	go func() { _ = srv.MCP().Run(context.Background(), st) }()
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).Connect(context.Background(), ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs, f
}

func call(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) (*mcp.CallToolResult, map[string]any) {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	var out map[string]any
	if len(res.Content) > 0 {
		if tc, ok := res.Content[0].(*mcp.TextContent); ok {
			_ = json.Unmarshal([]byte(tc.Text), &out)
		}
	}
	return res, out
}

func errText(res *mcp.CallToolResult) string {
	if len(res.Content) == 0 {
		return ""
	}
	if tc, ok := res.Content[0].(*mcp.TextContent); ok {
		return tc.Text
	}
	return ""
}

func TestNoIdentityParametersAndNoApprovalTools(t *testing.T) {
	cs, _ := setup(t, Principal{TeleportUser: "alice", Source: "stdio"})
	tools, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools.Tools {
		if strings.HasPrefix(tool.Name, "approve") || strings.HasPrefix(tool.Name, "deny") || strings.HasSuffix(tool.Name, "_request_state") {
			t.Fatalf("approval tool exposed: %s", tool.Name)
		}
		b, _ := json.Marshal(tool.InputSchema)
		for _, forbidden := range []string{"teleport_user", "username", "principal", "email", "assertion"} {
			if strings.Contains(string(b), `"`+forbidden+`"`) {
				t.Fatalf("tool %s exposes identity parameter %s", tool.Name, forbidden)
			}
		}
	}
	if len(tools.Tools) < 12 {
		t.Fatalf("expected the full catalogue, got %d tools", len(tools.Tools))
	}
}

func TestWhoamiAndRequestFlow(t *testing.T) {
	cs, f := setup(t, Principal{TeleportUser: "alice", Source: "stdio"})
	_, out := call(t, cs, "whoami", nil)
	if out["user"] != "alice" {
		t.Fatalf("whoami = %v", out)
	}
	_, out = call(t, cs, "list_requestable_roles", nil)
	rr := out["requestable_roles"].([]any)
	if len(rr) != 2 || rr[0].(map[string]any)["prediction"] != "auto_approve" {
		t.Fatalf("requestable = %v", rr)
	}
	res, _ := call(t, cs, "create_access_request", map[string]any{"roles": []string{"dev-ssh"}, "ttl": "1h"})
	if !res.IsError {
		t.Fatal("missing reason must be an error")
	}
	res, _ = call(t, cs, "create_access_request", map[string]any{"roles": []string{"dev-ssh"}, "ttl": "1h", "reason": "short"})
	if !res.IsError {
		t.Fatal("too-short reason must be an error")
	}
	res, _ = call(t, cs, "create_access_request", map[string]any{"roles": []string{"k8s-admin"}, "ttl": "1h", "reason": "testing access"})
	if !res.IsError || !strings.Contains(errText(res), "not requestable") {
		t.Fatalf("unknown role must be rejected: %+v", res)
	}
	res, _ = call(t, cs, "create_access_request", map[string]any{"roles": []string{"editor"}, "ttl": "1h", "reason": "testing access"})
	if !res.IsError || !strings.Contains(errText(res), "not requestable") {
		t.Fatalf("non-requestable preset role must be rejected: %+v", res)
	}
	_, out = call(t, cs, "create_access_request", map[string]any{"roles": []string{"dev-ssh"}, "ttl": "9h", "reason": "testing\x00 access\n with control chars"})
	if out["created"] != true || out["ttl_clamped_from"] != "9h0m0s" || out["ttl"] != "1h0m0s" {
		t.Fatalf("create = %v", out)
	}
	reqs, _ := f.GetAccessRequests(context.Background(), types.AccessRequestFilter{User: "alice"})
	if len(reqs) != 1 || reqs[0].GetRequestReason() != "testing access  with control chars" {
		t.Fatalf("request not created for alice or reason not cleaned: %v", reqs)
	}
	if ttl := time.Until(reqs[0].GetAccessExpiry()); ttl > time.Hour+time.Minute {
		t.Fatalf("ttl not clamped: %v", ttl)
	}
	_, out = call(t, cs, "list_my_access_requests", nil)
	if len(out["requests"].([]any)) != 1 {
		t.Fatalf("list mine = %v", out)
	}
	res, _ = call(t, cs, "list_pending_requests", nil)
	if !res.IsError {
		t.Fatal("non-approver must not list pending requests")
	}
	// hidden roles are not describable
	res, _ = call(t, cs, "describe_role", map[string]any{"name": "bot-access-broker"})
	if !res.IsError || !strings.Contains(errText(res), "not found") {
		t.Fatalf("hidden role must be not found: %+v", res)
	}
	// search is scoped to roles alice holds or may request (dev + prod, not lab)
	_, out = call(t, cs, "search_resources", map[string]any{"query": "ssh"})
	names := []string{}
	for _, r := range out["resources"].([]any) {
		names = append(names, r.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "ssh-dev-0,ssh-prod-0" {
		t.Fatalf("search scope = %v", names)
	}
}

func TestPolicyDenyRefusesCreation(t *testing.T) {
	cs, f := setup(t, Principal{TeleportUser: "alice", Source: "stdio"})
	f.Requestable["alice"] = []string{"dev-ssh", "editor"}
	res, _ := call(t, cs, "create_access_request", map[string]any{"roles": []string{"editor"}, "reason": "testing access"})
	if !res.IsError || !strings.Contains(errText(res), "policy denies") {
		t.Fatalf("deny must refuse creation: %+v", res)
	}
	reqs, _ := f.GetAccessRequests(context.Background(), types.AccessRequestFilter{User: "alice"})
	if len(reqs) != 0 {
		t.Fatal("denied request must not be created")
	}
}

func TestCreateRateLimit(t *testing.T) {
	cs, _ := setup(t, Principal{TeleportUser: "alice", Source: "stdio"})
	var limited bool
	for i := 0; i < accessapi.CreateBurst+1; i++ {
		res, _ := call(t, cs, "create_access_request", map[string]any{"roles": []string{"dev-ssh"}, "reason": "testing access", "dry_run": true})
		if res.IsError && strings.Contains(errText(res), "rate limited") {
			limited = i == accessapi.CreateBurst
			break
		}
	}
	if !limited {
		t.Fatal("expected the 6th create in a minute to be rate limited")
	}
}

func TestApproverSearchIsUnscoped(t *testing.T) {
	cs, _ := setup(t, Principal{TeleportUser: "bob", Source: "stdio"})
	_, out := call(t, cs, "search_resources", map[string]any{"query": "ssh"})
	if len(out["resources"].([]any)) != 3 {
		t.Fatalf("approver should see everything: %v", out)
	}
}

func TestNoPrincipalIsAnError(t *testing.T) {
	cs, _ := setup(t, Principal{})
	res, _ := call(t, cs, "whoami", nil)
	if !res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "identity") {
		t.Fatalf("expected identity error, got %+v", res)
	}
	// tools that need no principal still work
	res, _ = call(t, cs, "get_cluster_info", nil)
	if res.IsError {
		t.Fatal("cluster info should not need a principal")
	}
}

func TestGenericErrorsDoNotLeakDetails(t *testing.T) {
	if got := userFacing(io.ErrUnexpectedEOF); got != "teleport error" {
		t.Fatalf("generic error leaked: %q", got)
	}
}

// ---- HTTP transport: bearer + assertion + session binding

func mint(t *testing.T, key []byte, sub, aud string, iat, exp int64) string {
	t.Helper()
	h, err := assertion.Sign(key, assertion.Payload{Sub: sub, Email: sub + "@example.com", Platform: "slack", PlatformUserID: "U-" + sub, Aud: aud, Iat: iat, Exp: exp, JTI: uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func freshAssertion(t *testing.T, sub string) string {
	now := time.Now().Unix()
	return mint(t, identityKey, sub, assertion.AudienceMCP, now, now+30)
}

const initializeBody = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`

func httpServer(t *testing.T) (*httptest.Server, *fake.API) {
	t.Helper()
	srv, f := newServer(t, Principal{TeleportUser: "stdio-operator", Source: "stdio"})
	ts := httptest.NewServer(srv.HTTPHandler(sharedToken, identityKey))
	t.Cleanup(ts.Close)
	return ts, f
}

func post(t *testing.T, url string, headers map[string]string, body string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestHTTPAuthRejections(t *testing.T) {
	ts, _ := httpServer(t)
	now := time.Now().Unix()
	bearer := "Bearer " + sharedToken
	cases := map[string]map[string]string{
		"no token":                         {assertion.Header: freshAssertion(t, "alice")},
		"wrong token":                      {"Authorization": "Bearer nope", assertion.Header: freshAssertion(t, "alice")},
		"bearer but no assertion":          {"Authorization": bearer},
		"spoofed X-Teleport-User header":   {"Authorization": bearer, "X-Teleport-User": "alice", "X-Teleport-User-Email": "alice@example.com"},
		"spoofed internal verified header": {"Authorization": bearer, verifiedUserHeader: "alice"},
		"bad signature":                    {"Authorization": bearer, assertion.Header: mint(t, []byte("wrong-key-wrong-key-wrong-key-wrong-key"), "alice", assertion.AudienceMCP, now, now+30)},
		"expired":                          {"Authorization": bearer, assertion.Header: mint(t, identityKey, "alice", assertion.AudienceMCP, now-120, now-60)},
		"wrong audience":                   {"Authorization": bearer, assertion.Header: mint(t, identityKey, "alice", assertion.AudienceBroker, now, now+30)},
		"lifetime too long":                {"Authorization": bearer, assertion.Header: mint(t, identityKey, "alice", assertion.AudienceMCP, now, now+120)},
	}
	for name, hdrs := range cases {
		t.Run(name, func(t *testing.T) {
			resp := post(t, ts.URL, hdrs, initializeBody)
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("want 401, got %d", resp.StatusCode)
			}
		})
	}
	// replay: the same assertion twice
	a := freshAssertion(t, "alice")
	if resp := post(t, ts.URL, map[string]string{"Authorization": bearer, assertion.Header: a}, initializeBody); resp.StatusCode != 200 {
		t.Fatalf("first use -> %d", resp.StatusCode)
	}
	if resp := post(t, ts.URL, map[string]string{"Authorization": bearer, assertion.Header: a}, initializeBody); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replayed assertion -> %d, want 401", resp.StatusCode)
	}
	// browser cross-origin request is refused even with valid credentials
	if resp := post(t, ts.URL, map[string]string{"Authorization": bearer, assertion.Header: freshAssertion(t, "alice"), "Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"}, initializeBody); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin -> %d, want 403", resp.StatusCode)
	}
}

// signingTransport adds the bearer token and a fresh assertion for sub to every request.
type signingTransport struct {
	t   *testing.T
	sub string
}

func (s *signingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r.Header.Set("Authorization", "Bearer "+sharedToken)
	r.Header.Set(assertion.Header, freshAssertion(s.t, s.sub))
	r.Header.Set("X-Teleport-User", "bob") // must be ignored
	return http.DefaultTransport.RoundTrip(r)
}

func TestHTTPPrincipalComesFromAssertionAndIsBoundToSession(t *testing.T) {
	ts, _ := httpServer(t)
	st := &signingTransport{t: t, sub: "alice"}
	transport := &mcp.StreamableClientTransport{Endpoint: ts.URL, HTTPClient: &http.Client{Transport: st}}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).Connect(context.Background(), transport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	_, out := call(t, cs, "whoami", nil)
	if out["user"] != "alice" || out["email"] != "alice@example.com" {
		t.Fatalf("principal must come from the assertion, got %v", out)
	}
	// A different subject on the same session is refused with 403.
	st.sub = "bob"
	if _, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "whoami"}); err == nil || !strings.Contains(err.Error(), "Forbidden") {
		t.Fatalf("sub change mid-session must fail with 403, got %v", err)
	}
}

func TestHTTPSessionBindingRaw(t *testing.T) {
	ts, _ := httpServer(t)
	bearer := "Bearer " + sharedToken
	resp := post(t, ts.URL, map[string]string{"Authorization": bearer, assertion.Header: freshAssertion(t, "alice")}, initializeBody)
	if resp.StatusCode != 200 {
		t.Fatalf("initialize -> %d", resp.StatusCode)
	}
	sid := resp.Header.Get("Mcp-Session-Id")
	if sid == "" {
		t.Fatal("no session id issued")
	}
	const list = `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`
	if resp := post(t, ts.URL, map[string]string{"Authorization": bearer, assertion.Header: freshAssertion(t, "bob"), "Mcp-Session-Id": sid}, list); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("other subject on bound session -> %d, want 403", resp.StatusCode)
	}
	if resp := post(t, ts.URL, map[string]string{"Authorization": bearer, assertion.Header: freshAssertion(t, "alice"), "Mcp-Session-Id": sid}, list); resp.StatusCode != 200 {
		t.Fatalf("bound subject -> %d, want 200", resp.StatusCode)
	}
}

func TestSessionBinder(t *testing.T) {
	b := newSessionBinder(time.Minute)
	now := time.Unix(1_700_000_000, 0)
	b.now = func() time.Time { return now }
	if err := b.bind("s1", "alice"); err != nil {
		t.Fatal(err)
	}
	if err := b.bind("s1", "bob"); err == nil {
		t.Fatal("different subject must be rejected")
	}
	now = now.Add(2 * time.Minute)
	if err := b.bind("s1", "bob"); err != nil {
		t.Fatalf("expired binding may be re-bound: %v", err)
	}
}
