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

// Evaluate returns the decision for req. Deny rules are checked first (regardless of order),
// then the remaining rules in order; the first match wins; defaults otherwise.
func (e *Engine) Evaluate(req EvalRequest) Decision {
	e.mu.RLock()
	p := e.policy
	e.mu.RUnlock()

	for _, r := range p.Rules {
		if r.Action == ActionDeny && e.matches(r, req) {
			return e.decision(p, &r, req)
		}
	}
	for _, r := range p.Rules {
		if r.Action != ActionDeny && e.matches(r, req) {
			return e.decision(p, &r, req)
		}
	}
	return e.decision(p, nil, req)
}

func (e *Engine) decision(p *Policy, r *Rule, req EvalRequest) Decision {
	d := Decision{Action: p.Defaults.Action, Reason: "no policy rule matched; defaults applied", TTLCap: p.Defaults.MaxTTL.D(), Approvers: p.Defaults.Approvers, Notify: p.Defaults.Notify}
	if r == nil {
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
func (e *Engine) matches(r Rule, req EvalRequest) bool {
	var results []bool
	if len(r.Match.Roles) > 0 {
		results = append(results, e.anyRoleMatches(r.Match.Roles, req.Roles))
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
func compileMatcher(pattern string) (*regexp.Regexp, error) {
	if strings.HasPrefix(pattern, "^") {
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
