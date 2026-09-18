# Teleport Enterprise mode

Set `teleport:edition: enterprise` and `pulumi config set --secret teleport:licensePem "$(cat license.pem)"`.

What changes (all rendered from the same role catalog):

- The chart runs the Enterprise image with the `license` Secret.
- `requester` gains `request.thresholds` and `search_as_roles` (resource-based requests); `approver` gains `review_requests`.
- `EnterpriseAccess` creates Access Monitoring Rules: `auto-approve-low-risk` (`automatic_review: builtin/APPROVED`
  for low-tier roles) and `notify-high-risk`, and deploys the official `teleport-plugin-slack` / `teleport-plugin-msteams`
  charts (each with its own bot via the `tbot` chart) for the adapters listed in `services.agent.adapters`.
- The custom access broker is **not** deployed (unless `services.broker.force: true`); the MCP server and the chat agent
  still work, and `who_can_approve` also reads `review_requests` roles.

Why the split exists: `review_requests`, thresholds, `search_as_roles`, Access Lists, automatic reviews and the official
plugins are Enterprise-only (verified in Teleport's `checkRoleFeatureSupport` and the plugins' `AdvancedAccessWorkflows`
check), so Community Edition needs the broker to deliver zero standing privileges with automatic approvals.
