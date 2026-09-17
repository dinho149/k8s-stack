# k8s-teleport

A portable [Teleport](https://goteleport.com) scaffold that runs the same way on a laptop and in the cloud:

- **Kubernetes only.** A local [kind](https://kind.sigs.k8s.io) cluster for development; any existing EKS / GKE / AKS
  cluster for dev and prod, using the cloud's managed backends (DynamoDB+S3, Firestore+GCS, Azure Postgres+Blob).
- **Pulumi (TypeScript)** infrastructure as code with one stack per environment and typed per-environment templates.
- **Zero standing privileges.** Everyone gets a `requester` role; privileged roles are requested just in time.
  Low-risk requests (local/dev) are approved automatically, production requests need an approver — from chat.
- **An access agent** (Claude + MCP) that answers "what role do I need?", "what can I access right now?",
  "request `dba` for two hours", exposed on Slack, Microsoft Teams and Google Chat.
- **Dummy resources** to protect: SSH servers, PostgreSQL, the Kubernetes cluster, an HTTP app, a fake cloud console.
- **Test suites**: Pulumi unit tests, Go integration tests against the live cluster, `tsh` end-to-end scenarios.
- **GitHub SSO** as the default login (Community Edition supports it), local auth kept for break-glass and tests.

```
make            # grouped help
make doctor     # ✓/✗ toolchain, ports, kube context, Pulumi backend
make up         # kind → images → pulumi up → wait → summary box
make status     # dashboard: pods, Teleport inventory, pending requests, your session
```

Read [docs/local.md](docs/local.md) to get started, [docs/architecture.md](docs/architecture.md) for the design, and
[docs/access-model.md](docs/access-model.md) for the zero-standing-privilege model.

## Layout

| Path | What |
|---|---|
| `infra/teleport/` | Pulumi project. `src/policy/catalog.ts` is the single source of truth for roles and risk tiers. |
| `services/teleport-access/` | Go: MCP server (`teleport-access mcp`) and access broker (`teleport-access broker`). |
| `services/access-agent/` | TypeScript: Claude agent + Slack / Teams / Google Chat / CLI adapters. |
| `deploy/` | kind config, images, and the scripts behind every `make` target (`deploy/scripts/lib/ui.sh` draws the UI). |
| `tests/` | Go integration tests, `tsh` e2e scripts, seeding tools, policy checks. |
| `docs/` | Architecture, runbooks, ADRs. |

## Editions

Community Edition is the default and needs no license. Set `teleport:edition: enterprise` plus the `licensePem`
secret to switch to Teleport Enterprise: the stack then deploys native Access Monitoring Rules and the official
Slack / Teams plugins instead of the custom broker. Note that since v16 Community Edition restricts commercial use
for larger companies; see Teleport's licence terms.
