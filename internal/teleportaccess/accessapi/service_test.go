package accessapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gravitational/teleport/api/client/proto"
	"github.com/gravitational/teleport/api/types"
	"github.com/gravitational/trace"

	"github.com/yeaboi/k8s-stack/internal/teleportaccess/policy"
	"github.com/yeaboi/k8s-stack/internal/teleportaccess/teleport/fake"
)

func node(t *testing.T, name string, labels map[string]string) *proto.PaginatedResource {
	t.Helper()
	n, err := types.NewServerWithLabels(name, types.KindNode, types.ServerSpecV2{Hostname: name, Addr: "10.0.0.1:3022"}, labels)
	if err != nil {
		t.Fatal(err)
	}
	return &proto.PaginatedResource{Resource: &proto.PaginatedResource_Node{Node: n.(*types.ServerV2)}}
}

// Fixture: alice (requester), bob (requester + approver), roles dev-ssh (auto-approved, 1h cap),
// prod-ssh (needs approval), editor (denied by policy), a hidden bot role, and three nodes.
func newService(t *testing.T) (*Service, *fake.API) {
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
	alice.SetTraits(map[string][]string{"email": {"alice@example.com"}})
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
	return New(Deps{API: f, Policy: policy.NewEngine(p), Edition: "community", ClusterName: "test", Version: "18"}), f
}

var alice = Principal{TeleportUser: "alice", Email: "alice@example.com"}
var bob = Principal{TeleportUser: "bob"}

func TestWhoamiAndCatalog(t *testing.T) {
	svc, _ := newService(t)
	ctx := context.Background()
	me, err := svc.Whoami(ctx, alice)
	if err != nil || me.User != "alice" || me.IsApprover || len(me.EffectiveAccess) != 1 || me.EffectiveAccess[0].Name != "requester" {
		t.Fatalf("whoami = %+v, %v", me, err)
	}
	if me, _ := svc.Whoami(ctx, bob); !me.IsApprover {
		t.Fatal("bob must be an approver")
	}
	roles, _ := svc.ListRoles(ctx, "")
	for _, r := range roles.Roles {
		if strings.HasPrefix(r.Name, "bot-") {
			t.Fatal("hidden role listed")
		}
	}
	if _, err := svc.DescribeRole(ctx, "bot-access-broker"); !trace.IsNotFound(err) {
		t.Fatalf("hidden role must be not found, got %v", err)
	}
	rl, _ := svc.ListRequestable(ctx, alice)
	if len(rl.RequestableRoles) != 2 || rl.RequestableRoles[0].Prediction != "auto_approve" || rl.RequestableRoles[0].TTLCap != "1h0m0s" || rl.RequestableRoles[1].Prediction != "require_approval" {
		t.Fatalf("requestable = %+v", rl.RequestableRoles)
	}
	// JSON contract: the keys the MCP tools and the portal expose.
	b, _ := json.Marshal(me)
	for _, key := range []string{`"user"`, `"roles"`, `"traits"`, `"active_elevated_roles"`, `"is_approver"`, `"effective_access"`} {
		if !strings.Contains(string(b), key) {
			t.Fatalf("whoami JSON lacks %s: %s", key, b)
		}
	}
}

func TestCreateRequestGuards(t *testing.T) {
	svc, f := newService(t)
	ctx := context.Background()
	cases := map[string]struct {
		in   CreateRequestIn
		want string
	}{
		"missing reason":  {CreateRequestIn{Roles: []string{"dev-ssh"}}, "reason of 8-512"},
		"short reason":    {CreateRequestIn{Roles: []string{"dev-ssh"}, Reason: "short"}, "reason of 8-512"},
		"no roles":        {CreateRequestIn{Reason: "testing access"}, "at least one role"},
		"unknown role":    {CreateRequestIn{Roles: []string{"k8s-admin"}, Reason: "testing access"}, "not requestable"},
		"hidden role":     {CreateRequestIn{Roles: []string{"bot-access-broker"}, Reason: "testing access"}, "not requestable"},
		"non-requestable": {CreateRequestIn{Roles: []string{"editor"}, Reason: "testing access"}, "not requestable"},
		"bad ttl":         {CreateRequestIn{Roles: []string{"dev-ssh"}, Reason: "testing access", TTL: "soon"}, "ttl must be"},
		"too many roles":  {CreateRequestIn{Roles: make([]string, MaxRolesPerReq+1), Reason: "testing access"}, "too many"},
		"bad resource id": {CreateRequestIn{Roles: []string{"dev-ssh"}, ResourceIDs: []string{"nope"}, Reason: "testing access"}, "resource id"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			svc.d.Limiter = NewLimiter() // the budget is spent before validation; each guard gets a fresh one
			_, err := svc.CreateRequest(ctx, alice, tc.in)
			if err == nil || !trace.IsBadParameter(err) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want bad parameter containing %q, got %v", tc.want, err)
			}
		})
	}
	if reqs, _ := f.GetAccessRequests(ctx, types.AccessRequestFilter{User: "alice"}); len(reqs) != 0 {
		t.Fatal("no request may be created by a rejected input")
	}
	// policy deny refuses creation (but a dry run reports it)
	svc.d.Limiter = NewLimiter()
	f.Requestable["alice"] = []string{"dev-ssh", "prod-ssh", "editor"}
	if _, err := svc.CreateRequest(ctx, alice, CreateRequestIn{Roles: []string{"editor"}, Reason: "testing access"}); err == nil || !strings.Contains(err.Error(), "policy denies") {
		t.Fatalf("deny must refuse creation: %v", err)
	}
	if res, err := svc.CreateRequest(ctx, alice, CreateRequestIn{Roles: []string{"editor"}, Reason: "testing access", DryRun: true}); err != nil || res.Prediction.Action != policy.ActionDeny {
		t.Fatalf("dry run must report the deny: %+v %v", res, err)
	}
	// TTL is clamped to the hard max, then to the policy cap; control characters are stripped from the reason
	res, err := svc.CreateRequest(ctx, alice, CreateRequestIn{Roles: []string{"dev-ssh"}, TTL: "9h", Reason: "testing\x00 access\n with control chars"})
	if err != nil || !res.Created || res.TTLClampedFrom != "9h0m0s" || res.TTL != "1h0m0s" || res.Request == nil || res.Request.State != "PENDING" {
		t.Fatalf("create = %+v, %v", res, err)
	}
	if !strings.HasPrefix(res.TshCommand, "tsh request create --roles dev-ssh --max-duration 1h") || res.Request.TshStatusCommand == "" {
		t.Fatalf("tsh commands = %q / %q", res.TshCommand, res.Request.TshStatusCommand)
	}
	reqs, _ := f.GetAccessRequests(ctx, types.AccessRequestFilter{User: "alice"})
	if len(reqs) != 1 || reqs[0].GetRequestReason() != "testing access  with control chars" || time.Until(reqs[0].GetAccessExpiry()) > time.Hour+time.Minute {
		t.Fatalf("request not created as expected: %v", reqs)
	}
}

func TestCreateRateLimit(t *testing.T) {
	svc, _ := newService(t)
	ctx := context.Background()
	for i := 0; i < CreateBurst; i++ {
		if _, err := svc.CreateRequest(ctx, alice, CreateRequestIn{Roles: []string{"dev-ssh"}, Reason: "testing access", DryRun: true}); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}
	if _, err := svc.CreateRequest(ctx, alice, CreateRequestIn{Roles: []string{"dev-ssh"}, Reason: "testing access", DryRun: true}); !trace.IsLimitExceeded(err) {
		t.Fatalf("6th create must be rate limited, got %v", err)
	}
	// another user has their own budget
	if _, err := svc.CreateRequest(ctx, bob, CreateRequestIn{Roles: []string{"dev-ssh"}, Reason: "testing access", DryRun: true}); err != nil {
		t.Fatalf("bob must not share alice's budget: %v", err)
	}
}

func TestRequestVisibilityAndApproverQueue(t *testing.T) {
	svc, f := newService(t)
	ctx := context.Background()
	res, err := svc.CreateRequest(ctx, alice, CreateRequestIn{Roles: []string{"prod-ssh"}, Reason: "incident 123"})
	if err != nil || !res.Created {
		t.Fatal(err)
	}
	id := res.Request.ID
	if v, err := svc.GetRequest(ctx, alice, id); err != nil || v.ID != id {
		t.Fatalf("own request must be visible: %v", err)
	}
	if v, err := svc.GetRequest(ctx, alice, id[:8]); err != nil || v.ID != id {
		t.Fatalf("prefix lookup: %v", err)
	}
	if _, err := svc.GetRequest(ctx, bob, id); err != nil {
		t.Fatalf("approver may read any request: %v", err)
	}
	carol := Principal{TeleportUser: "carol"}
	u, _ := types.NewUser("carol")
	u.SetRoles([]string{"requester"})
	f.Users["carol"] = u
	if _, err := svc.GetRequest(ctx, carol, id); !trace.IsNotFound(err) {
		t.Fatalf("other users' requests must be invisible (not found), got %v", err)
	}
	if _, err := svc.ListPending(ctx, alice, ""); !trace.IsAccessDenied(err) {
		t.Fatalf("non-approver must not list pending: %v", err)
	}
	list, err := svc.ListPending(ctx, bob, "")
	if err != nil || len(list.Requests) != 1 || list.Requests[0].TshLoginCommand != "" {
		t.Fatalf("pending list = %+v, %v", list, err)
	}
	mine, _ := svc.ListMine(ctx, alice, "pending")
	if len(mine.Requests) != 1 {
		t.Fatalf("list mine = %+v", mine)
	}
	// once approved and unexpired, the view carries the tsh login command
	_ = f.SetAccessRequestState(ctx, types.AccessRequestUpdate{RequestID: id, State: types.RequestState_APPROVED})
	if v, _ := svc.GetRequest(ctx, alice, id); v.State != "APPROVED" || v.TshLoginCommand != "tsh login --request-id="+id {
		t.Fatalf("approved view = %+v", v)
	}
}

func TestSearchScope(t *testing.T) {
	svc, _ := newService(t)
	ctx := context.Background()
	out, err := svc.Search(ctx, alice, SearchIn{Query: "ssh"})
	if err != nil || !out.Scoped || len(out.Resources) != 2 {
		t.Fatalf("alice sees dev+prod (holds or may request), got %+v %v", out, err)
	}
	out, _ = svc.Search(ctx, bob, SearchIn{Query: "ssh"})
	if out.Scoped || len(out.Resources) != 3 {
		t.Fatalf("approver sees everything, got %+v", out)
	}
	if _, err := svc.Search(ctx, alice, SearchIn{Query: strings.Repeat("x", 300)}); !trace.IsBadParameter(err) {
		t.Fatal("long query must be rejected")
	}
	acc, _ := svc.Accessible(ctx, alice, AccessibleIn{})
	if len(acc.Resources) != 0 || !acc.Approximate {
		t.Fatalf("requester reaches nothing now: %+v", acc)
	}
}

func TestUserFacingNeverLeaks(t *testing.T) {
	if got := UserFacing(context.DeadlineExceeded); got != "teleport error" {
		t.Fatalf("generic error leaked: %q", got)
	}
	if got := UserFacing(trace.NotFound("role x")); !strings.HasPrefix(got, "not found: ") {
		t.Fatalf("typed error must keep its message: %q", got)
	}
}
