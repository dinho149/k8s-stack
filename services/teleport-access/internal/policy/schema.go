// Package policy evaluates access requests against the ApprovalPolicy document rendered by
// infra/teleport/src/policy/render.ts (and mounted as a ConfigMap).
package policy

import "time"

// Action is what the broker does with a request.
type Action string

const (
	ActionAutoApprove     Action = "auto_approve"
	ActionRequireApproval Action = "require_approval"
	ActionDeny            Action = "deny"
)

// Policy is the top-level document.
type Policy struct {
	APIVersion string   `json:"apiVersion" yaml:"apiVersion"`
	Kind       string   `json:"kind" yaml:"kind"`
	Defaults   Defaults `json:"defaults" yaml:"defaults"`
	// AllowedRoles: when non-empty, every requested role must match one of these globs/anchored
	// regexes or the request is denied before any rule runs (rendered from the role catalog).
	AllowedRoles []string `json:"allowed_roles,omitempty" yaml:"allowed_roles,omitempty"`
	Rules        []Rule   `json:"rules" yaml:"rules"`
}

// Defaults apply when no rule matches or a rule omits a field.
type Defaults struct {
	Action    Action    `json:"action" yaml:"action"`
	MaxTTL    Duration  `json:"max_ttl" yaml:"max_ttl"`
	Approvers Approvers `json:"approvers" yaml:"approvers"`
	Notify    Notify    `json:"notify" yaml:"notify"`
}

// Rule is one policy rule; rules are evaluated in order, deny rules first.
type Rule struct {
	Name      string    `json:"name" yaml:"name"`
	Match     Match     `json:"match" yaml:"match"`
	MatchMode string    `json:"match_mode,omitempty" yaml:"match_mode,omitempty"` // all (default) | any
	Action    Action    `json:"action" yaml:"action"`
	Reason    string    `json:"reason,omitempty" yaml:"reason,omitempty"`
	TTLCap    Duration  `json:"ttl_cap,omitempty" yaml:"ttl_cap,omitempty"`
	Approvers Approvers `json:"approvers,omitempty" yaml:"approvers,omitempty"`
	Notify    Notify    `json:"notify,omitempty" yaml:"notify,omitempty"`
}

// Match describes which requests a rule applies to. Empty clauses are ignored.
type Match struct {
	// Roles: globs ("dev-*") or anchored regexes ("^admin-.*$"). For deny rules any requested role
	// matching counts; for every other action all requested roles must match.
	Roles []string `json:"roles,omitempty" yaml:"roles,omitempty"`
	// ResourceLabels: every requested resource must carry a matching label (value list, "*" allowed).
	ResourceLabels map[string][]string `json:"resource_labels,omitempty" yaml:"resource_labels,omitempty"`
	// UserTraits: the requester must carry a matching trait.
	UserTraits map[string][]string `json:"user_traits,omitempty" yaml:"user_traits,omitempty"`
	// RequestedTTLMax: the request must not ask for longer than this.
	RequestedTTLMax Duration `json:"requested_ttl_max,omitempty" yaml:"requested_ttl_max,omitempty"`
}

// Approvers who may approve a request that matched the rule.
type Approvers struct {
	TeleportRoles []string `json:"teleport_roles,omitempty" yaml:"teleport_roles,omitempty"`
	Emails        []string `json:"emails,omitempty" yaml:"emails,omitempty"`
}

// Notify says where the chat agent posts the request card.
type Notify struct {
	Channels         []Channel `json:"channels,omitempty" yaml:"channels,omitempty"`
	MentionApprovers bool      `json:"mention_approvers,omitempty" yaml:"mention_approvers,omitempty"`
}

// Channel is one chat destination.
type Channel struct {
	Adapter string `json:"adapter" yaml:"adapter"`
	Target  string `json:"target" yaml:"target"`
}

// Duration is a time.Duration that (un)marshals as "2h", "30m".
type Duration time.Duration

func (d Duration) D() time.Duration { return time.Duration(d) }

func (d Duration) MarshalJSON() ([]byte, error) {
	if d == 0 {
		return []byte(`""`), nil
	}
	return []byte(`"` + time.Duration(d).String() + `"`), nil
}

func (d *Duration) UnmarshalJSON(b []byte) error {
	s := string(b)
	if s == `""` || s == "null" {
		*d = 0
		return nil
	}
	if len(s) >= 2 && s[0] == '"' {
		s = s[1 : len(s)-1]
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return err
	}
	*d = Duration(v)
	return nil
}
