# Zero-standing-privilege access model

**Nobody holds privileged access permanently.** Every human — local users and GitHub SSO users alike — gets the
`requester` role, which grants no resource access and only the right to *request* roles from the catalog.

## The catalog (`infra/teleport/src/policy/catalog.ts`)

| Role | Grants | Env labels | Tier | Max TTL |
|---|---|---|---|---|
| `dev-ssh` | SSH as `dev` | local, dev | low | 4h |
| `dev-db` | Postgres as `postgres`/`app` | local, dev | low | 4h |
| `dev-k8s` | edit in namespace `teleport-dummies` | local, dev | low | 4h |
| `dev-app` | web apps | local, dev | low | 4h |
| `prod-ssh` | SSH as `dev` | prod | high | 2h |
| `prod-db` | Postgres as `readonly`/`app` | prod | high | 2h |
| `prod-k8s` | view everything | prod | high | 2h |
| `prod-app` | web apps (incl. the cloud console) | prod | high | 2h |
| `dba` | any database, any user | all | high | 2h |
| `k8s-admin` | `system:masters` | all | high | 1h |

Roles select resources by the `env` label only. Every dummy resource carries `env`, `tier`, `team`.

## Decision flow (Community Edition)

```
tsh request create --roles X   (or the chat agent's create_access_request tool)
        │
        ▼
access-broker  ── policy.yaml (generated from the catalog) ──▶  deny | auto_approve | require_approval
        │                                                            │            │
        │                                              SetAccessRequestState   post card to approvers
        │                                                                        │ approve/deny button
        │                                                                        ▼
        └──────────────────────────────────────────────── SetAccessRequestState by a verified approver
```

- `deny`: `editor`, `auditor`, `access`, `approver`, `^admin-.*$` are never granted through the broker.
- `auto_approve`: low-tier roles, if the requested duration is within the tier's cap.
- `require_approval`: high-tier roles. Approvers are users holding `approver` (bob locally; the GitHub team mapped
  to it). The requester can never approve their own request (enforced by Teleport and by the broker).

`admin` (presets `editor, access, auditor`) is the documented break-glass identity; the GitHub team
`teleport-admins` maps to it.

## Enterprise Edition

With `teleport:edition: enterprise` the same catalog additionally renders `request.thresholds`, `search_as_roles`
(resource-based requests) and `review_requests` on `approver`, and Pulumi deploys Access Monitoring Rules
(`automatic_review` for low-tier roles) plus the official Slack/Teams plugins. The broker is not deployed.

## Why the services are bots

Teleport enforces MFA for admin actions on human identities when WebAuthn is enabled, but skips it for Machine ID
bots. The broker (`SetAccessRequestState`) and the MCP server (`CreateAccessRequestV2` for another user) therefore
run as bots joined with the Kubernetes join method, scoped to their ServiceAccounts.
