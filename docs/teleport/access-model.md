# Zero-standing-privilege access model

**Nobody holds privileged access permanently.** Every human — local users and GitHub SSO users alike — gets the
`requester` role, which grants no resource access and only the right to *request* roles from the catalog. That
includes administrators: there is no standing `editor` or `access` anywhere off the local kind cluster.

## The catalog (`infra/teleport/src/policy/catalog.ts`)

| Role | Grants | Env labels | Tier | Max TTL |
|---|---|---|---|---|
| `dev-ssh` | SSH as `dev` | local, dev | low | 4h |
| `dev-db` | Postgres as `postgres`/`app` | local, dev | low | 4h |
| `dev-k8s` | group `k8s-teleport:dev` → `edit` in namespace `teleport-dummies` | local, dev | low | 4h |
| `dev-app` | web apps | local, dev | low | 4h |
| `prod-ssh` | SSH as `dev` | prod | high | 2h |
| `prod-db` | Postgres as `readonly`/`app` | prod | high | 2h |
| `prod-k8s` | group `k8s-teleport:prod-viewer` → ClusterRole `view` | prod | high | 2h |
| `prod-app` | web apps (incl. the cloud console) | prod | high | 2h |
| `dev-dba` | local/dev databases as `postgres`/`app` | local, dev | high | 2h |
| `prod-dba` | prod databases as `postgres`/`readonly` | prod | high | 2h |
| `k8s-admin` | group `k8s-teleport:cluster-admin` → ClusterRole `cluster-admin` | all | high | 1h |
| `break-glass-editor` | Teleport RBAC: `role`, `user`, `token`, `auth_connector`, `lock` (all verbs) | — | high | 1h |

Resource roles select by the `env` label only. Every dummy resource carries `env`, `tier`, `team`. No role grants
`system:masters` or a wildcard database user: the Kubernetes groups above are bound to ordinary (Cluster)Roles by
`src/components/KubeRbac.ts`, so every elevated Kubernetes action is a normal, auditable RBAC subject.

### Session controls on every catalog role

Each catalog role renders with the same `options` (`src/policy/render.ts`, `HARDENED_OPTIONS`):

| Option | Value | Effect |
|---|---|---|
| `require_session_mfa` | `"yes"` (per-session; the CRD field is int-or-string) | a fresh WebAuthn/OTP touch for every SSH, Kubernetes and database session |
| `disconnect_expired_cert` | `true` | the session drops the moment the grant expires |
| `client_idle_timeout` | `15m` | idle sessions are closed |
| `lock` | `strict` | a lock takes effect immediately, even if the auth server is unreachable |
| `pin_source_ip` | `true` (Enterprise only) | certificates are bound to the requesting IP; omitted on Community, where the auth server rejects the option |
| `ssh_file_copy`, `forward_agent`, `ssh_port_forwarding` | off | no exfiltration side channels |
| `create_host_user_mode` | `off` | never create host users |
| `enhanced_recording` | `command`, `network` | BPF recording where the node supports it |
| `max_session_ttl` | per role | 1h–4h |

Every resource-granting catalog role also carries `deny: { rules: [{ resources: ["*"], verbs: [create, update,
delete] }] }`: elevated *resource* access never comes with the right to change cluster configuration. Note that
Teleport evaluates deny rules across every role a user holds, so an approver who currently holds an elevated
catalog role cannot approve with `tsh request review` until it expires (approvals through the broker are unaffected:
the broker is a bot).

`break-glass-editor` is the one catalog role that grants Teleport RBAC writes. It carries the same session options,
lasts one hour, always requires human approval, and denies `access_request: update` so its holder can never
approve requests (including their own). It replaces the standing `editor` role for administration.

### `requester` and `approver`

- `requester`: `request.roles` = the catalog, `reason.mode: required`, `max_duration: 4h`, no resource access, and
  `deny` on `cluster_auth_preference`, `cluster_networking_config` and `session_recording_config` (the deny list
  deliberately does not overlap what `break-glass-editor` grants, otherwise it would neuter that role for everyone).
- `approver`: `access_request: [list, read, update]` (no delete), `max_session_ttl: 1h`, `require_session_mfa`,
  `lock: strict`.

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

- `allowed_roles`: the policy starts with the list of catalog roles; a request containing any role outside it is
  denied before the rules run.
- `deny`: `editor`, `auditor`, `access`, `approver`, `^admin-.*$` are never granted through the broker.
- `auto_approve`: low-tier roles only, and only if *every* requested role is low-tier and the requested duration
  is within the tier's cap.
- `require_approval` (the default): high-tier roles, `break-glass-editor`, and any mixed request. Approvers are
  users holding `approver` (bob locally; the GitHub team mapped to it). The requester can never approve their own
  request (enforced by Teleport and by the broker).

## Administration: break-glass, not standing admin

| Stack | Local users | SSO team → roles | How to administer |
|---|---|---|---|
| `local` (kind) | `admin` = `editor, auditor` (no `access`, no `approver`, no logins); `alice` = `requester`; `bob` = `requester, approver` | optional | `make up` enrols `admin` headlessly (credentials in `tests/.state/users.json`); `make login` / `make web-login`; `make bootstrap-admin` rotates them. **Lock the user after use**: `deploy/scripts/tctl.sh lock --user=admin --message="break-glass"` |
| `dev-*`, `prod-*` | none (`localAuth: false`, `secondFactors: [webauthn]`) | `teleport-users` → `requester`; `teleport-approvers` → `requester, approver`; `teleport-admins` → `requester, approver, auditor` | request `break-glass-editor` (approved by another approver, 1h) |

`make github-sso` writes exactly this mapping and, off the local stack, switches `localAuth` off and second factors
to WebAuthn only. `deploy/scripts/bootstrap-users.sh` (and `bootstrap-admin.sh`) refuse to run for non-local stacks.

### Invariants enforced by `buildProfile` (`src/config/profile.ts`)

`pulumi preview`/`up` refuse a stack whose config violates any of these; `make preview` in CI sets
`TELEPORT_ALLOW_KIND_CONTEXT=1`, which only tolerates the kind context and a missing GitHub client secret for the
scaffolded cloud stack files.

- off `env: local`: no `users[].roles` or `github.teamsToRoles[].roles` containing `editor` or `access`;
  `auth.type` must not be `local`; `auth.localAuth` must be `false`; `secondFactors` must not include `otp`
- `platform != kind`: `kubeContext` must not start with `kind-` (unless the CI escape hatch is set); the CI harness
  bot must be disabled; an enabled chat agent needs `services.agent.allowedEmailDomains`; a Slack adapter needs
  `slackAllowedTeamIds`; an internet-facing load balancer needs `exposure.sourceRanges`
- `env: prod`: no standalone backend (`chartMode` aws/gcp/azure), no dummy resources, every deployed image pinned
  in `images.digests`, `images.pullPolicy` never `Always`
- every role name in `users[].roles` / `teamsToRoles[].roles` must be a managed non-bot role or one of `editor`,
  `auditor`, `access` (schema refinement)

## Bots (`svc-*` roles)

| Bot | Rights | Deployed |
|---|---|---|
| `teleport-mcp` | read users/roles/inventory, `access_request: create` | always |
| `access-broker` | `access_request: [list, read, update]`, `access_plugin_data: update` | always |
| `access-agent` | `user: [list, read]` | when `services.agent.enabled` |
| `ci-harness` | `access_request` full, `user: [list, read, update]` (reset tokens for admin/alice/bob: this bot can rotate any local user's password, kind only), impersonate `alice`/`bob` as `requester`/`approver` only | kind only (`services.harness.enabled`) |

Bots see nodes/databases/Kubernetes clusters (wildcard labels, no logins/users/groups so they cannot connect) and
apps only in `local`/`dev` (`deny.app_labels: { env: [prod] }`). Every Bot has `max_session_ttl: 2h`. No bot may
impersonate a catalog role.

Join tokens: `kube-agent` (`Kube, App, Db`, no `Discovery`) and one `ssh-node-<env>` token per dummy SSH env, each
bound to its own ServiceAccount `teleport-dummies:ssh-node-<env>`.

## Enterprise Edition

With `teleport:edition: enterprise` the same catalog additionally renders `request.thresholds`, `search_as_roles`
(resource-based requests) and `review_requests` on `approver`, and Pulumi deploys Access Monitoring Rules
(`automatic_review` for low-tier roles) plus the official Slack/Teams plugins. The broker is not deployed.

## Why the services are bots

Teleport enforces MFA for admin actions on human identities when WebAuthn is enabled, but skips it for Machine ID
bots. The broker (`SetAccessRequestState`) and the MCP server (`CreateAccessRequestV2` for another user) therefore
run as bots joined with the Kubernetes join method, scoped to their ServiceAccounts.
