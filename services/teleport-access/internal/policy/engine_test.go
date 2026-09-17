package policy

import (
	"testing"
	"time"
)

const testPolicy = `
apiVersion: access.k8s-teleport/v1
kind: ApprovalPolicy
defaults:
  action: require_approval
  max_ttl: 8h
  approvers: { teleport_roles: ["approver"] }
rules:
  - name: never
    match: { roles: ["editor", "^admin-.*$"] }
    action: deny
  - name: auto-low
    match: { roles: ["dev-*"], requested_ttl_max: 4h }
    action: auto_approve
    ttl_cap: 4h
  - name: prod
    match: { roles: ["prod-*", "dba"], resource_labels: { env: ["prod"] } }
    match_mode: any
    action: require_approval
    approvers: { teleport_roles: ["approver", "sre"], emails: ["oncall@example.com"] }
    ttl_cap: 2h
  - name: team-trait
    match: { user_traits: { team: ["platform"] }, roles: ["ops-*"] }
    action: auto_approve
`

func engine(t *testing.T) *Engine {
	t.Helper()
	p, err := Parse([]byte(testPolicy))
	if err != nil {
		t.Fatal(err)
	}
	return NewEngine(p)
}

func TestDenyWinsRegardlessOfOrder(t *testing.T) {
	d := engine(t).Evaluate(EvalRequest{Roles: []string{"dev-ssh", "editor"}, RequestedTTL: time.Hour})
	if d.Action != ActionDeny || d.Rule != "never" {
		t.Fatalf("want deny/never, got %+v", d)
	}
	d = engine(t).Evaluate(EvalRequest{Roles: []string{"admin-x"}})
	if d.Action != ActionDeny {
		t.Fatalf("regex deny failed: %+v", d)
	}
}

func TestAutoApproveLowRiskWithTTLCap(t *testing.T) {
	d := engine(t).Evaluate(EvalRequest{Roles: []string{"dev-ssh"}, RequestedTTL: time.Hour})
	if d.Action != ActionAutoApprove || d.Rule != "auto-low" || d.TTLCap != time.Hour {
		t.Fatalf("got %+v", d)
	}
	// Unknown duration (prediction without a TTL) still matches and gets the cap.
	d = engine(t).Evaluate(EvalRequest{Roles: []string{"dev-ssh"}})
	if d.Action != ActionAutoApprove || d.TTLCap != 4*time.Hour {
		t.Fatalf("unknown ttl: got %+v", d)
	}
	// Asking for longer than requested_ttl_max falls through to defaults.
	d = engine(t).Evaluate(EvalRequest{Roles: []string{"dev-ssh"}, RequestedTTL: 6 * time.Hour})
	if d.Action != ActionRequireApproval || d.Rule != "" || d.TTLCap != 6*time.Hour {
		t.Fatalf("got %+v", d)
	}
}

func TestProdAnyMode(t *testing.T) {
	e := engine(t)
	d := e.Evaluate(EvalRequest{Roles: []string{"prod-ssh"}, RequestedTTL: 5 * time.Hour})
	if d.Action != ActionRequireApproval || d.Rule != "prod" || d.TTLCap != 2*time.Hour {
		t.Fatalf("got %+v", d)
	}
	if len(d.Approvers.Emails) != 1 || d.Approvers.TeleportRoles[1] != "sre" {
		t.Fatalf("approvers not taken from rule: %+v", d.Approvers)
	}
	d = e.Evaluate(EvalRequest{Roles: []string{"something"}, ResourceLabels: []map[string]string{{"env": "prod"}}})
	if d.Rule != "prod" {
		t.Fatalf("resource label match failed: %+v", d)
	}
}

func TestTraitsAllMode(t *testing.T) {
	e := engine(t)
	if d := e.Evaluate(EvalRequest{Roles: []string{"ops-x"}, Traits: map[string][]string{"team": {"platform"}}}); d.Rule != "team-trait" {
		t.Fatalf("got %+v", d)
	}
	if d := e.Evaluate(EvalRequest{Roles: []string{"ops-x"}, Traits: map[string][]string{"team": {"app"}}}); d.Rule != "" {
		t.Fatalf("all-mode should fail on trait: %+v", d)
	}
}

func TestResourceLabelsRequireAllResources(t *testing.T) {
	sel := map[string][]string{"env": {"prod"}}
	if resourcesMatch(sel, []map[string]string{{"env": "prod"}, {"env": "dev"}}) {
		t.Fatal("mixed resources must not match")
	}
	if resourcesMatch(sel, nil) {
		t.Fatal("no resources must not match a resource selector")
	}
	if !LabelsMatch(map[string][]string{"env": {"*"}, "tier": {"^d.*$"}}, map[string]string{"env": "x", "tier": "data"}) {
		t.Fatal("wildcard/regex label match failed")
	}
}

func TestValidation(t *testing.T) {
	bad := []string{
		"kind: Nope\ndefaults: {action: deny, max_ttl: 1h}\nrules: []",
		"kind: ApprovalPolicy\ndefaults: {action: deny, max_ttl: 1h}\nrules: [{name: a, action: bogus, match: {roles: [x]}}]",
		"kind: ApprovalPolicy\ndefaults: {action: deny, max_ttl: 1h}\nrules: [{name: a, action: deny, match: {}}]",
		"kind: ApprovalPolicy\ndefaults: {action: deny, max_ttl: 1h}\nrules: [{name: a, action: deny, match: {roles: [x]}}, {name: a, action: deny, match: {roles: [y]}}]",
		"kind: ApprovalPolicy\ndefaults: {action: deny, max_ttl: 1h}\nrules: [{name: a, action: deny, match: {roles: ['^(']}}]",
		"kind: ApprovalPolicy\ndefaults: {action: deny, max_ttl: 1h}\nunknown: 1\nrules: []",
	}
	for i, b := range bad {
		if _, err := Parse([]byte(b)); err == nil {
			t.Errorf("case %d should fail", i)
		}
	}
}

func TestGlobCompile(t *testing.T) {
	cases := map[string][2]string{"dev-*": {"dev-ssh", "prod-ssh"}, "*": {"anything", ""}, "dba": {"dba", "dbaa"}}
	for pat, c := range cases {
		re, err := compileMatcher(pat)
		if err != nil {
			t.Fatal(err)
		}
		if !re.MatchString(c[0]) {
			t.Errorf("%q should match %q", pat, c[0])
		}
		if c[1] != "" && re.MatchString(c[1]) {
			t.Errorf("%q should not match %q", pat, c[1])
		}
	}
}
