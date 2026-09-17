package policy

import (
	"fmt"
	"os"
	"strings"

	"sigs.k8s.io/yaml"
)

// Load reads and validates a policy file.
func Load(path string) (*Policy, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read policy: %w", err)
	}
	return Parse(b)
}

// Parse parses and validates a YAML/JSON policy document.
func Parse(b []byte) (*Policy, error) {
	var p Policy
	if err := yaml.UnmarshalStrict(b, &p); err != nil {
		return nil, fmt.Errorf("parse policy: %w", err)
	}
	if err := p.Validate(); err != nil {
		return nil, err
	}
	return &p, nil
}

// Validate checks structural rules.
func (p *Policy) Validate() error {
	var errs []string
	if p.Kind != "ApprovalPolicy" {
		errs = append(errs, fmt.Sprintf("kind must be ApprovalPolicy, got %q", p.Kind))
	}
	if !validAction(p.Defaults.Action) {
		errs = append(errs, fmt.Sprintf("defaults.action %q invalid", p.Defaults.Action))
	}
	if p.Defaults.MaxTTL <= 0 {
		errs = append(errs, "defaults.max_ttl must be > 0")
	}
	seen := map[string]bool{}
	for i, r := range p.Rules {
		if r.Name == "" {
			errs = append(errs, fmt.Sprintf("rules[%d]: name required", i))
		}
		if seen[r.Name] {
			errs = append(errs, fmt.Sprintf("rules[%d]: duplicate name %q", i, r.Name))
		}
		seen[r.Name] = true
		if !validAction(r.Action) {
			errs = append(errs, fmt.Sprintf("rules[%d] %s: action %q invalid", i, r.Name, r.Action))
		}
		if r.MatchMode != "" && r.MatchMode != "all" && r.MatchMode != "any" {
			errs = append(errs, fmt.Sprintf("rules[%d] %s: match_mode must be all|any", i, r.Name))
		}
		if len(r.Match.Roles) == 0 && len(r.Match.ResourceLabels) == 0 && len(r.Match.UserTraits) == 0 && r.Match.RequestedTTLMax == 0 {
			errs = append(errs, fmt.Sprintf("rules[%d] %s: match is empty", i, r.Name))
		}
		for _, g := range r.Match.Roles {
			if _, err := compileMatcher(g); err != nil {
				errs = append(errs, fmt.Sprintf("rules[%d] %s: bad role matcher %q: %v", i, r.Name, g, err))
			}
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("invalid policy:\n  - %s", strings.Join(errs, "\n  - "))
	}
	return nil
}

func validAction(a Action) bool {
	switch a {
	case ActionAutoApprove, ActionRequireApproval, ActionDeny:
		return true
	}
	return false
}
