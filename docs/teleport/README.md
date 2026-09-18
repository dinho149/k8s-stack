# Teleport access layer

[Teleport](https://goteleport.com) is Dogfood's engine for just-in-time, zero-standing-privilege access. It runs
on the same kind cluster as the rest of the platform (`dogfood-local`) and on any EKS / GKE / AKS cluster in the cloud:

- **Kubernetes only.** The local kind cluster for development; an existing cloud cluster for dev and prod, using the
  cloud's managed backends (DynamoDB+S3, Firestore+GCS, Azure Postgres+Blob).
- **Pulumi (TypeScript)** infrastructure as code (`infra/teleport`), one stack per environment, typed
  per-environment templates. Teleport stays Pulumi-managed; it is not an Argo CD application.
- **Zero standing privileges.** Everyone gets a `requester` role; privileged roles are requested just in time.
  Low-risk requests (local/dev) are approved automatically, production requests need an approver — from chat.
- **An access agent** (Claude + MCP) that answers "what role do I need?", "what can I access right now?",
  "request `prod-dba` for two hours", exposed on Slack, Microsoft Teams and Google Chat.
- **Dummy resources** to protect: SSH servers, PostgreSQL, the Kubernetes cluster, an HTTP app, a fake cloud console.
- **Test suites**: Pulumi unit tests, Go integration tests against the live cluster, `tsh` end-to-end scenarios.
- **GitHub SSO** as the default login (Community Edition supports it), local auth kept for break-glass and tests.

```
make help-all           # every command; the Teleport group is make teleport-*
make teleport-doctor    # ✓/✗ toolchain, ports, kube context, Pulumi backend
make teleport-up        # deploy into dogfood-local: tsh → trusted TLS cert (mkcert) → images → pulumi up → wait → local users
make up TELEPORT=1      # the Dogfood stack and Teleport in one go
make teleport-login     # tsh login with no prompts (GitHub SSO once configured); make teleport-web-login prints the web UI credentials
make teleport-status    # dashboard: pods, Teleport inventory, pending requests, your session
```

Read [local.md](local.md) to get started, [architecture.md](architecture.md) for the design,
[access-model.md](access-model.md) for the zero-standing-privilege model and [migration.md](migration.md) if you
used the standalone `k8s-teleport` repository before.

## Layout

| Path | What |
|---|---|
| `infra/teleport/` | Pulumi project (`@dogfood/teleport-infra`). `src/policy/catalog.ts` is the single source of truth for roles and risk tiers. |
| `cmd/teleport-access/`, `internal/teleportaccess/` | Go (root module): MCP server (`teleport-access mcp`) and access broker (`teleport-access broker`). |
| `services/access-agent/` | TypeScript (`@dogfood/access-agent`): Claude agent + Slack / Teams / Google Chat / CLI adapters. |
| `deploy/teleport/` | Service images (`images/`) and the scripts behind every `make teleport-*` target (`scripts/lib/ui.sh` draws the UI). |
| `tests/teleport/` | Go integration tests, `tsh` e2e scripts, seeding tools, rendered-policy checks. |
| `docs/teleport/` | This documentation, the broker API contract (`contracts/`), ADRs. |

Local state lives under `.dogfood/teleport/` (Pulumi file backend, mkcert files, seeded test credentials) and logs
under `.dogfood/logs/teleport/`; `make down` removes the stack state with the cluster, `make reset` everything.

## Editions

Community Edition is the default and needs no license. Set `teleport:edition: enterprise` plus the `licensePem`
secret to switch to Teleport Enterprise: the stack then deploys native Access Monitoring Rules and the official
Slack / Teams plugins instead of the custom broker. Note that since v16 Community Edition restricts commercial use
for larger companies; see Teleport's licence terms.
