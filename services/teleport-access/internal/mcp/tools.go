package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/gravitational/teleport/api/client/proto"
	"github.com/gravitational/teleport/api/types"
	"github.com/gravitational/trace"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/dinho/k8s-teleport/services/teleport-access/internal/access"
	"github.com/dinho/k8s-teleport/services/teleport-access/internal/policy"
	"github.com/dinho/k8s-teleport/services/teleport-access/internal/teleport"
)

var hiddenRolePrefixes = []string{"bot-", "svc-", "wildcard-workload-identity", "terraform-provider", "operator", "list-access-request-resources", "mcp-user", "access-plugin"}

// ---- inputs (note: no identity fields anywhere)

type NameFilterIn struct {
	NameFilter string `json:"name_filter,omitempty" jsonschema:"optional substring filter on role names"`
}
type RoleNameIn struct {
	Name string `json:"name" jsonschema:"role name"`
}
type SearchIn struct {
	Query string `json:"query" jsonschema:"name, hostname or label text to search for"`
	Kind  string `json:"kind,omitempty" jsonschema:"optional: node|db|kube_cluster|app|windows_desktop"`
	Limit int    `json:"limit,omitempty" jsonschema:"max results (default 50)"`
}
type AccessibleIn struct {
	Kind   string `json:"kind,omitempty" jsonschema:"optional: node|db|kube_cluster|app|windows_desktop"`
	Search string `json:"search,omitempty" jsonschema:"optional search text"`
	Limit  int    `json:"limit,omitempty" jsonschema:"max results (default 100)"`
}
type ExplainIn struct {
	ResourceName string `json:"resource_name" jsonschema:"exact resource name or hostname, e.g. ssh-prod-0 or postgres-prod"`
	Kind         string `json:"kind,omitempty" jsonschema:"optional: node|db|kube_cluster|app|windows_desktop"`
}
type WhoCanApproveIn struct {
	Role         string `json:"role,omitempty" jsonschema:"role being requested"`
	ResourceName string `json:"resource_name,omitempty" jsonschema:"or: a resource; approvers of the minimal role granting it"`
}
type PolicyIn struct {
	Roles         []string `json:"roles" jsonschema:"roles that would be requested"`
	ResourceNames []string `json:"resource_names,omitempty" jsonschema:"optional resources the request targets"`
	TTL           string   `json:"ttl,omitempty" jsonschema:"requested duration, e.g. 2h"`
}
type CreateRequestIn struct {
	Roles       []string `json:"roles" jsonschema:"roles to request (from list_requestable_roles)"`
	ResourceIDs []string `json:"resource_ids,omitempty" jsonschema:"optional resource ids like /cluster/node/name (Enterprise resource requests)"`
	Reason      string   `json:"reason" jsonschema:"why access is needed; required, given by the person"`
	TTL         string   `json:"ttl,omitempty" jsonschema:"how long access is needed, e.g. 1h (default 2h)"`
	DryRun      bool     `json:"dry_run,omitempty" jsonschema:"validate without creating"`
}
type RequestIDIn struct {
	RequestID string `json:"request_id" jsonschema:"access request id (full or unique prefix)"`
}
type ListMyIn struct {
	State string `json:"state,omitempty" jsonschema:"optional: pending|approved|denied"`
}
type PendingIn struct {
	RoleFilter string `json:"role_filter,omitempty" jsonschema:"optional: only requests including this role"`
}

// ---- registration

func (s *Server) registerTools() {
	d := s.deps
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "whoami", Description: "Current user's Teleport roles, traits, effective access (label selectors, logins, db users, kube groups) and active elevated roles." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ empty) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return s.whoami(ctx, p) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "list_roles", Description: "List Teleport roles (name, description, what they select). Internal service roles are hidden." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in NameFilterIn) (*mcp.CallToolResult, any, error) {
			return s.wrap(func() (any, error) { return s.listRoles(ctx, in.NameFilter) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "describe_role", Description: "Full allow/deny detail of one role: label selectors, logins, db users/names, kube groups, rules, request/review settings, max session TTL." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in RoleNameIn) (*mcp.CallToolResult, any, error) {
			return s.wrap(func() (any, error) { return s.describeRole(ctx, in.Name) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "list_requestable_roles", Description: "Roles the current user may request, with the access broker's prediction (auto_approve / require_approval / deny) for each." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ empty) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return s.listRequestable(ctx, p) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "search_resources", Description: "Find servers, databases, Kubernetes clusters and apps by name or label. Results are limited to resources the current user holds or may request a role for (approvers see everything)." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in SearchIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return s.search(ctx, p, in) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "list_accessible_resources", Description: "Resources the current user can reach right now (computed from their roles' label selectors and active elevated roles). Marked approximate." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in AccessibleIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return s.accessible(ctx, p, in) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "explain_access", Description: "Which roles grant access to a resource, which of them the current user holds or may request, and how each request would be decided by policy. Use for 'what role do I need for X?'." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in ExplainIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) {
				return access.Explain(ctx, access.Deps{API: d.API, Policy: d.Policy, HideRolePrefixes: hiddenRolePrefixes}, p.TeleportUser, in.ResourceName, in.Kind)
			})
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "who_can_approve", Description: "Who may approve a request for a role (or for the role needed by a resource): approver roles from policy, users holding them, suggested reviewers." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in WhoCanApproveIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return s.whoCanApprove(ctx, p, in) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "get_approval_policy", Description: "Dry-run the access broker policy for a set of roles (and optional resources): auto_approve, require_approval or deny, approvers and TTL cap." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in PolicyIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return s.policyDryRun(ctx, p, in) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "create_access_request", Description: "Create a PENDING access request for the current user. Requires an explicit reason from the person. Returns the request id, the policy prediction and the equivalent tsh command. This tool never approves anything." + untrusted, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: ptr(false), IdempotentHint: false}},
		func(ctx context.Context, _ *mcp.CallToolRequest, in CreateRequestIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return s.createRequest(ctx, p, in) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "get_access_request", Description: "Status of one access request (own requests, or any request when the user is an approver)." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in RequestIDIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return s.getRequest(ctx, p, in.RequestID) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "list_my_access_requests", Description: "The current user's access requests, optionally filtered by state." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in ListMyIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return s.listMine(ctx, p, in.State) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "list_pending_requests", Description: "All pending access requests (approvers only)." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in PendingIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return s.listPending(ctx, p, in.RoleFilter) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "get_cluster_info", Description: "Teleport cluster name, version and edition, plus how approvals work here.", Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ empty) (*mcp.CallToolResult, any, error) {
			return s.wrap(func() (any, error) {
				return map[string]any{"cluster_name": d.ClusterName, "teleport_version": d.Version, "edition": d.Edition, "approval_model": approvalModel(d.Edition)}, nil
			})
		})
}

func ro() *mcp.ToolAnnotations { return &mcp.ToolAnnotations{ReadOnlyHint: true} }
func ptr[T any](v T) *T        { return &v }

func approvalModel(edition string) string {
	if edition == "enterprise" {
		return "Teleport Enterprise: Access Monitoring Rules auto-approve low-risk roles; approvers review in Slack/Teams or the web UI."
	}
	return "Community Edition: the access broker auto-approves low-risk roles per policy; high-risk requests are approved by users holding the approver role via chat buttons or tctl."
}

func (s *Server) withPrincipal(ctx context.Context, fn func(Principal) (any, error)) (*mcp.CallToolResult, any, error) {
	p, ok := PrincipalFrom(ctx)
	if !ok {
		return errResult("%s", ErrNoPrincipal.Error()), nil, nil
	}
	return s.wrap(func() (any, error) { return fn(p) })
}

func (s *Server) wrap(fn func() (any, error)) (*mcp.CallToolResult, any, error) {
	v, err := fn()
	if err != nil {
		s.deps.Log.Warn("tool error", "err", err)
		return errResult("%s", userFacing(err)), nil, nil
	}
	r, err := textResult(v)
	return r, nil, err
}

// userFacing maps errors to messages safe to show the model/user. Only well-typed Teleport errors
// carry their message; everything else is generic (details are logged by wrap).
func userFacing(err error) string {
	switch {
	case trace.IsAccessDenied(err):
		return "access denied by Teleport: " + trace.UserMessage(err)
	case trace.IsNotFound(err):
		return "not found: " + trace.UserMessage(err)
	case trace.IsBadParameter(err):
		return "invalid request: " + trace.UserMessage(err)
	case trace.IsLimitExceeded(err):
		return "rate limited: " + trace.UserMessage(err)
	case errors.Is(err, ErrNoPrincipal):
		return err.Error()
	}
	return "teleport error"
}

// ---- implementations

type roleSummary struct {
	Name          string              `json:"name"`
	Description   string              `json:"description,omitempty"`
	NodeLabels    map[string][]string `json:"node_labels,omitempty"`
	DBLabels      map[string][]string `json:"db_labels,omitempty"`
	KubeLabels    map[string][]string `json:"kubernetes_labels,omitempty"`
	AppLabels     map[string][]string `json:"app_labels,omitempty"`
	Logins        []string            `json:"logins,omitempty"`
	DBUsers       []string            `json:"db_users,omitempty"`
	DBNames       []string            `json:"db_names,omitempty"`
	KubeGroups    []string            `json:"kubernetes_groups,omitempty"`
	Requestable   []string            `json:"can_request_roles,omitempty"`
	CanReview     []string            `json:"can_review_roles,omitempty"`
	MaxSessionTTL string              `json:"max_session_ttl,omitempty"`
	Rules         []string            `json:"rules,omitempty"`
}

func summarize(r types.Role) roleSummary {
	toMap := func(l types.Labels) map[string][]string {
		if len(l) == 0 {
			return nil
		}
		m := map[string][]string{}
		for k, v := range l {
			m[k] = []string(v)
		}
		return m
	}
	rs := roleSummary{
		Name: r.GetName(), Description: r.GetMetadata().Description,
		NodeLabels: toMap(r.GetNodeLabels(types.Allow)), DBLabels: toMap(r.GetDatabaseLabels(types.Allow)),
		KubeLabels: toMap(r.GetKubernetesLabels(types.Allow)), AppLabels: toMap(r.GetAppLabels(types.Allow)),
		Logins: r.GetLogins(types.Allow), DBUsers: r.GetDatabaseUsers(types.Allow), DBNames: r.GetDatabaseNames(types.Allow), KubeGroups: r.GetKubeGroups(types.Allow),
		Requestable: r.GetAccessRequestConditions(types.Allow).Roles, CanReview: r.GetAccessReviewConditions(types.Allow).Roles,
	}
	if ttl := r.GetOptions().MaxSessionTTL; ttl != 0 {
		rs.MaxSessionTTL = ttl.Duration().String()
	}
	for _, rule := range r.GetRules(types.Allow) {
		rs.Rules = append(rs.Rules, fmt.Sprintf("%s: %s", strings.Join(rule.Resources, ","), strings.Join(rule.Verbs, ",")))
	}
	return rs
}

func (s *Server) whoami(ctx context.Context, p Principal) (any, error) {
	u, err := s.deps.API.GetUser(ctx, p.TeleportUser, false)
	if err != nil {
		return nil, err
	}
	active, _ := access.ActiveElevatedRoles(ctx, s.deps.API, p.TeleportUser)
	roles := []roleSummary{}
	names := append([]string{}, u.GetRoles()...)
	for r := range active {
		names = append(names, r)
	}
	sort.Strings(names)
	seen := map[string]bool{}
	for _, name := range names {
		if seen[name] {
			continue
		}
		seen[name] = true
		r, err := s.deps.API.GetRole(ctx, name)
		if err != nil {
			continue
		}
		roles = append(roles, summarize(r))
	}
	elevated := map[string]string{}
	for r, t := range active {
		elevated[r] = t.UTC().Format(time.RFC3339)
	}
	isApprover := false
	for _, r := range names {
		for _, a := range s.deps.ApproverRoles {
			if r == a {
				isApprover = true
			}
		}
	}
	return map[string]any{
		"user": p.TeleportUser, "email": p.Email, "roles": u.GetRoles(), "traits": u.GetTraits(),
		"active_elevated_roles": elevated, "is_approver": isApprover, "effective_access": roles,
		"note": "Roles without label selectors grant no infrastructure access (e.g. requester). Use list_requestable_roles to see what can be requested.",
	}, nil
}

func (s *Server) listRoles(ctx context.Context, filter string) (any, error) {
	roles, err := s.deps.API.GetRoles(ctx)
	if err != nil {
		return nil, err
	}
	out := []roleSummary{}
	for _, r := range roles {
		if isHidden(r.GetName()) || (filter != "" && !strings.Contains(r.GetName(), filter)) {
			continue
		}
		out = append(out, summarize(r))
	}
	return map[string]any{"roles": out}, nil
}

func isHidden(name string) bool {
	for _, p := range hiddenRolePrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

func (s *Server) describeRole(ctx context.Context, name string) (any, error) {
	if isHidden(name) {
		return nil, trace.NotFound("role %q not found", name)
	}
	r, err := s.deps.API.GetRole(ctx, name)
	if err != nil {
		return nil, err
	}
	rs := summarize(r)
	deny := map[string]any{}
	if l := r.GetNodeLabels(types.Deny); len(l) > 0 {
		deny["node_labels"] = l
	}
	if l := r.GetDatabaseLabels(types.Deny); len(l) > 0 {
		deny["db_labels"] = l
	}
	if l := r.GetKubernetesLabels(types.Deny); len(l) > 0 {
		deny["kubernetes_labels"] = l
	}
	if l := r.GetAppLabels(types.Deny); len(l) > 0 {
		deny["app_labels"] = l
	}
	return map[string]any{"role": rs, "deny": deny, "kubernetes_resources": r.GetKubeResources(types.Allow)}, nil
}

type requestableRole struct {
	Role        string   `json:"role"`
	Description string   `json:"description,omitempty"`
	Prediction  string   `json:"prediction"`
	Rule        string   `json:"rule,omitempty"`
	Approvers   []string `json:"approver_roles,omitempty"`
	TTLCap      string   `json:"ttl_cap,omitempty"`
}

func (s *Server) listRequestable(ctx context.Context, p Principal) (any, error) {
	caps, err := s.deps.API.GetAccessCapabilities(ctx, types.AccessCapabilitiesRequest{User: p.TeleportUser, RequestableRoles: true, SuggestedReviewers: true})
	if err != nil {
		return nil, err
	}
	u, _ := s.deps.API.GetUser(ctx, p.TeleportUser, false)
	var traits map[string][]string
	if u != nil {
		traits = u.GetTraits()
	}
	out := []requestableRole{}
	for _, name := range caps.RequestableRoles {
		rr := requestableRole{Role: name, Prediction: "unknown"}
		if r, err := s.deps.API.GetRole(ctx, name); err == nil {
			rr.Description = r.GetMetadata().Description
		}
		if s.deps.Policy != nil {
			dec := s.deps.Policy.Evaluate(policy.EvalRequest{Requester: p.TeleportUser, Roles: []string{name}, Traits: traits})
			rr.Prediction, rr.Rule, rr.Approvers = string(dec.Action), dec.Rule, dec.Approvers.TeleportRoles
			if dec.TTLCap > 0 {
				rr.TTLCap = dec.TTLCap.String()
			}
		}
		out = append(out, rr)
	}
	return map[string]any{"requestable_roles": out, "suggested_reviewers": caps.SuggestedReviewers, "require_reason": caps.RequireReason}, nil
}

// search lists resources by keyword. Non-approvers only see resources that some role they hold,
// hold through an active request, or may request would grant (label selectors, ignoring logins),
// so the inventory is scoped to what the user could legitimately reach; approvers see everything
// because they review requests for any resource.
func (s *Server) search(ctx context.Context, p Principal, in SearchIn) (any, error) {
	limit := in.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if utf8.RuneCountInString(in.Query) > 256 {
		return nil, trace.BadParameter("query too long")
	}
	req := &proto.ListUnifiedResourcesRequest{SearchKeywords: strings.Fields(in.Query), Limit: int32(limit), SortBy: types.SortBy{Field: "name"}}
	if in.Kind != "" {
		req.Kinds = []string{normalizeKind(in.Kind)}
	}
	resp, err := s.deps.API.ListUnifiedResources(ctx, req)
	if err != nil {
		return nil, err
	}
	all := teleport.FlattenResources(resp)
	if s.isApprover(ctx, p.TeleportUser) {
		return map[string]any{"resources": all}, nil
	}
	roles, traits, err := s.reachableRoles(ctx, p)
	if err != nil {
		return nil, err
	}
	out := []teleport.Resource{}
	for i := range all {
		for _, r := range roles {
			if g := access.GrantFor(r, &all[i], traits); g != nil && g.DeniedBy == "" {
				out = append(out, all[i])
				break
			}
		}
	}
	return map[string]any{"resources": out, "scoped": true, "note": "Only resources reachable through roles you hold or may request are listed."}, nil
}

// reachableRoles returns the role objects the user holds, holds through active requests, or may
// request, plus their traits.
func (s *Server) reachableRoles(ctx context.Context, p Principal) ([]types.Role, map[string][]string, error) {
	u, err := s.deps.API.GetUser(ctx, p.TeleportUser, false)
	if err != nil {
		return nil, nil, err
	}
	names := append([]string{}, u.GetRoles()...)
	if active, err := access.ActiveElevatedRoles(ctx, s.deps.API, p.TeleportUser); err == nil {
		for r := range active {
			names = append(names, r)
		}
	}
	if caps, err := s.deps.API.GetAccessCapabilities(ctx, types.AccessCapabilitiesRequest{User: p.TeleportUser, RequestableRoles: true}); err == nil && caps != nil {
		names = append(names, caps.RequestableRoles...)
	}
	seen := map[string]bool{}
	var roles []types.Role
	for _, n := range names {
		if seen[n] {
			continue
		}
		seen[n] = true
		if r, err := s.deps.API.GetRole(ctx, n); err == nil {
			roles = append(roles, r)
		}
	}
	return roles, u.GetTraits(), nil
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

func (s *Server) accessible(ctx context.Context, p Principal, in AccessibleIn) (any, error) {
	u, err := s.deps.API.GetUser(ctx, p.TeleportUser, false)
	if err != nil {
		return nil, err
	}
	active, _ := access.ActiveElevatedRoles(ctx, s.deps.API, p.TeleportUser)
	var roles []types.Role
	names := append([]string{}, u.GetRoles()...)
	for r := range active {
		names = append(names, r)
	}
	for _, n := range names {
		if r, err := s.deps.API.GetRole(ctx, n); err == nil {
			roles = append(roles, r)
		}
	}
	limit := in.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	req := &proto.ListUnifiedResourcesRequest{Limit: int32(limit), SortBy: types.SortBy{Field: "name"}}
	if in.Kind != "" {
		req.Kinds = []string{normalizeKind(in.Kind)}
	}
	if in.Search != "" {
		req.SearchKeywords = strings.Fields(in.Search)
	}
	resp, err := s.deps.API.ListUnifiedResources(ctx, req)
	if err != nil {
		return nil, err
	}
	type hit struct {
		teleport.Resource
		Via []string `json:"via_roles"`
	}
	out := []hit{}
	for _, res := range teleport.FlattenResources(resp) {
		var via []string
		denied := false
		for _, r := range roles {
			g := access.GrantFor(r, &res, u.GetTraits())
			if g == nil {
				continue
			}
			if g.DeniedBy != "" {
				denied = true
				break
			}
			if !g.NoLoginsMatched {
				via = append(via, g.Role)
			}
		}
		if !denied && len(via) > 0 {
			out = append(out, hit{Resource: res, Via: via})
		}
	}
	return map[string]any{"resources": out, "approximate": true, "note": "Computed from role label selectors; the authoritative list is `tsh ls` / `tsh db ls` / `tsh apps ls` / `tsh kube ls`."}, nil
}

func (s *Server) whoCanApprove(ctx context.Context, p Principal, in WhoCanApproveIn) (any, error) {
	role := in.Role
	if role == "" && in.ResourceName != "" {
		ex, err := access.Explain(ctx, access.Deps{API: s.deps.API, Policy: s.deps.Policy, HideRolePrefixes: hiddenRolePrefixes}, p.TeleportUser, in.ResourceName, "")
		if err != nil {
			return nil, err
		}
		if len(ex.Suggested) == 0 {
			return map[string]any{"note": "no requestable role grants that resource", "explain": ex}, nil
		}
		role = ex.Suggested[0].Role
	}
	if role == "" {
		return nil, trace.BadParameter("provide role or resource_name")
	}
	approverRoles := append([]string{}, s.deps.ApproverRoles...)
	var rule, action string
	if s.deps.Policy != nil {
		dec := s.deps.Policy.Evaluate(policy.EvalRequest{Requester: p.TeleportUser, Roles: []string{role}})
		rule, action = dec.Rule, string(dec.Action)
		if len(dec.Approvers.TeleportRoles) > 0 {
			approverRoles = dec.Approvers.TeleportRoles
		}
	}
	// Enterprise: roles with review_requests covering this role.
	if roles, err := s.deps.API.GetRoles(ctx); err == nil {
		for _, r := range roles {
			for _, rev := range r.GetAccessReviewConditions(types.Allow).Roles {
				if rev == role || rev == "*" {
					approverRoles = appendUnique(approverRoles, r.GetName())
				}
			}
		}
	}
	holders := []string{}
	if users, err := s.deps.API.GetUsers(ctx, false); err == nil {
		for _, u := range users {
			if strings.HasPrefix(u.GetName(), "bot-") {
				continue
			}
			for _, r := range u.GetRoles() {
				for _, a := range approverRoles {
					if r == a {
						holders = appendUnique(holders, u.GetName())
					}
				}
			}
		}
	}
	sort.Strings(holders)
	if len(holders) > 25 {
		holders = holders[:25]
	}
	caps, _ := s.deps.API.GetAccessCapabilities(ctx, types.AccessCapabilitiesRequest{User: p.TeleportUser, SuggestedReviewers: true})
	var suggested []string
	if caps != nil {
		suggested = caps.SuggestedReviewers
	}
	return map[string]any{"role": role, "policy_action": action, "policy_rule": rule, "approver_roles": approverRoles, "approvers": holders, "suggested_reviewers": suggested,
		"how": "Approvers click Approve on the request card in chat, or run: tctl request approve <id>"}, nil
}

func (s *Server) policyDryRun(ctx context.Context, p Principal, in PolicyIn) (any, error) {
	if s.deps.Policy == nil {
		return map[string]any{"prediction": "unknown", "note": "no broker policy loaded"}, nil
	}
	var labels []map[string]string
	for _, name := range in.ResourceNames {
		res, _, err := access.ResolveResource(ctx, s.deps.API, name, "")
		if err == nil && res != nil {
			labels = append(labels, res.Labels)
		}
	}
	var traits map[string][]string
	if u, err := s.deps.API.GetUser(ctx, p.TeleportUser, false); err == nil {
		traits = u.GetTraits()
	}
	var ttl time.Duration
	if in.TTL != "" {
		d, err := time.ParseDuration(in.TTL)
		if err != nil {
			return nil, trace.BadParameter("ttl: %v", err)
		}
		ttl = d
	}
	dec := s.deps.Policy.Evaluate(policy.EvalRequest{Requester: p.TeleportUser, Roles: in.Roles, ResourceLabels: labels, Traits: traits, RequestedTTL: ttl})
	return map[string]any{"prediction": dec.Action, "rule": dec.Rule, "reason": dec.Reason, "ttl_cap": dec.TTLCap.String(), "approvers": dec.Approvers}, nil
}

type requestView struct {
	ID          string              `json:"id"`
	User        string              `json:"user"`
	Roles       []string            `json:"roles"`
	ResourceIDs []string            `json:"resource_ids,omitempty"`
	Reason      string              `json:"reason"`
	State       string              `json:"state"`
	Created     string              `json:"created"`
	Expires     string              `json:"expires"`
	Resolution  string              `json:"resolve_reason,omitempty"`
	Reviews     []string            `json:"reviews,omitempty"`
	Annotations map[string][]string `json:"annotations,omitempty"`
}

func viewRequest(r types.AccessRequest) requestView {
	v := requestView{ID: r.GetName(), User: r.GetUser(), Roles: r.GetRoles(), Reason: r.GetRequestReason(), State: stateString(r.GetState()),
		Created: r.GetCreationTime().UTC().Format(time.RFC3339), Expires: r.GetAccessExpiry().UTC().Format(time.RFC3339), Resolution: r.GetResolveReason(), Annotations: r.GetResolveAnnotations()}
	for _, id := range r.GetRequestedResourceIDs() {
		v.ResourceIDs = append(v.ResourceIDs, types.ResourceIDToString(id))
	}
	for _, rev := range r.GetReviews() {
		v.Reviews = append(v.Reviews, fmt.Sprintf("%s: %s (%s)", rev.Author, stateString(rev.ProposedState), rev.Reason))
	}
	return v
}

func stateString(s types.RequestState) string {
	switch s {
	case types.RequestState_PENDING:
		return "PENDING"
	case types.RequestState_APPROVED:
		return "APPROVED"
	case types.RequestState_DENIED:
		return "DENIED"
	case types.RequestState_PROMOTED:
		return "PROMOTED"
	}
	return s.String()
}

func parseState(s string) types.RequestState {
	switch strings.ToUpper(s) {
	case "PENDING":
		return types.RequestState_PENDING
	case "APPROVED":
		return types.RequestState_APPROVED
	case "DENIED":
		return types.RequestState_DENIED
	}
	return types.RequestState_NONE
}

// Limits on create_access_request inputs.
const (
	minReasonLen    = 8
	maxReasonLen    = 512
	maxRequestTTL   = 4 * time.Hour
	defaultTTL      = 2 * time.Hour
	maxRolesPerReq  = 20
	maxResourcesReq = 20
)

// cleanReason strips control characters and trims whitespace.
func cleanReason(s string) string {
	var sb strings.Builder
	for _, r := range s {
		if unicode.IsControl(r) || r == utf8.RuneError {
			if r == '\n' || r == '\t' {
				sb.WriteRune(' ')
			}
			continue
		}
		sb.WriteRune(r)
	}
	return strings.TrimSpace(sb.String())
}

func (s *Server) createRequest(ctx context.Context, p Principal, in CreateRequestIn) (any, error) {
	if !s.limiters.allow(p.TeleportUser) {
		return nil, trace.LimitExceeded("too many access requests created recently; try again later")
	}
	reason := cleanReason(in.Reason)
	if n := utf8.RuneCountInString(reason); n < minReasonLen || n > maxReasonLen {
		return nil, trace.BadParameter("a reason of %d-%d characters is required; ask the person why they need access", minReasonLen, maxReasonLen)
	}
	if len(in.Roles) == 0 && len(in.ResourceIDs) == 0 {
		return nil, trace.BadParameter("at least one role (or resource id) is required")
	}
	if len(in.Roles) > maxRolesPerReq || len(in.ResourceIDs) > maxResourcesReq {
		return nil, trace.BadParameter("too many roles or resources in one request")
	}
	// Every role must be requestable by this user per Teleport (not just per our policy).
	caps, err := s.deps.API.GetAccessCapabilities(ctx, types.AccessCapabilitiesRequest{User: p.TeleportUser, RequestableRoles: true})
	if err != nil {
		return nil, err
	}
	roles := []string{}
	for _, role := range in.Roles {
		role = strings.TrimSpace(role)
		if role == "" || contains(roles, role) {
			continue
		}
		if caps == nil || !contains(caps.RequestableRoles, role) || isHidden(role) {
			return nil, trace.BadParameter("role %q is not requestable by this user; use list_requestable_roles", role)
		}
		roles = append(roles, role)
	}
	if len(roles) == 0 && len(in.ResourceIDs) == 0 {
		return nil, trace.BadParameter("at least one role is required")
	}
	ttl := defaultTTL
	if in.TTL != "" {
		d, err := time.ParseDuration(in.TTL)
		if err != nil || d <= 0 {
			return nil, trace.BadParameter("ttl must be a duration like 1h or 30m")
		}
		ttl = d
	}
	requestedTTL := ttl
	if ttl > maxRequestTTL {
		ttl = maxRequestTTL
	}
	var resources []types.ResourceAccessID
	for _, raw := range in.ResourceIDs {
		ids, err := types.ResourceIDsFromString(raw)
		if err != nil {
			return nil, trace.BadParameter("resource id %q: %v", raw, err)
		}
		for _, id := range ids {
			resources = append(resources, types.ResourceAccessID{Id: id})
		}
	}
	var prediction any
	if s.deps.Policy != nil {
		var traits map[string][]string
		if u, err := s.deps.API.GetUser(ctx, p.TeleportUser, false); err == nil {
			traits = u.GetTraits()
		}
		dec := s.deps.Policy.Evaluate(policy.EvalRequest{Requester: p.TeleportUser, Roles: roles, Traits: traits, RequestedTTL: ttl})
		if dec.TTLCap > 0 && dec.TTLCap < ttl {
			ttl = dec.TTLCap
		}
		prediction = map[string]any{"action": dec.Action, "rule": dec.Rule, "reason": dec.Reason, "ttl_cap": dec.TTLCap.String(), "approvers": dec.Approvers.TeleportRoles}
		if dec.Action == policy.ActionDeny && !in.DryRun {
			return nil, trace.BadParameter("policy denies this request (%s); it was not created", dec.Reason)
		}
	}
	req, err := types.NewAccessRequestWithResources(uuid.NewString(), p.TeleportUser, roles, resources)
	if err != nil {
		return nil, err
	}
	req.SetRequestReason(reason)
	req.SetAccessExpiry(time.Now().Add(ttl))
	req.SetMaxDuration(time.Now().Add(ttl))
	req.SetDryRun(in.DryRun)
	tsh := fmt.Sprintf("tsh request create --roles %s --max-duration %s --reason %q", strings.Join(roles, ","), shortDur(ttl), reason)
	created, err := s.deps.API.CreateAccessRequestV2(ctx, req)
	if err != nil {
		// Fall back to telling the person how to do it themselves.
		s.deps.Log.Warn("create access request failed", "user", p.TeleportUser, "roles", roles, "err", err)
		return map[string]any{"created": false, "error": userFacing(err), "tsh_command": tsh, "prediction": prediction}, nil
	}
	s.deps.Log.Info("access request created", "request_id", created.GetName(), "user", p.TeleportUser, "roles", roles, "ttl", ttl.String(), "dry_run", in.DryRun)
	out := map[string]any{"created": !in.DryRun, "dry_run": in.DryRun, "request": viewRequest(created), "prediction": prediction, "tsh_command": tsh,
		"note": "The request is PENDING until the access broker or an approver decides. Check with get_access_request."}
	if ttl != requestedTTL {
		out["ttl_clamped_from"] = requestedTTL.String()
		out["ttl"] = ttl.String()
	}
	return out, nil
}

func shortDur(d time.Duration) string {
	if d%time.Hour == 0 {
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return d.String()
}

func (s *Server) isApprover(ctx context.Context, user string) bool {
	u, err := s.deps.API.GetUser(ctx, user, false)
	if err != nil {
		return false
	}
	for _, r := range u.GetRoles() {
		for _, a := range s.deps.ApproverRoles {
			if r == a {
				return true
			}
		}
	}
	return false
}

func (s *Server) findRequest(ctx context.Context, id string) (types.AccessRequest, error) {
	if len(id) >= 36 {
		reqs, err := s.deps.API.GetAccessRequests(ctx, types.AccessRequestFilter{ID: id})
		if err != nil {
			return nil, err
		}
		if len(reqs) == 1 {
			return reqs[0], nil
		}
	}
	all, err := s.deps.API.GetAccessRequests(ctx, types.AccessRequestFilter{})
	if err != nil {
		return nil, err
	}
	var match types.AccessRequest
	for _, r := range all {
		if strings.HasPrefix(r.GetName(), id) {
			if match != nil {
				return nil, trace.BadParameter("request id prefix %q is ambiguous", id)
			}
			match = r
		}
	}
	if match == nil {
		return nil, trace.NotFound("no access request %q", id)
	}
	return match, nil
}

func (s *Server) getRequest(ctx context.Context, p Principal, id string) (any, error) {
	r, err := s.findRequest(ctx, id)
	if err != nil {
		return nil, err
	}
	if r.GetUser() != p.TeleportUser && !s.isApprover(ctx, p.TeleportUser) {
		return nil, trace.NotFound("no access request %q", id)
	}
	return viewRequest(r), nil
}

func (s *Server) listMine(ctx context.Context, p Principal, state string) (any, error) {
	reqs, err := s.deps.API.GetAccessRequests(ctx, types.AccessRequestFilter{User: p.TeleportUser, State: parseState(state)})
	if err != nil {
		return nil, err
	}
	out := []requestView{}
	for _, r := range reqs {
		out = append(out, viewRequest(r))
	}
	return map[string]any{"requests": out}, nil
}

func (s *Server) listPending(ctx context.Context, p Principal, roleFilter string) (any, error) {
	if !s.isApprover(ctx, p.TeleportUser) {
		return nil, trace.AccessDenied("only approvers can list other users' pending requests")
	}
	reqs, err := s.deps.API.GetAccessRequests(ctx, types.AccessRequestFilter{State: types.RequestState_PENDING})
	if err != nil {
		return nil, err
	}
	out := []requestView{}
	for _, r := range reqs {
		if roleFilter != "" && !contains(r.GetRoles(), roleFilter) {
			continue
		}
		out = append(out, viewRequest(r))
	}
	return map[string]any{"requests": out}, nil
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func appendUnique(xs []string, x string) []string {
	if contains(xs, x) {
		return xs
	}
	return append(xs, x)
}
