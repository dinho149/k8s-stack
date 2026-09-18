// Package accessapi is the transport-neutral core of the access services: every question the MCP
// server answers and every access request it creates goes through Service, and the portal REST API
// (teleport-access portal) reuses the same code, so both surfaces enforce identical guards and return
// identical JSON. Identity is a parameter of every call (Principal) and never an input field.
package accessapi

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gravitational/teleport/api/types"
	"github.com/gravitational/trace"

	"github.com/yeaboi/k8s-stack/internal/teleportaccess/policy"
)

// HiddenRolePrefixes are internal service roles that are never listed, described or requestable.
var HiddenRolePrefixes = []string{"bot-", "svc-", "wildcard-workload-identity", "terraform-provider", "operator", "list-access-request-resources", "mcp-user", "access-plugin"}

// IsHidden reports whether a role name is an internal role.
func IsHidden(name string) bool {
	for _, p := range HiddenRolePrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// Principal is the Teleport user a call acts for. It always comes from a verified transport
// identity (MCP session binding, or the portal's authenticated subject), never from request data.
type Principal struct {
	TeleportUser string
	Email        string
}

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

// ---- outputs (JSON keys are the wire contract of both the MCP tools and the portal API)

// RoleSummary is the allow side of a role.
type RoleSummary struct {
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

// Whoami describes the principal's standing and elevated access.
type Whoami struct {
	User                string              `json:"user"`
	Email               string              `json:"email"`
	Roles               []string            `json:"roles"`
	Traits              map[string][]string `json:"traits"`
	ActiveElevatedRoles map[string]string   `json:"active_elevated_roles"`
	IsApprover          bool                `json:"is_approver"`
	EffectiveAccess     []RoleSummary       `json:"effective_access"`
	Note                string              `json:"note"`
}

// RoleList is the catalog.
type RoleList struct {
	Roles []RoleSummary `json:"roles"`
}

// RoleDetail adds the deny side and Kubernetes resources to a summary.
type RoleDetail struct {
	Role                RoleSummary                `json:"role"`
	Deny                map[string]any             `json:"deny"`
	KubernetesResources []types.KubernetesResource `json:"kubernetes_resources"`
}

// RequestableRole is a role the principal may request, with the broker's prediction.
type RequestableRole struct {
	Role        string   `json:"role"`
	Description string   `json:"description,omitempty"`
	Prediction  string   `json:"prediction"`
	Rule        string   `json:"rule,omitempty"`
	Approvers   []string `json:"approver_roles,omitempty"`
	TTLCap      string   `json:"ttl_cap,omitempty"`
}

// RequestableList is the answer to "what can I request?".
type RequestableList struct {
	RequestableRoles   []RequestableRole `json:"requestable_roles"`
	SuggestedReviewers []string          `json:"suggested_reviewers"`
	RequireReason      bool              `json:"require_reason"`
}

// ResourceList is a search result; Scoped is set when the list was filtered to the principal's reach.
type ResourceList struct {
	Resources []Resource `json:"resources"`
	Scoped    bool       `json:"scoped,omitempty"`
	Note      string     `json:"note,omitempty"`
}

// AccessibleHit is a resource the principal can reach now, with the roles that grant it.
type AccessibleHit struct {
	Resource
	Via []string `json:"via_roles"`
}

// AccessibleList is always approximate (computed from label selectors).
type AccessibleList struct {
	Resources   []AccessibleHit `json:"resources"`
	Approximate bool            `json:"approximate"`
	Note        string          `json:"note"`
}

// ApproverInfo answers "who can approve a request for this role?".
type ApproverInfo struct {
	Role               string   `json:"role"`
	PolicyAction       string   `json:"policy_action"`
	PolicyRule         string   `json:"policy_rule"`
	ApproverRoles      []string `json:"approver_roles"`
	Approvers          []string `json:"approvers"`
	SuggestedReviewers []string `json:"suggested_reviewers"`
	How                string   `json:"how"`
	// Note and Explain are set instead when no requestable role grants the named resource.
	Note    string `json:"note,omitempty"`
	Explain any    `json:"explain,omitempty"`
}

// PolicyResult is a policy dry run.
type PolicyResult struct {
	Prediction policy.Action    `json:"prediction"`
	Rule       string           `json:"rule,omitempty"`
	Reason     string           `json:"reason,omitempty"`
	TTLCap     string           `json:"ttl_cap,omitempty"`
	Approvers  policy.Approvers `json:"approvers"`
	Note       string           `json:"note,omitempty"`
}

// Prediction is the policy outcome attached to a created request.
type Prediction struct {
	Action    policy.Action `json:"action"`
	Rule      string        `json:"rule"`
	Reason    string        `json:"reason"`
	TTLCap    string        `json:"ttl_cap"`
	Approvers []string      `json:"approvers"`
}

// Review is one review on a request.
type Review struct {
	Author  string `json:"author"`
	State   string `json:"state"`
	Reason  string `json:"reason"`
	Created string `json:"created"`
}

// RequestView is an access request as both surfaces present it.
type RequestView struct {
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
	// Structured additions used by the portal (the string Reviews above stay for the MCP tools).
	ReviewsDetail    []Review `json:"reviews_detail,omitempty"`
	TshLoginCommand  string   `json:"tsh_login_command,omitempty"`
	TshStatusCommand string   `json:"tsh_status_command,omitempty"`
}

// RequestList wraps a list of requests.
type RequestList struct {
	Requests []RequestView `json:"requests"`
}

// CreateResult is the outcome of CreateRequest. When Teleport refused the request, Created is false
// and Error carries a user-facing message (with the tsh command to try by hand).
type CreateResult struct {
	Created        bool         `json:"created"`
	DryRun         bool         `json:"dry_run,omitempty"`
	Request        *RequestView `json:"request,omitempty"`
	Prediction     *Prediction  `json:"prediction"`
	TshCommand     string       `json:"tsh_command"`
	Note           string       `json:"note,omitempty"`
	Error          string       `json:"error,omitempty"`
	TTLClampedFrom string       `json:"ttl_clamped_from,omitempty"`
	TTL            string       `json:"ttl,omitempty"`
}

// ClusterInfo describes the cluster and how approvals work.
type ClusterInfo struct {
	ClusterName     string `json:"cluster_name"`
	TeleportVersion string `json:"teleport_version"`
	Edition         string `json:"edition"`
	ApprovalModel   string `json:"approval_model"`
}

// ---- shared helpers

// Limits on CreateRequest inputs.
const (
	MinReasonLen    = 8
	MaxReasonLen    = 512
	MaxRequestTTL   = 4 * time.Hour
	DefaultTTL      = 2 * time.Hour
	MaxRolesPerReq  = 20
	MaxResourcesReq = 20
)

// ErrRateLimited is returned (wrapped in trace.LimitExceeded) when the per-user create budget is spent.
var ErrRateLimited = errors.New("too many access requests created recently; try again later")

// CleanReason strips control characters and trims whitespace.
func CleanReason(s string) string {
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

// NormalizeKind maps friendly kind names to Teleport resource kinds.
func NormalizeKind(k string) string {
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

// StateString renders a request state as the API spells it.
func StateString(s types.RequestState) string {
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

// ParseState parses pending|approved|denied (any case); anything else means "no filter".
func ParseState(s string) types.RequestState {
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

// ShortDur renders whole hours as "2h" and everything else as Go does.
func ShortDur(d time.Duration) string {
	if d%time.Hour == 0 {
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return d.String()
}

// ApprovalModel describes how approvals work for the edition.
func ApprovalModel(edition string) string {
	if edition == "enterprise" {
		return "Teleport Enterprise: Access Monitoring Rules auto-approve low-risk roles; approvers review in Slack/Teams or the web UI."
	}
	return "Community Edition: the access broker auto-approves low-risk roles per policy; high-risk requests are approved by users holding the approver role via chat buttons or tctl."
}

// UserFacing maps errors to messages safe to show a person or a model. Only well-typed Teleport
// errors carry their message; everything else is generic (callers log the details).
func UserFacing(err error) string {
	switch {
	case trace.IsAccessDenied(err):
		return "access denied by Teleport: " + trace.UserMessage(err)
	case trace.IsNotFound(err):
		return "not found: " + trace.UserMessage(err)
	case trace.IsBadParameter(err):
		return "invalid request: " + trace.UserMessage(err)
	case trace.IsLimitExceeded(err):
		return "rate limited: " + trace.UserMessage(err)
	}
	return "teleport error"
}

// ViewRequest converts a Teleport request into the shared view.
func ViewRequest(r types.AccessRequest) RequestView {
	v := RequestView{ID: r.GetName(), User: r.GetUser(), Roles: r.GetRoles(), Reason: r.GetRequestReason(), State: StateString(r.GetState()),
		Created: r.GetCreationTime().UTC().Format(time.RFC3339), Expires: r.GetAccessExpiry().UTC().Format(time.RFC3339), Resolution: r.GetResolveReason(), Annotations: r.GetResolveAnnotations(),
		TshStatusCommand: "tsh request show " + r.GetName()}
	for _, id := range r.GetRequestedResourceIDs() {
		v.ResourceIDs = append(v.ResourceIDs, types.ResourceIDToString(id))
	}
	for _, rev := range r.GetReviews() {
		v.Reviews = append(v.Reviews, fmt.Sprintf("%s: %s (%s)", rev.Author, StateString(rev.ProposedState), rev.Reason))
		v.ReviewsDetail = append(v.ReviewsDetail, Review{Author: rev.Author, State: StateString(rev.ProposedState), Reason: rev.Reason, Created: rev.Created.UTC().Format(time.RFC3339)})
	}
	if r.GetState() == types.RequestState_APPROVED && r.GetAccessExpiry().After(time.Now()) {
		v.TshLoginCommand = "tsh login --request-id=" + r.GetName()
	}
	return v
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
