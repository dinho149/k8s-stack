//go:build integration

package integration

import (
	"context"
	"testing"
	"time"

	"github.com/gravitational/teleport/api/client/proto"
	"github.com/gravitational/teleport/api/types"

	"github.com/dinho/k8s-teleport/tests/integration/harness"
)

var catalog = []string{"dev-ssh", "dev-db", "dev-k8s", "dev-app", "prod-ssh", "prod-db", "prod-k8s", "prod-app", "dev-dba", "prod-dba", "k8s-admin", "break-glass-editor", "requester", "approver"}

func TestRolesUsersBotsExist(t *testing.T) {
	clt := harness.Connect(t, harness.FromEnv(t))
	ctx := context.Background()
	roles, err := clt.GetRoles(ctx)
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]types.Role{}
	for _, r := range roles {
		have[r.GetName()] = r
	}
	for _, name := range catalog {
		if _, ok := have[name]; !ok {
			t.Errorf("role %s missing", name)
		}
	}
	// zero standing privileges: requester selects no resources
	req := have["requester"]
	if req == nil || len(req.GetNodeLabels(types.Allow)) != 0 || len(req.GetDatabaseLabels(types.Allow)) != 0 {
		t.Fatalf("requester must grant no resource access")
	}
	if got := req.GetAccessRequestConditions(types.Allow).Roles; len(got) < 10 {
		t.Fatalf("requester should be able to request the catalog, got %v", got)
	}
	for _, u := range []string{"alice", "bob"} {
		user, err := clt.GetUser(ctx, u, false)
		if err != nil {
			t.Fatalf("user %s: %v", u, err)
		}
		if user.GetRoles()[0] != "requester" {
			t.Errorf("%s should start with requester, has %v", u, user.GetRoles())
		}
	}
}

func TestDummyResourcesRegistered(t *testing.T) {
	clt := harness.Connect(t, harness.FromEnv(t))
	ctx := context.Background()
	resp, err := clt.ListUnifiedResources(ctx, &proto.ListUnifiedResourcesRequest{Limit: 100, SortBy: types.SortBy{Field: "name"}})
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]map[string]string{}
	for _, r := range resp.Resources {
		switch {
		case r.GetNode() != nil:
			found["node/"+r.GetNode().GetHostname()] = r.GetNode().GetAllLabels()
		case r.GetDatabaseServer() != nil:
			found["db/"+r.GetDatabaseServer().GetDatabase().GetName()] = r.GetDatabaseServer().GetDatabase().GetAllLabels()
		case r.GetAppServer() != nil:
			found["app/"+r.GetAppServer().GetApp().GetName()] = r.GetAppServer().GetApp().GetAllLabels()
		case r.GetKubernetesServer() != nil:
			found["kube/"+r.GetKubernetesServer().GetCluster().GetName()] = r.GetKubernetesServer().GetCluster().GetAllLabels()
		}
	}
	want := map[string]string{"node/ssh-dev-0": "dev", "node/ssh-prod-0": "prod", "db/postgres-dev": "dev", "db/postgres-prod": "prod", "app/httpbin": "dev", "kube/local-kind": "local"}
	// Service bots are denied every env=prod app (deny.app_labels), so the harness must NOT see the prod console
	// even though it is registered (verified through tctl in the e2e suite).
	if _, visible := found["app/cloud-console"]; visible {
		t.Errorf("app/cloud-console is visible to the harness bot; bot roles must deny prod apps")
	}
	for name, env := range want {
		labels, ok := found[name]
		if !ok {
			t.Errorf("%s not registered (have %d resources)", name, len(found))
			continue
		}
		if labels["env"] != env {
			t.Errorf("%s env=%q want %q", name, labels["env"], env)
		}
	}
}

func TestBrokerAutoApprovesLowRisk(t *testing.T) {
	clt := harness.Connect(t, harness.FromEnv(t))
	r := harness.CreateRequest(t, clt, "alice", []string{"dev-ssh"}, time.Hour, "integration: low risk")
	got := harness.WaitState(t, clt, r.GetName(), types.RequestState_APPROVED, 60*time.Second)
	if ann := got.GetResolveAnnotations(); len(ann["access-broker/mode"]) == 0 || ann["access-broker/mode"][0] != "auto" {
		t.Fatalf("expected broker auto annotation, got %v", ann)
	}
}

func TestBrokerHoldsHighRiskUntilApproved(t *testing.T) {
	clt := harness.Connect(t, harness.FromEnv(t))
	ctx := context.Background()
	r := harness.CreateRequest(t, clt, "alice", []string{"prod-ssh"}, time.Hour, "integration: high risk")
	time.Sleep(15 * time.Second)
	reqs, err := clt.GetAccessRequests(ctx, types.AccessRequestFilter{ID: r.GetName()})
	if err != nil || len(reqs) != 1 {
		t.Fatalf("get: %v %d", err, len(reqs))
	}
	if reqs[0].GetState() != types.RequestState_PENDING {
		t.Fatalf("high-risk request should stay pending, is %s", reqs[0].GetState())
	}
	// harness approves as an administrator (what an approver's click does through the broker)
	if err := clt.SetAccessRequestState(ctx, types.AccessRequestUpdate{RequestID: r.GetName(), State: types.RequestState_APPROVED, Reason: "integration approve"}); err != nil {
		t.Fatalf("approve: %v", err)
	}
	harness.WaitState(t, clt, r.GetName(), types.RequestState_APPROVED, 20*time.Second)
}

func TestBrokerDeniesAdminRoles(t *testing.T) {
	clt := harness.Connect(t, harness.FromEnv(t))
	// alice cannot even request editor (not in requester.request.roles) -> Teleport rejects it
	req, _ := types.NewAccessRequest("00000000-0000-4000-8000-000000000001", "alice", "editor")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if _, err := clt.CreateAccessRequestV2(ctx, req); err == nil {
		t.Fatal("alice must not be able to request editor")
	}
}

func TestBrokerHoldsMixedTierRequest(t *testing.T) {
	// A single low-risk role must never drag a high-risk role through auto-approval.
	clt := harness.Connect(t, harness.FromEnv(t))
	ctx := context.Background()
	r := harness.CreateRequest(t, clt, "alice", []string{"dev-ssh", "prod-ssh"}, time.Hour, "integration: mixed tier")
	time.Sleep(15 * time.Second)
	reqs, err := clt.GetAccessRequests(ctx, types.AccessRequestFilter{ID: r.GetName()})
	if err != nil || len(reqs) != 1 {
		t.Fatalf("get: %v %d", err, len(reqs))
	}
	if reqs[0].GetState() != types.RequestState_PENDING {
		t.Fatalf("mixed-tier request must stay pending, is %s", reqs[0].GetState())
	}
}

func TestBrokerDeniesNonCatalogRoleViaPolicy(t *testing.T) {
	// break-glass-editor is requestable but high tier: it must never be auto-approved.
	clt := harness.Connect(t, harness.FromEnv(t))
	ctx := context.Background()
	r := harness.CreateRequest(t, clt, "alice", []string{"break-glass-editor"}, 30*time.Minute, "integration: break glass")
	time.Sleep(15 * time.Second)
	reqs, err := clt.GetAccessRequests(ctx, types.AccessRequestFilter{ID: r.GetName()})
	if err != nil || len(reqs) != 1 {
		t.Fatalf("get: %v %d", err, len(reqs))
	}
	if reqs[0].GetState() == types.RequestState_APPROVED {
		t.Fatalf("break-glass-editor must not be auto-approved")
	}
}
