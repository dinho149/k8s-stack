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

func TestMixedTierRequestsAreNeverAutoApproved(t *testing.T) {
	e := engine(t)
	// A low-risk role paired with a role no auto rule covers falls to defaults.
	d := e.Evaluate(EvalRequest{Roles: []string{"dev-ssh", "k8s-admin"}, RequestedTTL: time.Hour})
	if d.Action != ActionRequireApproval {
		t.Fatalf("[dev-ssh k8s-admin] must require approval, got %+v", d)
	}
	d = e.Evaluate(EvalRequest{Roles: []string{"dev-ssh", "prod-ssh"}, RequestedTTL: time.Hour})
	if d.Action != ActionRequireApproval {
		t.Fatalf("[dev-ssh prod-ssh] must require approval, got %+v", d)
	}
	// Deny still wins on any role.
	d = e.Evaluate(EvalRequest{Roles: []string{"dev-ssh", "editor"}, RequestedTTL: time.Hour})
	if d.Action != ActionDeny || d.Rule != "never" {
		t.Fatalf("[dev-ssh editor] must be denied, got %+v", d)
	}
	// Two roles both covered by the same auto rule are still fine.
	d = e.Evaluate(EvalRequest{Roles: []string{"dev-ssh", "dev-db"}, RequestedTTL: time.Hour})
	if d.Action != ActionAutoApprove || d.Rule != "auto-low" {
		t.Fatalf("[dev-ssh dev-db] should auto-approve, got %+v", d)
	}
	// No roles at all is never auto-approved without a resource rule.
	d = e.Evaluate(EvalRequest{Roles: nil, RequestedTTL: time.Hour})
	if d.Action == ActionAutoApprove {
		t.Fatalf("empty role list must not auto-approve: %+v", d)
	}
	d = e.Evaluate(EvalRequest{Roles: []string{}, ResourceLabels: []map[string]string{{"env": "dev"}}})
	if d.Action == ActionAutoApprove {
		t.Fatalf("empty role list with unmatched resources must not auto-approve: %+v", d)
	}
}

func TestPerRoleConfirmationDowngradesAutoApprove(t *testing.T) {
	// A permissive rule that would match the pair, while a later rule makes one role alone
	// require approval: the per-role confirmation must downgrade.
	p, err := Parse([]byte(`
kind: ApprovalPolicy
defaults: {action: require_approval, max_ttl: 8h}
rules:
  - {name: pair, match: {roles: ["dev-*", "k8s-*"], user_traits: {team: [platform]}}, action: auto_approve}
  - {name: k8s, match: {roles: ["k8s-*"]}, action: require_approval, ttl_cap: 1h}
`))
	if err != nil {
		t.Fatal(err)
	}
	e := NewEngine(p)
	// Alone, k8s-admin hits "pair" first (team trait) and would be auto; with a different trait it does not.
	d := e.Evaluate(EvalRequest{Roles: []string{"dev-ssh", "k8s-admin"}, Traits: map[string][]string{"team": {"platform"}}})
	if d.Action != ActionAutoApprove {
		t.Fatalf("both roles auto-approvable alone: %+v", d)
	}
	p2, _ := Parse([]byte(`
kind: ApprovalPolicy
defaults: {action: require_approval, max_ttl: 8h}
rules:
  - {name: k8s, match: {roles: ["k8s-*"], requested_ttl_max: 30m}, action: require_approval}
  - {name: pair, match: {roles: ["dev-*", "k8s-*"]}, action: auto_approve}
`))
	e = NewEngine(p2)
	d = e.Evaluate(EvalRequest{Roles: []string{"dev-ssh", "k8s-admin"}, RequestedTTL: 10 * time.Minute})
	if d.Action != ActionRequireApproval || d.Rule != RuleMixedTier {
		t.Fatalf("k8s-admin alone requires approval, pair must downgrade: %+v", d)
	}
}

func TestAllowedRolesCatalog(t *testing.T) {
	p, err := Parse([]byte(`
kind: ApprovalPolicy
defaults: {action: require_approval, max_ttl: 8h}
allowed_roles: ["dev-*", "prod-ssh", "^k8s-(dev|prod)$"]
rules:
  - {name: auto, match: {roles: ["dev-*"]}, action: auto_approve}
`))
	if err != nil {
		t.Fatal(err)
	}
	e := NewEngine(p)
	if d := e.Evaluate(EvalRequest{Roles: []string{"dev-ssh"}}); d.Action != ActionAutoApprove {
		t.Fatalf("catalog role should pass: %+v", d)
	}
	for _, roles := range [][]string{{"editor"}, {"dev-ssh", "access"}, {"k8s-admin"}, {"prod-ssh-2"}} {
		d := e.Evaluate(EvalRequest{Roles: roles})
		if d.Action != ActionDeny || d.Rule != RuleNotInCatalog {
			t.Fatalf("%v should be denied as not-in-catalog: %+v", roles, d)
		}
	}
	if d := e.Evaluate(EvalRequest{Roles: []string{"k8s-dev"}}); d.Action != ActionRequireApproval || d.Rule != "" {
		t.Fatalf("regex catalog entry should pass to defaults: %+v", d)
	}
}

func TestValidationRejectsUnsafePolicies(t *testing.T) {
	bad := map[string]string{
		"defaults auto_approve": "kind: ApprovalPolicy\ndefaults: {action: auto_approve, max_ttl: 1h}\nrules: []",
		"unanchored regex":      "kind: ApprovalPolicy\ndefaults: {action: deny, max_ttl: 1h}\nrules: [{name: a, action: deny, match: {roles: ['^admin-']}}]",
		"unanchored allowed":    "kind: ApprovalPolicy\ndefaults: {action: deny, max_ttl: 1h}\nallowed_roles: ['^dev']\nrules: []",
	}
	for name, b := range bad {
		if _, err := Parse([]byte(b)); err == nil {
			t.Errorf("%s should fail validation", name)
		}
	}
	if _, err := compileMatcher("^admin-"); err == nil {
		t.Fatal("unanchored ^ pattern must not compile")
	}
}
