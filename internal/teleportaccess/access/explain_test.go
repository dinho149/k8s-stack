package access

import (
	"context"
	"testing"
	"time"

	"github.com/gravitational/teleport/api/client/proto"
	"github.com/gravitational/teleport/api/types"

	"github.com/yeaboi/k8s-stack/internal/teleportaccess/policy"
	"github.com/yeaboi/k8s-stack/internal/teleportaccess/teleport/fake"
)

func role(t *testing.T, name string, allow types.RoleConditions, deny types.RoleConditions) types.Role {
	t.Helper()
	r, err := types.NewRole(name, types.RoleSpecV6{Allow: allow, Deny: deny, Options: types.RoleOptions{MaxSessionTTL: types.Duration(2 * time.Hour)}})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func node(t *testing.T, name string, labels map[string]string) *proto.PaginatedResource {
	t.Helper()
	n, err := types.NewServerWithLabels(name, types.KindNode, types.ServerSpecV2{Hostname: name, Addr: "10.0.0.1:3022"}, labels)
	if err != nil {
		t.Fatal(err)
	}
	return &proto.PaginatedResource{Resource: &proto.PaginatedResource_Node{Node: n.(*types.ServerV2)}}
}

func TestExplain(t *testing.T) {
	f := fake.New()
	f.Roles["dev-ssh"] = role(t, "dev-ssh", types.RoleConditions{Logins: []string{"dev"}, NodeLabels: types.Labels{"env": {"local", "dev"}}}, types.RoleConditions{})
	f.Roles["prod-ssh"] = role(t, "prod-ssh", types.RoleConditions{Logins: []string{"dev"}, NodeLabels: types.Labels{"env": {"prod"}}}, types.RoleConditions{})
	f.Roles["team-ssh"] = role(t, "team-ssh", types.RoleConditions{Logins: []string{"{{internal.logins}}"}, NodeLabels: types.Labels{"team": {"{{external.team}}"}}}, types.RoleConditions{})
	f.Roles["no-prod"] = role(t, "no-prod", types.RoleConditions{Logins: []string{"x"}, NodeLabels: types.Labels{"*": {"*"}}}, types.RoleConditions{NodeLabels: types.Labels{"env": {"prod"}}})
	f.Roles["bot-x"] = role(t, "bot-x", types.RoleConditions{NodeLabels: types.Labels{"*": {"*"}}}, types.RoleConditions{})
	f.Roles["requester"] = role(t, "requester", types.RoleConditions{Request: &types.AccessRequestConditions{Roles: []string{"dev-ssh", "prod-ssh"}}}, types.RoleConditions{})
	alice, _ := types.NewUser("alice")
	alice.SetRoles([]string{"requester"})
	alice.SetTraits(map[string][]string{"team": {"app"}, "logins": {"alice"}})
	f.Users["alice"] = alice
	f.Requestable["alice"] = []string{"dev-ssh", "prod-ssh"}
	f.Resources = &proto.ListUnifiedResourcesResponse{Resources: []*proto.PaginatedResource{node(t, "ssh-prod-0", map[string]string{"env": "prod", "team": "platform"}), node(t, "ssh-dev-0", map[string]string{"env": "dev", "team": "app"})}}

	pol, err := policy.Parse([]byte("kind: ApprovalPolicy\ndefaults: {action: require_approval, max_ttl: 8h}\nrules:\n  - {name: auto, match: {roles: ['dev-*']}, action: auto_approve, ttl_cap: 4h}\n  - {name: prod, match: {roles: ['prod-*']}, action: require_approval, approvers: {teleport_roles: [approver]}, ttl_cap: 2h}\n"))
	if err != nil {
		t.Fatal(err)
	}
	deps := Deps{API: f, Policy: policy.NewEngine(pol), HideRolePrefixes: []string{"bot-"}}

	res, err := Explain(context.Background(), deps, "alice", "ssh-prod-0", "node")
	if err != nil {
		t.Fatal(err)
	}
	if res.Resource == nil || res.Resource.Name != "ssh-prod-0" {
		t.Fatalf("resource not resolved: %+v", res)
	}
	if len(res.Requestable) != 1 || res.Requestable[0] != "prod-ssh" {
		t.Fatalf("requestable = %v", res.Requestable)
	}
	if len(res.HasNow) != 0 {
		t.Fatalf("alice should hold nothing: %v", res.HasNow)
	}
	var denied bool
	for _, g := range res.Grants {
		if g.Role == "no-prod" && g.DeniedBy == "no-prod" {
			denied = true
		}
		if g.Role == "bot-x" {
			t.Fatal("hidden role leaked")
		}
	}
	if !denied {
		t.Fatalf("deny selector not honoured: %+v", res.Grants)
	}
	if res.Suggested[0].Prediction != "require_approval" || res.Suggested[0].Rule != "prod" || res.Suggested[0].TTLCap != "2h0m0s" {
		t.Fatalf("suggestion = %+v", res.Suggested[0])
	}

	res, err = Explain(context.Background(), deps, "alice", "ssh-dev-0", "")
	if err != nil {
		t.Fatal(err)
	}
	var teamGrant *RoleGrant
	for i := range res.Grants {
		if res.Grants[i].Role == "team-ssh" {
			teamGrant = &res.Grants[i]
		}
	}
	if teamGrant == nil || teamGrant.Logins[0] != "alice" {
		t.Fatalf("trait expansion failed: %+v", teamGrant)
	}
	if res.Suggested[0].Role != "dev-ssh" || res.Suggested[0].Prediction != "auto_approve" {
		t.Fatalf("auto-approve suggestion expected first: %+v", res.Suggested)
	}
	// no-prod grants dev (deny only covers prod) and team-ssh matches via traits; neither is requestable.
	if len(res.NotRequestable) != 2 || res.NotRequestable[0] != "no-prod" || res.NotRequestable[1] != "team-ssh" {
		t.Fatalf("not_requestable = %v", res.NotRequestable)
	}

	res, _ = Explain(context.Background(), deps, "alice", "ssh", "")
	if res.Resource != nil || len(res.Ambiguous) != 2 {
		t.Fatalf("expected ambiguity: %+v", res)
	}
}
