package policy

import (
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

// EvalRequest is everything the engine needs to know about an access request.
type EvalRequest struct {
	Requester      string
	Roles          []string
	ResourceLabels []map[string]string // one map per requested resource (empty for role-only requests)
	Traits         map[string][]string
	RequestedTTL   time.Duration
}

// Decision is the engine's verdict.
type Decision struct {
	Action    Action
	Rule      string // "" when defaults applied
	Reason    string
	TTLCap    time.Duration
	Approvers Approvers
	Notify    Notify
}

// Rule names the engine synthesises (they never come from the policy document).
const (
	RuleNotInCatalog = "not-in-catalog"
	RuleMixedTier    = "mixed-tier-request"
)

// Engine evaluates requests against a policy; safe for concurrent use and hot-swappable.
type Engine struct {
	mu     sync.RWMutex
	policy *Policy
	cache  map[string]*regexp.Regexp
}

// NewEngine builds an engine for p.
func NewEngine(p *Policy) *Engine {
	return &Engine{policy: p, cache: map[string]*regexp.Regexp{}}
}

// Replace swaps the policy (hot reload).
func (e *Engine) Replace(p *Policy) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.policy = p
	e.cache = map[string]*regexp.Regexp{}
}

// Policy returns the current policy.
func (e *Engine) Policy() *Policy {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.policy
}

// Evaluate returns the decision for req.
//
// Order: every requested role must be in allowed_roles (when set), otherwise deny. Deny rules are
// checked first regardless of order and match when ANY requested role matches. Then the remaining
// rules in order; a non-deny rule's roles clause matches only when EVERY requested role matches, so
// a request mixing a low-risk and a high-risk role can never ride an auto-approve rule. The first
// match wins; defaults otherwise. Finally an auto_approve verdict is confirmed per role: each role
// on its own must also be auto-approvable (deny > require_approval > auto_approve), and a request
// with no roles is only auto-approvable through a resource_labels rule.
func (e *Engine) Evaluate(req EvalRequest) Decision {
	e.mu.RLock()
	p := e.policy
	e.mu.RUnlock()

	if len(p.AllowedRoles) > 0 {
		for _, role := range req.Roles {
			if !e.anyRoleMatches(p.AllowedRoles, []string{role}) {
				d := e.decision(p, nil, req)
				d.Action, d.Rule = ActionDeny, RuleNotInCatalog
				d.Reason = fmt.Sprintf("role %q is not requestable through the access broker", role)
				return d
			}
		}
	}

	d, matched := e.evaluateOnce(p, req)
	if d.Action != ActionAutoApprove {
		return d
	}
	if len(req.Roles) == 0 {
		if matched == nil || len(matched.Match.ResourceLabels) == 0 {
			d.Action, d.Rule = ActionRequireApproval, RuleMixedTier
			d.Reason = "requests without roles are not auto-approvable unless a resource rule matches"
		}
		return d
	}
	if len(req.Roles) == 1 {
		return d
	}
	// Belt and braces: every role alone must be auto-approvable.
	var worst *Decision
	for _, role := range req.Roles {
		single := req
		single.Roles = []string{role}
		sd, _ := e.evaluateOnce(p, single)
		switch sd.Action {
		case ActionDeny:
			sd.Reason = fmt.Sprintf("role %q is denied: %s", role, sd.Reason)
			return sd
		case ActionRequireApproval:
			if worst == nil {
				cp := sd
				cp.Rule = RuleMixedTier
				cp.Reason = fmt.Sprintf("mixed-tier request: role %q alone requires approval (%s); every role in a request must be auto-approvable", role, sd.Reason)
				worst = &cp
			}
		}
	}
	if worst != nil {
		if d.TTLCap > 0 && d.TTLCap < worst.TTLCap {
			worst.TTLCap = d.TTLCap
		}
		return *worst
	}
	return d
}

// evaluateOnce applies the rule list once (no per-role confirmation) and reports the matched rule.
func (e *Engine) evaluateOnce(p *Policy, req EvalRequest) (Decision, *Rule) {
	for i := range p.Rules {
		r := &p.Rules[i]
		if r.Action == ActionDeny && e.matches(*r, req) {
			return e.decision(p, r, req), r
		}
	}
	for i := range p.Rules {
		r := &p.Rules[i]
		if r.Action != ActionDeny && e.matches(*r, req) {
			return e.decision(p, r, req), r
		}
	}
	return e.decision(p, nil, req), nil
}

func (e *Engine) decision(p *Policy, r *Rule, req EvalRequest) Decision {
	d := Decision{Action: p.Defaults.Action, Reason: "no policy rule matched; defaults applied", TTLCap: p.Defaults.MaxTTL.D(), Approvers: p.Defaults.Approvers, Notify: p.Defaults.Notify}
	if r == nil {
		if d.Action == ActionAutoApprove {
			// Validate rejects this, but an engine can be built from an unvalidated policy.
			d.Action = ActionRequireApproval
			d.Reason = "defaults cannot auto-approve; approval required"
		}
		if req.RequestedTTL > 0 && req.RequestedTTL < d.TTLCap {
			d.TTLCap = req.RequestedTTL
		}
		return d
	}
	d.Action, d.Rule = r.Action, r.Name
	d.Reason = r.Reason
	if d.Reason == "" {
		d.Reason = fmt.Sprintf("policy rule %q", r.Name)
	}
	if r.TTLCap > 0 && r.TTLCap.D() < d.TTLCap {
		d.TTLCap = r.TTLCap.D()
	}
	if len(r.Approvers.TeleportRoles) > 0 || len(r.Approvers.Emails) > 0 {
		d.Approvers = r.Approvers
	}
	if len(r.Notify.Channels) > 0 {
		d.Notify = r.Notify
	}
	if req.RequestedTTL > 0 && req.RequestedTTL < d.TTLCap {
		d.TTLCap = req.RequestedTTL
	}
	return d
}

// matches reports whether every (all) or any (any) non-empty clause of r.Match holds for req.
// The roles clause is satisfied by any matching role for deny rules and only when all requested
// roles match for every other action.
func (e *Engine) matches(r Rule, req EvalRequest) bool {
	var results []bool
	if len(r.Match.Roles) > 0 {
		if r.Action == ActionDeny {
			results = append(results, e.anyRoleMatches(r.Match.Roles, req.Roles))
		} else {
			results = append(results, e.allRolesMatch(r.Match.Roles, req.Roles))
		}
	}
	if len(r.Match.ResourceLabels) > 0 {
		results = append(results, resourcesMatch(r.Match.ResourceLabels, req.ResourceLabels))
	}
	if len(r.Match.UserTraits) > 0 {
		results = append(results, traitsMatch(r.Match.UserTraits, req.Traits))
	}
	if r.Match.RequestedTTLMax > 0 {
		// An unknown duration (0) counts as within the cap: the decision's ttl_cap is applied anyway.
		results = append(results, req.RequestedTTL == 0 || req.RequestedTTL <= r.Match.RequestedTTLMax.D())
	}
	if len(results) == 0 {
		return false
	}
	if r.MatchMode == "any" {
		for _, ok := range results {
			if ok {
				return true
			}
		}
		return false
	}
	for _, ok := range results {
		if !ok {
			return false
		}
	}
	return true
}

func (e *Engine) anyRoleMatches(patterns, roles []string) bool {
	for _, role := range roles {
		for _, pat := range patterns {
			if e.roleMatch(pat, role) {
				return true
			}
		}
	}
	return false
}

// allRolesMatch: every requested role matches some pattern; an empty role list never matches.
func (e *Engine) allRolesMatch(patterns, roles []string) bool {
	if len(roles) == 0 {
		return false
	}
	for _, role := range roles {
		if !e.anyRoleMatches(patterns, []string{role}) {
			return false
		}
	}
	return true
}

func (e *Engine) roleMatch(pattern, role string) bool {
	e.mu.RLock()
	re, ok := e.cache[pattern]
	e.mu.RUnlock()
	if !ok {
		var err error
		re, err = compileMatcher(pattern)
		if err != nil {
			return false
		}
		e.mu.Lock()
		e.cache[pattern] = re
		e.mu.Unlock()
	}
	return re.MatchString(role)
}

// compileMatcher turns "dev-*" into ^dev-.*$ and passes anchored regexes ("^...$") through.
// A "^" pattern that is not "$"-anchored is rejected (it would match any role with that prefix).
func compileMatcher(pattern string) (*regexp.Regexp, error) {
	if strings.HasPrefix(pattern, "^") {
		if !strings.HasSuffix(pattern, "$") {
			return nil, fmt.Errorf("regex role matcher %q must be anchored with $", pattern)
		}
		return regexp.Compile(pattern)
	}
	var sb strings.Builder
	sb.WriteString("^")
	for _, part := range strings.Split(pattern, "*") {
		sb.WriteString(regexp.QuoteMeta(part))
		sb.WriteString(".*")
	}
	s := strings.TrimSuffix(sb.String(), ".*") + "$"
	return regexp.Compile(s)
}

// resourcesMatch: every requested resource must satisfy every selector key; no resources => false.
func resourcesMatch(selector map[string][]string, resources []map[string]string) bool {
	if len(resources) == 0 {
		return false
	}
	for _, labels := range resources {
		if !LabelsMatch(selector, labels) {
			return false
		}
	}
	return true
}

func traitsMatch(selector, traits map[string][]string) bool {
	for k, wanted := range selector {
		have := traits[k]
		if !anyValueMatches(wanted, have) {
			return false
		}
	}
	return true
}

// LabelsMatch reports whether labels satisfy selector (every key present with a matching value).
func LabelsMatch(selector map[string][]string, labels map[string]string) bool {
	for k, wanted := range selector {
		v, ok := labels[k]
		if !ok {
			return false
		}
		if !anyValueMatches(wanted, []string{v}) {
			return false
		}
	}
	return true
}

func anyValueMatches(wanted, have []string) bool {
	for _, w := range wanted {
		for _, h := range have {
			if w == "*" || w == h {
				return true
			}
			if strings.HasPrefix(w, "^") {
				if re, err := regexp.Compile(w); err == nil && re.MatchString(h) {
					return true
				}
			}
		}
	}
	return false
}
