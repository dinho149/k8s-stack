# Testing

| Layer | Where | Command | Needs cluster |
|---|---|---|---|
| Pulumi unit (config layering, chart values, role rendering, DNS rewrite, AMRs) | `infra/teleport/test` | `npm test -w infra/teleport` | no |
| Agent unit (webhook HMAC, notifications, identity, Slack blocks, sessions) | `services/access-agent/test` | `npm test -w services/access-agent` | no |
| Go unit (policy engine, label matcher, explain_access, broker service + API, MCP in-memory) | `services/teleport-access` | `go -C services/teleport-access test ./...` | no |
| Go integration (roles/users/bots, inventory labels, broker decisions) | `tests/integration` | `make test-integration` | yes |
| tsh end-to-end (login, requester has nothing, auto-approval, human approval, inventory by env) | `tests/e2e` | `make test-e2e` | yes |
| MCP smoke (HTTP transport + identity headers) | `tests/mcp/smoke.mjs` | see file header | yes |
| Cloud scaffolds | `infra/teleport/Pulumi.dev-*.yaml` | `make preview STACK=dev-eks PULUMI_ARGS="--config teleport:kubeContext=kind-teleport-local"` | kind only |

`make test-unit` runs the first three; CI (`.github/workflows/ci.yml`) runs everything on a fresh kind cluster.

Headless logins use `tests/tools/seed-users` (reset token → TOTP registration → password) and `tests/tools/totp`;
credentials land in `tests/.state/users.json` (gitignored). The Go tests connect with the `ci-harness` bot identity
(`make harness-identity`), which Teleport exempts from admin-action MFA.
