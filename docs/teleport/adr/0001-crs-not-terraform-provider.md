# ADR 0001 — Teleport configuration as operator CRs, not the Terraform provider

**Decision.** All Teleport-side configuration (roles, users, bots, join tokens, apps, databases, GitHub connector,
Access Monitoring Rules) is expressed as `resources.teleport.dev` custom resources created by Pulumi's Kubernetes provider
and reconciled by the Teleport Kubernetes Operator installed with the `teleport-cluster` chart.

**Why.** No Teleport credentials are needed at deploy time (the operator joins with the kubernetes method), ordering is a
plain `dependsOn` on the chart, and the same code path works on kind and in the cloud. The Terraform provider remains
usable from Pulumi (`pulumi package add terraform-provider terraform.releases.teleport.dev/gravitational/teleport <ver>`)
for resources the operator does not cover, at the cost of bootstrapping an identity for it.

**Consequences.** CRs must live in the operator's namespace (`teleport`); service role names avoid the `bot-` prefix that
Teleport reserves for bot-internal roles; CR labels are copied onto the Teleport resource, so they are kept minimal.
