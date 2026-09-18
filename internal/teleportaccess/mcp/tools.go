package mcpserver

import (
	"context"
	"errors"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/yeaboi/k8s-stack/internal/teleportaccess/accessapi"
)

// Input types are the shared ones (their jsonschema tags define the tool schemas). Aliases keep the
// package's exported names stable for tests and callers.
type (
	NameFilterIn    = accessapi.NameFilterIn
	RoleNameIn      = accessapi.RoleNameIn
	SearchIn        = accessapi.SearchIn
	AccessibleIn    = accessapi.AccessibleIn
	ExplainIn       = accessapi.ExplainIn
	WhoCanApproveIn = accessapi.WhoCanApproveIn
	PolicyIn        = accessapi.PolicyIn
	CreateRequestIn = accessapi.CreateRequestIn
	RequestIDIn     = accessapi.RequestIDIn
	ListMyIn        = accessapi.ListMyIn
	PendingIn       = accessapi.PendingIn
)

// ---- registration: every tool delegates to the shared accessapi.Service, so the MCP surface and the
// portal API enforce identical guards. There is deliberately no approve/deny tool.

func (s *Server) registerTools() {
	svc := s.svc
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "whoami", Description: "Current user's Teleport roles, traits, effective access (label selectors, logins, db users, kube groups) and active elevated roles." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ empty) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return svc.Whoami(ctx, p.access()) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "list_roles", Description: "List Teleport roles (name, description, what they select). Internal service roles are hidden." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in NameFilterIn) (*mcp.CallToolResult, any, error) {
			return s.wrap(func() (any, error) { return svc.ListRoles(ctx, in.NameFilter) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "describe_role", Description: "Full allow/deny detail of one role: label selectors, logins, db users/names, kube groups, rules, request/review settings, max session TTL." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in RoleNameIn) (*mcp.CallToolResult, any, error) {
			return s.wrap(func() (any, error) { return svc.DescribeRole(ctx, in.Name) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "list_requestable_roles", Description: "Roles the current user may request, with the access broker's prediction (auto_approve / require_approval / deny) for each." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ empty) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return svc.ListRequestable(ctx, p.access()) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "search_resources", Description: "Find servers, databases, Kubernetes clusters and apps by name or label. Results are limited to resources the current user holds or may request a role for (approvers see everything)." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in SearchIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return svc.Search(ctx, p.access(), in) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "list_accessible_resources", Description: "Resources the current user can reach right now (computed from their roles' label selectors and active elevated roles). Marked approximate." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in AccessibleIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return svc.Accessible(ctx, p.access(), in) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "explain_access", Description: "Which roles grant access to a resource, which of them the current user holds or may request, and how each request would be decided by policy. Use for 'what role do I need for X?'." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in ExplainIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return svc.Explain(ctx, p.access(), in.ResourceName, in.Kind) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "who_can_approve", Description: "Who may approve a request for a role (or for the role needed by a resource): approver roles from policy, users holding them, suggested reviewers." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in WhoCanApproveIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return svc.WhoCanApprove(ctx, p.access(), in) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "get_approval_policy", Description: "Dry-run the access broker policy for a set of roles (and optional resources): auto_approve, require_approval or deny, approvers and TTL cap." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in PolicyIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return svc.PolicyDryRun(ctx, p.access(), in) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "create_access_request", Description: "Create a PENDING access request for the current user. Requires an explicit reason from the person. Returns the request id, the policy prediction and the equivalent tsh command. This tool never approves anything." + untrusted, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: ptr(false), IdempotentHint: false}},
		func(ctx context.Context, _ *mcp.CallToolRequest, in CreateRequestIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return svc.CreateRequest(ctx, p.access(), in) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "get_access_request", Description: "Status of one access request (own requests, or any request when the user is an approver)." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in RequestIDIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return svc.GetRequest(ctx, p.access(), in.RequestID) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "list_my_access_requests", Description: "The current user's access requests, optionally filtered by state." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in ListMyIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return svc.ListMine(ctx, p.access(), in.State) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "list_pending_requests", Description: "All pending access requests (approvers only)." + untrusted, Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, in PendingIn) (*mcp.CallToolResult, any, error) {
			return s.withPrincipal(ctx, func(p Principal) (any, error) { return svc.ListPending(ctx, p.access(), in.RoleFilter) })
		})
	mcp.AddTool(s.mcp, &mcp.Tool{Name: "get_cluster_info", Description: "Teleport cluster name, version and edition, plus how approvals work here.", Annotations: ro()},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ empty) (*mcp.CallToolResult, any, error) {
			return s.wrap(func() (any, error) { return svc.ClusterInfo(), nil })
		})
}

func ro() *mcp.ToolAnnotations { return &mcp.ToolAnnotations{ReadOnlyHint: true} }
func ptr[T any](v T) *T        { return &v }

// access narrows the session principal to what the shared service needs.
func (p Principal) access() accessapi.Principal {
	return accessapi.Principal{TeleportUser: p.TeleportUser, Email: p.Email}
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

// userFacing maps errors to messages safe to show the model/user (details are logged by wrap).
func userFacing(err error) string {
	if errors.Is(err, ErrNoPrincipal) {
		return err.Error()
	}
	return accessapi.UserFacing(err)
}
