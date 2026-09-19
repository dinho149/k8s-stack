package accessapi

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/gravitational/teleport/api/client/proto"
	"github.com/gravitational/teleport/api/types"
	"github.com/gravitational/trace"

	"github.com/yeaboi/k8s-stack/internal/teleportaccess/access"
	"github.com/yeaboi/k8s-stack/internal/teleportaccess/policy"
	"github.com/yeaboi/k8s-stack/internal/teleportaccess/teleport"
)

// Resource is re-exported so callers of this package need not import the teleport package.
type Resource = teleport.Resource

// Deps are the collaborators of a Service.
type Deps struct {
	API         teleport.API
	Policy      *policy.Engine // optional: adds broker predictions
	Log         *slog.Logger
	Edition     string
	ClusterName string
	Version     string
	// ApproverRoles: roles whose holders may list others' pending requests and read any request.
	ApproverRoles []string
	// Limiter bounds CreateRequest per user; nil creates a fresh one.
	Limiter *Limiter
}

// Service answers access questions and creates requests for a principal.
type Service struct {
	d Deps
}

// New builds a Service, filling defaults.
func New(d Deps) *Service {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if len(d.ApproverRoles) == 0 {
		d.ApproverRoles = []string{"approver"}
	}
	if d.Limiter == nil {
		d.Limiter = NewLimiter()
	}
	return &Service{d: d}
}

// ClusterInfo needs no principal.
func (s *Service) ClusterInfo() ClusterInfo {
	return ClusterInfo{ClusterName: s.d.ClusterName, TeleportVersion: s.d.Version, Edition: s.d.Edition, ApprovalModel: ApprovalModel(s.d.Edition)}
}

func summarize(r types.Role) RoleSummary {
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
	rs := RoleSummary{
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

// Whoami describes the principal: roles, traits, active grants and effective access.
func (s *Service) Whoami(ctx context.Context, p Principal) (*Whoami, error) {
	u, err := s.d.API.GetUser(ctx, p.TeleportUser, false)
	if err != nil {
		return nil, err
	}
	active, _ := access.ActiveElevatedRoles(ctx, s.d.API, p.TeleportUser)
	roles := []RoleSummary{}
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
		r, err := s.d.API.GetRole(ctx, name)
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
		for _, a := range s.d.ApproverRoles {
			if r == a {
				isApprover = true
			}
		}
	}
	return &Whoami{
		User: p.TeleportUser, Email: p.Email, Roles: u.GetRoles(), Traits: u.GetTraits(),
		ActiveElevatedRoles: elevated, IsApprover: isApprover, EffectiveAccess: roles,
		Note: "Roles without label selectors grant no infrastructure access (e.g. requester). Use list_requestable_roles to see what can be requested.",
	}, nil
}

// ListRoles lists the catalog (internal roles hidden), optionally filtered by a name substring.
func (s *Service) ListRoles(ctx context.Context, filter string) (*RoleList, error) {
	roles, err := s.d.API.GetRoles(ctx)
	if err != nil {
		return nil, err
	}
	out := []RoleSummary{}
	for _, r := range roles {
		if IsHidden(r.GetName()) || (filter != "" && !strings.Contains(r.GetName(), filter)) {
			continue
		}
		out = append(out, summarize(r))
	}
	return &RoleList{Roles: out}, nil
}

// DescribeRole returns one role in full; hidden roles are reported as not found.
func (s *Service) DescribeRole(ctx context.Context, name string) (*RoleDetail, error) {
	if IsHidden(name) {
		return nil, trace.NotFound("role %q not found", name)
	}
	r, err := s.d.API.GetRole(ctx, name)
	if err != nil {
		return nil, err
	}
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
	return &RoleDetail{Role: summarize(r), Deny: deny, KubernetesResources: r.GetKubeResources(types.Allow)}, nil
}

// ListRequestable lists the roles Teleport lets the principal request, with policy predictions.
func (s *Service) ListRequestable(ctx context.Context, p Principal) (*RequestableList, error) {
	caps, err := s.d.API.GetAccessCapabilities(ctx, types.AccessCapabilitiesRequest{User: p.TeleportUser, RequestableRoles: true, SuggestedReviewers: true})
	if err != nil {
		return nil, err
	}
	u, _ := s.d.API.GetUser(ctx, p.TeleportUser, false)
	var traits map[string][]string
	if u != nil {
		traits = u.GetTraits()
	}
	out := []RequestableRole{}
	for _, name := range caps.RequestableRoles {
		rr := RequestableRole{Role: name, Prediction: "unknown"}
		if r, err := s.d.API.GetRole(ctx, name); err == nil {
			rr.Description = r.GetMetadata().Description
		}
		if s.d.Policy != nil {
			dec := s.d.Policy.Evaluate(policy.EvalRequest{Requester: p.TeleportUser, Roles: []string{name}, Traits: traits})
			rr.Prediction, rr.Rule, rr.Approvers = string(dec.Action), dec.Rule, dec.Approvers.TeleportRoles
			if dec.TTLCap > 0 {
				rr.TTLCap = dec.TTLCap.String()
			}
		}
		out = append(out, rr)
	}
	return &RequestableList{RequestableRoles: out, SuggestedReviewers: caps.SuggestedReviewers, RequireReason: caps.RequireReason}, nil
}

// Search lists resources by keyword. Non-approvers only see resources that some role they hold,
// hold through an active request, or may request would grant (label selectors, ignoring logins),
// so the inventory is scoped to what the user could legitimately reach; approvers see everything
// because they review requests for any resource.
func (s *Service) Search(ctx context.Context, p Principal, in SearchIn) (*ResourceList, error) {
	limit := in.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if utf8.RuneCountInString(in.Query) > 256 {
		return nil, trace.BadParameter("query too long")
	}
	req := &proto.ListUnifiedResourcesRequest{SearchKeywords: strings.Fields(in.Query), Limit: int32(limit), SortBy: types.SortBy{Field: "name"}}
	if in.Kind != "" {
		req.Kinds = []string{NormalizeKind(in.Kind)}
	}
	resp, err := s.d.API.ListUnifiedResources(ctx, req)
	if err != nil {
		return nil, err
	}
	all := teleport.FlattenResources(resp)
	if s.IsApprover(ctx, p.TeleportUser) {
		return &ResourceList{Resources: all}, nil
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
	return &ResourceList{Resources: out, Scoped: true, Note: "Only resources reachable through roles you hold or may request are listed."}, nil
}

// reachableRoles returns the role objects the user holds, holds through active requests, or may
// request, plus their traits.
func (s *Service) reachableRoles(ctx context.Context, p Principal) ([]types.Role, map[string][]string, error) {
	u, err := s.d.API.GetUser(ctx, p.TeleportUser, false)
	if err != nil {
		return nil, nil, err
	}
	names := append([]string{}, u.GetRoles()...)
	if active, err := access.ActiveElevatedRoles(ctx, s.d.API, p.TeleportUser); err == nil {
		for r := range active {
			names = append(names, r)
		}
	}
	if caps, err := s.d.API.GetAccessCapabilities(ctx, types.AccessCapabilitiesRequest{User: p.TeleportUser, RequestableRoles: true}); err == nil && caps != nil {
		names = append(names, caps.RequestableRoles...)
	}
	seen := map[string]bool{}
	var roles []types.Role
	for _, n := range names {
		if seen[n] {
			continue
		}
		seen[n] = true
		if r, err := s.d.API.GetRole(ctx, n); err == nil {
			roles = append(roles, r)
		}
	}
	return roles, u.GetTraits(), nil
}

// Accessible lists what the principal can reach now, computed from label selectors (approximate).
func (s *Service) Accessible(ctx context.Context, p Principal, in AccessibleIn) (*AccessibleList, error) {
	u, err := s.d.API.GetUser(ctx, p.TeleportUser, false)
	if err != nil {
		return nil, err
	}
	active, _ := access.ActiveElevatedRoles(ctx, s.d.API, p.TeleportUser)
	var roles []types.Role
	names := append([]string{}, u.GetRoles()...)
	for r := range active {
		names = append(names, r)
	}
	for _, n := range names {
		if r, err := s.d.API.GetRole(ctx, n); err == nil {
			roles = append(roles, r)
		}
	}
	limit := in.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	req := &proto.ListUnifiedResourcesRequest{Limit: int32(limit), SortBy: types.SortBy{Field: "name"}}
	if in.Kind != "" {
		req.Kinds = []string{NormalizeKind(in.Kind)}
	}
	if in.Search != "" {
		req.SearchKeywords = strings.Fields(in.Search)
	}
	resp, err := s.d.API.ListUnifiedResources(ctx, req)
	if err != nil {
		return nil, err
	}
	out := []AccessibleHit{}
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
			out = append(out, AccessibleHit{Resource: res, Via: via})
		}
	}
	return &AccessibleList{Resources: out, Approximate: true, Note: "Computed from role label selectors; the authoritative list is `tsh ls` / `tsh db ls` / `tsh apps ls` / `tsh kube ls`."}, nil
}

// Explain answers "what role do I need for this resource?".
func (s *Service) Explain(ctx context.Context, p Principal, resourceName, kind string) (*access.ExplainResult, error) {
	return access.Explain(ctx, access.Deps{API: s.d.API, Policy: s.d.Policy, HideRolePrefixes: HiddenRolePrefixes}, p.TeleportUser, resourceName, kind)
}

// WhoCanApprove lists approver roles and their holders for a role (or the role a resource needs).
func (s *Service) WhoCanApprove(ctx context.Context, p Principal, in WhoCanApproveIn) (*ApproverInfo, error) {
	role := in.Role
	if role == "" && in.ResourceName != "" {
		ex, err := s.Explain(ctx, p, in.ResourceName, "")
		if err != nil {
			return nil, err
		}
		if len(ex.Suggested) == 0 {
			return &ApproverInfo{Note: "no requestable role grants that resource", Explain: ex}, nil
		}
		role = ex.Suggested[0].Role
	}
	if role == "" {
		return nil, trace.BadParameter("provide role or resource_name")
	}
	approverRoles := append([]string{}, s.d.ApproverRoles...)
	var rule, action string
	if s.d.Policy != nil {
		dec := s.d.Policy.Evaluate(policy.EvalRequest{Requester: p.TeleportUser, Roles: []string{role}})
		rule, action = dec.Rule, string(dec.Action)
		if len(dec.Approvers.TeleportRoles) > 0 {
			approverRoles = dec.Approvers.TeleportRoles
		}
	}
	// Enterprise: roles with review_requests covering this role.
	if roles, err := s.d.API.GetRoles(ctx); err == nil {
		for _, r := range roles {
			for _, rev := range r.GetAccessReviewConditions(types.Allow).Roles {
				if rev == role || rev == "*" {
					approverRoles = appendUnique(approverRoles, r.GetName())
				}
			}
		}
	}
	holders := []string{}
	if users, err := s.d.API.GetUsers(ctx, false); err == nil {
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
	caps, _ := s.d.API.GetAccessCapabilities(ctx, types.AccessCapabilitiesRequest{User: p.TeleportUser, SuggestedReviewers: true})
	var suggested []string
	if caps != nil {
		suggested = caps.SuggestedReviewers
	}
	return &ApproverInfo{Role: role, PolicyAction: action, PolicyRule: rule, ApproverRoles: approverRoles, Approvers: holders, SuggestedReviewers: suggested,
		How: "Approvers click Approve on the request card in chat, or run: tctl request approve <id>"}, nil
}

// PolicyDryRun evaluates the broker policy for roles (and optional resources) without creating anything.
func (s *Service) PolicyDryRun(ctx context.Context, p Principal, in PolicyIn) (*PolicyResult, error) {
	if s.d.Policy == nil {
		return &PolicyResult{Prediction: "unknown", Note: "no broker policy loaded"}, nil
	}
	var labels []map[string]string
	for _, name := range in.ResourceNames {
		res, _, err := access.ResolveResource(ctx, s.d.API, name, "")
		if err == nil && res != nil {
			labels = append(labels, res.Labels)
		}
	}
	var traits map[string][]string
	if u, err := s.d.API.GetUser(ctx, p.TeleportUser, false); err == nil {
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
	dec := s.d.Policy.Evaluate(policy.EvalRequest{Requester: p.TeleportUser, Roles: in.Roles, ResourceLabels: labels, Traits: traits, RequestedTTL: ttl})
	return &PolicyResult{Prediction: dec.Action, Rule: dec.Rule, Reason: dec.Reason, TTLCap: dec.TTLCap.String(), Approvers: dec.Approvers}, nil
}

// CreateRequest validates and creates a PENDING access request for the principal. Guards: per-user
// rate limit, reason length, role/resource counts, every role requestable per Teleport (and not
// hidden), TTL default/max/policy cap, policy deny (unless dry run). A Teleport refusal is reported
// in the result (Created=false, Error) rather than as an error, with the tsh command to try by hand.
func (s *Service) CreateRequest(ctx context.Context, p Principal, in CreateRequestIn) (*CreateResult, error) {
	if !s.d.Limiter.Allow(p.TeleportUser) {
		return nil, trace.LimitExceeded("%s", ErrRateLimited.Error())
	}
	reason := CleanReason(in.Reason)
	if n := utf8.RuneCountInString(reason); n < MinReasonLen || n > MaxReasonLen {
		return nil, trace.BadParameter("a reason of %d-%d characters is required; ask the person why they need access", MinReasonLen, MaxReasonLen)
	}
	if len(in.Roles) == 0 && len(in.ResourceIDs) == 0 {
		return nil, trace.BadParameter("at least one role (or resource id) is required")
	}
	if len(in.Roles) > MaxRolesPerReq || len(in.ResourceIDs) > MaxResourcesReq {
		return nil, trace.BadParameter("too many roles or resources in one request")
	}
	// Every role must be requestable by this user per Teleport (not just per our policy).
	caps, err := s.d.API.GetAccessCapabilities(ctx, types.AccessCapabilitiesRequest{User: p.TeleportUser, RequestableRoles: true})
	if err != nil {
		return nil, err
	}
	roles := []string{}
	for _, role := range in.Roles {
		role = strings.TrimSpace(role)
		if role == "" || contains(roles, role) {
			continue
		}
		if caps == nil || !contains(caps.RequestableRoles, role) || IsHidden(role) {
			return nil, trace.BadParameter("role %q is not requestable by this user; use list_requestable_roles", role)
		}
		roles = append(roles, role)
	}
	if len(roles) == 0 && len(in.ResourceIDs) == 0 {
		return nil, trace.BadParameter("at least one role is required")
	}
	ttl := DefaultTTL
	if in.TTL != "" {
		d, err := time.ParseDuration(in.TTL)
		if err != nil || d <= 0 {
			return nil, trace.BadParameter("ttl must be a duration like 1h or 30m")
		}
		ttl = d
	}
	requestedTTL := ttl
	if ttl > MaxRequestTTL {
		ttl = MaxRequestTTL
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
	var prediction *Prediction
	if s.d.Policy != nil {
		var traits map[string][]string
		if u, err := s.d.API.GetUser(ctx, p.TeleportUser, false); err == nil {
			traits = u.GetTraits()
		}
		dec := s.d.Policy.Evaluate(policy.EvalRequest{Requester: p.TeleportUser, Roles: roles, Traits: traits, RequestedTTL: ttl})
		if dec.TTLCap > 0 && dec.TTLCap < ttl {
			ttl = dec.TTLCap
		}
		prediction = &Prediction{Action: dec.Action, Rule: dec.Rule, Reason: dec.Reason, TTLCap: dec.TTLCap.String(), Approvers: dec.Approvers.TeleportRoles}
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
	tsh := fmt.Sprintf("tsh request create --roles %s --max-duration %s --reason %q", strings.Join(roles, ","), ShortDur(ttl), reason)
	created, err := s.d.API.CreateAccessRequestV2(ctx, req)
	if err != nil {
		// Fall back to telling the person how to do it themselves.
		s.d.Log.Warn("create access request failed", "user", p.TeleportUser, "roles", roles, "err", err)
		return &CreateResult{Created: false, Error: UserFacing(err), TshCommand: tsh, Prediction: prediction}, nil
	}
	s.d.Log.Info("access request created", "request_id", created.GetName(), "user", p.TeleportUser, "roles", roles, "ttl", ttl.String(), "dry_run", in.DryRun)
	view := ViewRequest(created)
	out := &CreateResult{Created: !in.DryRun, DryRun: in.DryRun, Request: &view, Prediction: prediction, TshCommand: tsh,
		Note: "The request is PENDING until the access broker or an approver decides. Check with get_access_request."}
	if ttl != requestedTTL {
		out.TTLClampedFrom = requestedTTL.String()
		out.TTL = ttl.String()
	}
	return out, nil
}

// IsApprover reports whether user holds one of the approver roles.
func (s *Service) IsApprover(ctx context.Context, user string) bool {
	u, err := s.d.API.GetUser(ctx, user, false)
	if err != nil {
		return false
	}
	for _, r := range u.GetRoles() {
		for _, a := range s.d.ApproverRoles {
			if r == a {
				return true
			}
		}
	}
	return false
}

// FindRequest resolves a full id or a unique id prefix.
func (s *Service) FindRequest(ctx context.Context, id string) (types.AccessRequest, error) {
	if len(id) >= 36 {
		reqs, err := s.d.API.GetAccessRequests(ctx, types.AccessRequestFilter{ID: id})
		if err != nil {
			return nil, err
		}
		if len(reqs) == 1 {
			return reqs[0], nil
		}
	}
	all, err := s.d.API.GetAccessRequests(ctx, types.AccessRequestFilter{})
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

// GetRequest returns one request: the principal's own, or any request when the principal is an approver.
func (s *Service) GetRequest(ctx context.Context, p Principal, id string) (*RequestView, error) {
	r, err := s.FindRequest(ctx, id)
	if err != nil {
		return nil, err
	}
	if r.GetUser() != p.TeleportUser && !s.IsApprover(ctx, p.TeleportUser) {
		return nil, trace.NotFound("no access request %q", id)
	}
	v := ViewRequest(r)
	return &v, nil
}

// ListMine lists the principal's requests, optionally filtered by state.
func (s *Service) ListMine(ctx context.Context, p Principal, state string) (*RequestList, error) {
	reqs, err := s.d.API.GetAccessRequests(ctx, types.AccessRequestFilter{User: p.TeleportUser, State: ParseState(state)})
	if err != nil {
		return nil, err
	}
	out := []RequestView{}
	for _, r := range reqs {
		out = append(out, ViewRequest(r))
	}
	return &RequestList{Requests: out}, nil
}

// ListPending lists every pending request (approvers only).
func (s *Service) ListPending(ctx context.Context, p Principal, roleFilter string) (*RequestList, error) {
	if !s.IsApprover(ctx, p.TeleportUser) {
		return nil, trace.AccessDenied("only approvers can list other users' pending requests")
	}
	reqs, err := s.d.API.GetAccessRequests(ctx, types.AccessRequestFilter{State: types.RequestState_PENDING})
	if err != nil {
		return nil, err
	}
	out := []RequestView{}
	for _, r := range reqs {
		if roleFilter != "" && !contains(r.GetRoles(), roleFilter) {
			continue
		}
		out = append(out, ViewRequest(r))
	}
	return &RequestList{Requests: out}, nil
}
