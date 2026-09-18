package access

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/gravitational/teleport/api/client/proto"
	"github.com/gravitational/teleport/api/types"

	"github.com/dinho/k8s-teleport/services/teleport-access/internal/policy"
	"github.com/dinho/k8s-teleport/services/teleport-access/internal/teleport"
)

// Deps are the collaborators Explain needs.
type Deps struct {
	API    teleport.API
	Policy *policy.Engine // optional: adds broker predictions
	// HideRolePrefixes hides internal roles (bot-*, etc.) from explanations.
	HideRolePrefixes []string
}

// RoleGrant explains how one role relates to the resource.
type RoleGrant struct {
	Role            string              `json:"role"`
	Description     string              `json:"description,omitempty"`
	Matched         map[string][]string `json:"matched_selector,omitempty"`
	Logins          []string            `json:"logins,omitempty"`
	DBUsers         []string            `json:"db_users,omitempty"`
	DBNames         []string            `json:"db_names,omitempty"`
	KubeGroups      []string            `json:"kubernetes_groups,omitempty"`
	MaxSessionTTL   string              `json:"max_session_ttl,omitempty"`
	DeniedBy        string              `json:"denied_by,omitempty"`
	Uncertain       []string            `json:"uncertain,omitempty"`
	NoLoginsMatched bool                `json:"matches_but_no_logins,omitempty"`
}

// Suggestion is a requestable role plus the broker's prediction.
type Suggestion struct {
	Role        string   `json:"role"`
	Prediction  string   `json:"prediction"` // auto_approve | require_approval | deny | unknown
	Rule        string   `json:"rule,omitempty"`
	Approvers   []string `json:"approver_roles,omitempty"`
	TTLCap      string   `json:"ttl_cap,omitempty"`
	TshCommand  string   `json:"tsh_command"`
	Description string   `json:"description,omitempty"`
}

// ExplainResult is the answer to "what role do I need for X?".
type ExplainResult struct {
	Resource       *teleport.Resource  `json:"resource,omitempty"`
	Ambiguous      []teleport.Resource `json:"ambiguous_matches,omitempty"`
	Grants         []RoleGrant         `json:"granting_roles"`
	HasNow         []string            `json:"has_now"`
	Requestable    []string            `json:"requestable"`
	NotRequestable []string            `json:"not_requestable"`
	Suggested      []Suggestion        `json:"suggested"`
	Notes          []string            `json:"notes,omitempty"`
}

// ResolveResource finds a unified resource by exact name (or hostname) and kind.
func ResolveResource(ctx context.Context, api teleport.API, name, kind string) (*teleport.Resource, []teleport.Resource, error) {
	req := &proto.ListUnifiedResourcesRequest{SearchKeywords: []string{name}, Limit: 50, SortBy: types.SortBy{Field: "name"}}
	if kind != "" {
		req.Kinds = []string{normalizeKind(kind)}
	}
	resp, err := api.ListUnifiedResources(ctx, req)
	if err != nil {
		return nil, nil, err
	}
	all := teleport.FlattenResources(resp)
	var exact []teleport.Resource
	for _, r := range all {
		if strings.EqualFold(r.Name, name) || strings.EqualFold(r.Hostname, name) {
			exact = append(exact, r)
		}
	}
	switch {
	case len(exact) == 1:
		return &exact[0], nil, nil
	case len(exact) > 1:
		return nil, exact, nil
	case len(all) == 1:
		return &all[0], nil, nil
	default:
		return nil, all, nil
	}
}

func normalizeKind(k string) string {
	switch strings.ToLower(k) {
	case "node", "server", "ssh":
		return types.KindNode
	case "db", "database":
		return types.KindDatabase
	case "kube", "kube_cluster", "kubernetes", "k8s":
		return types.KindKubernetesCluster
	case "app", "application":
		return types.KindApp
	case "desktop", "windows_desktop":
		return types.KindWindowsDesktop
	}
	return k
}

// Explain computes which roles grant access to the named resource and how the principal can get them.
func Explain(ctx context.Context, d Deps, principal, resourceName, kind string) (*ExplainResult, error) {
	res, ambiguous, err := ResolveResource(ctx, d.API, resourceName, kind)
	if err != nil {
		return nil, fmt.Errorf("resolve resource: %w", err)
	}
	if res == nil {
		return &ExplainResult{Ambiguous: ambiguous, Notes: []string{fmt.Sprintf("no unique resource named %q; pass kind or a more specific name", resourceName)}}, nil
	}
	user, err := d.API.GetUser(ctx, principal, false)
	if err != nil {
		return nil, fmt.Errorf("load user: %w", err)
	}
	roles, err := d.API.GetRoles(ctx)
	if err != nil {
		return nil, fmt.Errorf("list roles: %w", err)
	}
	caps, err := d.API.GetAccessCapabilities(ctx, types.AccessCapabilitiesRequest{User: principal, RequestableRoles: true})
	if err != nil {
		return nil, fmt.Errorf("access capabilities: %w", err)
	}
	active, _ := ActiveElevatedRoles(ctx, d.API, principal)

	out := &ExplainResult{Resource: res, HasNow: []string{}, Requestable: []string{}, NotRequestable: []string{}, Grants: []RoleGrant{}, Suggested: []Suggestion{}}
	held := set(user.GetRoles())
	for r := range active {
		held[r] = true
	}
	requestable := set(caps.RequestableRoles)

	for _, role := range roles {
		if hidden(role.GetName(), d.HideRolePrefixes) {
			continue
		}
		g := GrantFor(role, res, user.GetTraits())
		if g == nil {
			continue
		}
		out.Grants = append(out.Grants, *g)
		if g.DeniedBy != "" {
			continue
		}
		switch {
		case held[g.Role]:
			out.HasNow = append(out.HasNow, g.Role)
		case requestable[g.Role]:
			out.Requestable = append(out.Requestable, g.Role)
		default:
			out.NotRequestable = append(out.NotRequestable, g.Role)
		}
	}
	sort.Strings(out.HasNow)
	sort.Strings(out.Requestable)
	sort.Strings(out.NotRequestable)

	for _, r := range out.Requestable {
		s := Suggestion{Role: r, Prediction: "unknown", TshCommand: fmt.Sprintf("tsh request create --roles %s --reason '<why>'", r)}
		for _, g := range out.Grants {
			if g.Role == r {
				s.Description = g.Description
			}
		}
		if d.Policy != nil {
			dec := d.Policy.Evaluate(policy.EvalRequest{Requester: principal, Roles: []string{r}, ResourceLabels: []map[string]string{res.Labels}, Traits: user.GetTraits()})
			s.Prediction, s.Rule, s.Approvers = string(dec.Action), dec.Rule, dec.Approvers.TeleportRoles
			if dec.TTLCap > 0 {
				s.TTLCap = dec.TTLCap.String()
				s.TshCommand = fmt.Sprintf("tsh request create --roles %s --max-duration %s --reason '<why>'", r, shortDur(dec.TTLCap))
			}
		}
		out.Suggested = append(out.Suggested, s)
	}
	sort.SliceStable(out.Suggested, func(i, j int) bool { return rank(out.Suggested[i].Prediction) < rank(out.Suggested[j].Prediction) })
	if len(out.HasNow) > 0 {
		out.Notes = append(out.Notes, "you already hold a role that grants this resource")
	}
	if len(out.HasNow) == 0 && len(out.Requestable) == 0 {
		out.Notes = append(out.Notes, "no requestable role grants this resource; ask an administrator")
	}
	return out, nil
}

// GrantFor evaluates one role against one resource. Returns nil when the role is unrelated.
func GrantFor(role types.Role, res *teleport.Resource, traits map[string][]string) *RoleGrant {
	allowSel, denySel, principals := selectorsFor(role, res.Kind)
	if len(allowSel) == 0 && len(denySel) == 0 {
		return nil
	}
	g := &RoleGrant{Role: role.GetName(), Description: role.GetMetadata().Description}
	if ttl := role.GetOptions().MaxSessionTTL; ttl != 0 {
		g.MaxSessionTTL = ttl.Duration().String()
	}
	if expr := labelExpression(role, res.Kind); expr != "" {
		g.Uncertain = append(g.Uncertain, "role uses a labels_expression that cannot be evaluated here: "+expr)
	}
	// deny wins
	if len(denySel) > 0 {
		expanded, _ := ExpandTraits(denySel, traits)
		if ok, _ := MatchLabels(expanded, res.Labels); ok {
			g.DeniedBy = role.GetName()
			return g
		}
	}
	if len(allowSel) == 0 {
		return nil
	}
	expanded, unresolved := ExpandTraits(allowSel, traits)
	for _, u := range unresolved {
		g.Uncertain = append(g.Uncertain, "unresolved template in label selector: "+u)
	}
	ok, err := MatchLabels(expanded, res.Labels)
	if err != nil {
		g.Uncertain = append(g.Uncertain, err.Error())
	}
	if !ok {
		return nil
	}
	g.Matched = expanded
	g.Logins, g.DBUsers, g.DBNames, g.KubeGroups = principals.logins, principals.dbUsers, principals.dbNames, principals.kubeGroups
	if res.Kind == types.KindNode {
		exp, _ := ExpandTraits(map[string][]string{"logins": g.Logins}, traits)
		g.Logins = exp["logins"]
		if len(g.Logins) == 0 {
			g.NoLoginsMatched = true
		}
	}
	return g
}

type principals struct{ logins, dbUsers, dbNames, kubeGroups []string }

func selectorsFor(role types.Role, kind string) (allow, deny map[string][]string, p principals) {
	toMap := func(l types.Labels) map[string][]string {
		if len(l) == 0 {
			return nil
		}
		m := make(map[string][]string, len(l))
		for k, v := range l {
			m[k] = []string(v)
		}
		return m
	}
	switch kind {
	case types.KindNode:
		allow, deny = toMap(role.GetNodeLabels(types.Allow)), toMap(role.GetNodeLabels(types.Deny))
		p.logins = role.GetLogins(types.Allow)
	case types.KindDatabase:
		allow, deny = toMap(role.GetDatabaseLabels(types.Allow)), toMap(role.GetDatabaseLabels(types.Deny))
		p.dbUsers, p.dbNames = role.GetDatabaseUsers(types.Allow), role.GetDatabaseNames(types.Allow)
	case types.KindKubernetesCluster:
		allow, deny = toMap(role.GetKubernetesLabels(types.Allow)), toMap(role.GetKubernetesLabels(types.Deny))
		p.kubeGroups = role.GetKubeGroups(types.Allow)
	case types.KindApp:
		allow, deny = toMap(role.GetAppLabels(types.Allow)), toMap(role.GetAppLabels(types.Deny))
	case types.KindWindowsDesktop:
		if lm, err := role.GetLabelMatchers(types.Allow, types.KindWindowsDesktop); err == nil {
			allow = toMap(lm.Labels)
		}
		if lm, err := role.GetLabelMatchers(types.Deny, types.KindWindowsDesktop); err == nil {
			deny = toMap(lm.Labels)
		}
	}
	return allow, deny, p
}

func labelExpression(role types.Role, kind string) string {
	if lm, err := role.GetLabelMatchers(types.Allow, kind); err == nil {
		return lm.Expression
	}
	return ""
}

// ActiveElevatedRoles returns roles the user currently holds through approved, unexpired requests.
func ActiveElevatedRoles(ctx context.Context, api teleport.API, user string) (map[string]time.Time, error) {
	reqs, err := api.GetAccessRequests(ctx, types.AccessRequestFilter{User: user, State: types.RequestState_APPROVED})
	if err != nil {
		return nil, err
	}
	out := map[string]time.Time{}
	now := time.Now()
	for _, r := range reqs {
		if r.GetAccessExpiry().After(now) {
			for _, role := range r.GetRoles() {
				if cur, ok := out[role]; !ok || r.GetAccessExpiry().After(cur) {
					out[role] = r.GetAccessExpiry()
				}
			}
		}
	}
	return out, nil
}

func set(xs []string) map[string]bool {
	m := make(map[string]bool, len(xs))
	for _, x := range xs {
		m[x] = true
	}
	return m
}

func hidden(name string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

func rank(prediction string) int {
	switch prediction {
	case string(policy.ActionAutoApprove):
		return 0
	case string(policy.ActionRequireApproval):
		return 1
	case "unknown":
		return 2
	}
	return 3
}

func shortDur(d time.Duration) string {
	if d%time.Hour == 0 {
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return d.String()
}
