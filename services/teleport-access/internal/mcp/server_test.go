package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/gravitational/teleport/api/types"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/dinho/k8s-teleport/services/teleport-access/internal/policy"
	"github.com/dinho/k8s-teleport/services/teleport-access/internal/teleport/fake"
)

func setup(t *testing.T, stdio Principal) (*mcp.ClientSession, *fake.API) {
	t.Helper()
	f := fake.New()
	req, _ := types.NewRole("requester", types.RoleSpecV6{Allow: types.RoleConditions{Request: &types.AccessRequestConditions{Roles: []string{"dev-ssh"}}}})
	dev, _ := types.NewRole("dev-ssh", types.RoleSpecV6{Allow: types.RoleConditions{Logins: []string{"dev"}, NodeLabels: types.Labels{"env": {"dev"}}}})
	f.Roles["requester"], f.Roles["dev-ssh"] = req, dev
	alice, _ := types.NewUser("alice")
	alice.SetRoles([]string{"requester"})
	f.Users["alice"] = alice
	f.Requestable["alice"] = []string{"dev-ssh"}
	p, _ := policy.Parse([]byte("kind: ApprovalPolicy\ndefaults: {action: require_approval, max_ttl: 8h}\nrules:\n  - {name: auto, match: {roles: ['dev-*']}, action: auto_approve, ttl_cap: 4h}\n"))
	srv := New(Deps{API: f, Policy: policy.NewEngine(p), Stdio: stdio, Edition: "community", ClusterName: "test", Version: "18"})
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
		for _, forbidden := range []string{"teleport_user", "username", "principal"} {
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
	if len(rr) != 1 || rr[0].(map[string]any)["prediction"] != "auto_approve" {
		t.Fatalf("requestable = %v", rr)
	}
	res, _ := call(t, cs, "create_access_request", map[string]any{"roles": []string{"dev-ssh"}, "ttl": "1h"})
	if !res.IsError {
		t.Fatal("missing reason must be an error")
	}
	_, out = call(t, cs, "create_access_request", map[string]any{"roles": []string{"dev-ssh"}, "ttl": "1h", "reason": "testing"})
	if out["created"] != true {
		t.Fatalf("create = %v", out)
	}
	reqs, _ := f.GetAccessRequests(context.Background(), types.AccessRequestFilter{User: "alice"})
	if len(reqs) != 1 || reqs[0].GetRequestReason() != "testing" {
		t.Fatalf("request not created for alice: %v", reqs)
	}
	_, out = call(t, cs, "list_my_access_requests", nil)
	if len(out["requests"].([]any)) != 1 {
		t.Fatalf("list mine = %v", out)
	}
	res, _ = call(t, cs, "list_pending_requests", nil)
	if !res.IsError {
		t.Fatal("non-approver must not list pending requests")
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

func TestBearerAuth(t *testing.T) {
	h := BearerAuth("tok", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
	req, _ := http.NewRequest("POST", "/mcp", nil)
	rec := &recorder{}
	h.ServeHTTP(rec, req)
	if rec.code != 401 {
		t.Fatalf("no token -> %d", rec.code)
	}
	req.Header.Set("Authorization", "Bearer tok")
	rec = &recorder{}
	h.ServeHTTP(rec, req)
	if rec.code != 400 {
		t.Fatalf("no user header -> %d", rec.code)
	}
	req.Header.Set(HeaderUser, "alice")
	rec = &recorder{}
	h.ServeHTTP(rec, req)
	if rec.code != 204 {
		t.Fatalf("ok -> %d", rec.code)
	}
}

type recorder struct {
	code int
	h    http.Header
}

func (r *recorder) Header() http.Header {
	if r.h == nil {
		r.h = http.Header{}
	}
	return r.h
}
func (r *recorder) Write(b []byte) (int, error) { return len(b), nil }
func (r *recorder) WriteHeader(c int)            { r.code = c }
