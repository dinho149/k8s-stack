# ADR 0002 — Community Edition by default, Enterprise behind a flag

**Decision.** The scaffold deploys Teleport Community Edition unless `teleport:edition: enterprise` is set. Zero standing
privileges with automatic approvals is delivered in Community mode by a custom access broker (Machine ID bot with the
`access_request: update` rule); in Enterprise mode by native Access Monitoring Rules and the official chat plugins.

**Why.** Access-request review roles, thresholds, resource requests, Access Lists, automatic reviews and the official
plugins are Enterprise-only. A scaffold that "runs anywhere" must work without a license.

**Consequences.** Two code paths for approvals, both driven by one role catalog; unit tests assert Community never emits
Enterprise-only role fields. The bots are exempt from admin-action MFA, which is what makes the broker viable.
