# Architecture

```
                 ┌──────────────────────────── Kubernetes cluster (kind / EKS / GKE / AKS) ────────────────────────────┐
                 │  ns teleport                                                                                        │
  tsh / browser ─┼─▶ proxy ──▶ auth ◀── operator  (reconciles TeleportRole/User/Bot/Token/App/Database/Github CRs)     │
  GitHub OAuth ──┼─▶ proxy      ▲                                                                                      │
                 │              │ kubernetes join (tokens scoped to ServiceAccounts)                                   │
                 │  ns teleport-agent    kube-agent (kube + app + db services; picks up App/Database CRs by label)     │
                 │  ns teleport-dummies  ssh-dev-0..N  ssh-prod-0   postgres (TLS)   httpbin   cloud-console (nginx)   │
                 │  ns teleport-access   teleport-mcp ◀── access-agent ──▶ access-broker  (each with a tbot sidecar)   │
                 └────────────────────────────────────────┬────────────────────────────────────────────────────────────┘
                                                          │ Slack / Teams / Google Chat / CLI
```

## Infrastructure (`infra/teleport`, Pulumi TypeScript)

One project, one stack per environment. `Pulumi.<stack>.yaml` holds the `teleport:*` settings; `src/config/profile.ts`
merges them over per-platform defaults (`src/config/platforms/*.ts`), validates them with zod and produces a typed
`EnvProfile`. Components consume the profile only:

| Component | Creates |
|---|---|
| `TeleportCluster` | namespace, license secret, `teleport-cluster` Helm chart (auth, proxy, operator + CRDs), NodePort Service on kind |
| `AccessPolicy` | roles (from `src/policy/catalog.ts`), `requester`/`approver`, service roles, Bots, join tokens, local users, GitHub connector |
| `TeleportKubeAgent` | one `teleport-kube-agent` release per env in the stack (`teleport-kube-agent`, `-dev`, `-prod`), each serving only the App/Database CRs of its env |
| `DummyResources` | non-root SSH StatefulSets (one ServiceAccount + join token per env), `postgres-dev`/`postgres-prod` with TLS + Teleport client-certificate auth, httpbin, fake cloud console, plus their Teleport App/Database CRs |
| `AccessServices` | tbot identities, Deployments and Secrets for the MCP server, access broker and chat agent; the CI harness bot only when `services.harness.enabled` (kind) |
| `NetworkPolicies` | default-deny ingress + egress in all four namespaces plus the allow-list below (every platform, kind included) |
| `ImagePolicy` | Kyverno `ClusterPolicy` admitting only cosign-signed images from `images.registry` and rejecting `:latest` (cloud stacks with `images.verifySignatures`) |
| `EnterpriseAccess` | Access Monitoring Rules and official Slack/Teams plugin charts (`edition: enterprise` only) |

All Teleport configuration is expressed as operator CRs in the `teleport` namespace, so no Teleport credentials are
needed at deploy time. The Terraform provider (`pulumi package add terraform-provider terraform.releases.teleport.dev/gravitational/teleport`)
remains an option for non-Kubernetes resources; see `docs/adr/0001-crs-not-terraform-provider.md`.

Helm charts go through `src/lib/helm.ts` (`kubernetes.helm.v4.Chart`). The Teleport charts' only hooks are optional
config-validation Jobs, disabled with `validateConfigOnDeploy: false`.

## Services

- **teleport-access (Go)** — one binary, two deployments, two Machine ID bots (least privilege, separate audit trails):
  - `mcp`: MCP server (stdio for Claude Code/Desktop, Streamable HTTP in-cluster). Identity is bound to the transport
    session (headers set by the agent process), never to tool arguments. No approve/deny tools exist.
  - `broker`: watches Access Requests, evaluates `policy.yaml` (rendered from the same catalog as the roles),
    auto-approves low-risk requests, notifies approvers for the rest, and exposes an HTTP API for chat approvals.
- **access-agent (TypeScript)** — Claude (`claude-opus-5`) tool-runner agent bridging MCP tools, with adapters for Slack,
  Microsoft Teams, Google Chat and a CLI. Approval buttons call the broker directly; the LLM is never in that path.

Bot identities are used deliberately: Teleport skips admin-action MFA for Machine ID bots, which is what lets the broker
call `SetAccessRequestState` and the MCP server create pending requests on a user's behalf without WebAuthn.

## Environments

| Stack | Platform | Exposure | TLS | Backend | Login |
|---|---|---|---|---|---|
| `local` | kind | NodePort 30080 → host 3080 (+ fixed 30081 for the in-cluster port) | self-signed (`tsh --insecure`) | standalone PVC | GitHub SSO (once configured) or local, OTP |
| `dev-eks` / `dev-gke` / `dev-aks` | existing cloud cluster | internal LoadBalancer + `sourceRanges` | cert-manager | standalone by default, `aws`/`gcp`/`azure` chartMode when backends exist | GitHub SSO + WebAuthn only, no local auth |
| `prod-eks` | existing cloud cluster | internal LoadBalancer + `sourceRanges` | cert-manager | `aws` chartMode (audit log mirrored to stdout) | GitHub SSO + WebAuthn only, no local auth |

Cloud stacks are scaffolds: they must pass `make preview STACK=…`; only `local` is deployed and tested end to end.

## Session controls (chart values, `TeleportCluster.renderClusterValues`)

Rendered into the auth pods' `teleport.yaml` on every stack: `locking_mode: strict`, `session_recording: node-sync`,
`require_session_mfa: true`, `disconnect_expired_cert: true`, `client_idle_timeout: 15m`, an explicit WebAuthn
`rp_id` (`auth.webauthnRpId`, default the public host) and `proxyProtocol: off` unless the load balancer is declared
to send PROXY headers (`exposure.proxyProtocol`). Cloud stacks run two auth/proxy replicas.

## Kubernetes hardening

**Pod Security Admission.** `teleport-access` and `teleport-dummies` enforce `restricted`; `teleport` and
`teleport-agent` enforce `baseline` with `warn`/`audit: restricted` (the charts' pods are rendered with restricted-
compatible contexts, so flipping the label is a one-line change once verified on your cluster). Every container we
own runs non-root with `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`,
`seccompProfile: RuntimeDefault` and CPU/memory limits (`src/lib/security.ts`); writable paths are explicit
`emptyDir`s. `automountServiceAccountToken` is `false` on every pod and ServiceAccount we create; workloads that join
Teleport with the kubernetes method read a short-lived projected token instead. Each namespace we create also gets a
`LimitRange` and a `ResourceQuota` (no NodePort/LoadBalancer Services allowed there). The kube-agent chart offers no
`automountServiceAccountToken` value and its Kubernetes service needs the API token, so that token stays mounted.

**NetworkPolicies** (`src/components/NetworkPolicies.ts`), default-deny ingress and egress everywhere, DNS allowed
everywhere, then:

| namespace | pod | ingress | egress |
|---|---|---|---|
| teleport | proxy | anyone → 3080 (front door) | auth:3025, dummies ssh:3022, internet:443 only with ACME |
| teleport | auth | proxy, operator, the three other namespaces → 3025 | kube API / SSO / cloud backends (443, 6443) |
| teleport | operator | — | auth:3025, kube API |
| teleport-access | teleport-mcp | access-agent → 8080 | auth:3025, proxy:3080 |
| teleport-access | access-broker | access-agent → 8081 | auth, proxy, access-agent:8082 |
| teleport-access | access-agent | access-broker → 8082; anyone → 8083 only with the Teams/Google Chat HTTP adapters | teleport-mcp:8080, access-broker:8081, internet:443 (never private ranges) |
| teleport-access | ci-harness (kind) | — | auth:3025, kube API |
| teleport-agent | kube-agent(s) | — | proxy:3080, kube API, dummies 5432/3306/80/8080/4566 |
| teleport-dummies | ssh-* | proxy → 3022 | auth:3025 |
| teleport-dummies | postgres-*/mysql | kube-agent → 5432/3306 | proxy:3080 (fetch the Teleport DB CA) |
| teleport-dummies | apps | kube-agent → 80/8080/4566 | — |

The API server has no selectable identity and its ClusterIP is DNAT'ed before policy evaluation, so the pods that
need it get TCP 443/6443 to `0.0.0.0/0`; those are the same pods that need SSO or cloud backends. Nothing else may
leave the cluster.

**Databases.** Teleport authenticates to self-hosted databases with a client certificate signed by its `db_client`
CA (CN = database user). An init container fetches that CA from the proxy's public
`/webapi/auth/export?type=db-client` endpoint; PostgreSQL's `pg_hba.conf` only admits
`hostssl … cert clientcert=verify-full` from the network (`scram-sha-256` on the local socket, generated superuser
password), MySQL users are created with `REQUIRE SUBJECT '/CN=<user>'`. Each instance has its own server certificate
(SAN = its Service DNS name, 1-year validity) and the Teleport Database CRs use `tls.mode: verify-full` with that
certificate as `ca_cert`.

**Chat agent secrets.** Nothing secret is injected as an environment value. The `access-services` Secret
(`TA_MCP_SHARED_TOKEN`, `TA_BROKER_API_TOKEN`, `TA_BROKER_WEBHOOK_SECRET`, `TA_IDENTITY_SIGNING_KEY`) is mounted at
`/var/run/secrets/access-services/` and one Secret per credential group (`access-agent-llm`, `-slack`, `-teams`,
`-gchat`, only for the auth mode / adapters in use) at `/var/run/secrets/chat/<group>/<ENV_NAME>`, all `0400`; the
agent is pointed at them with `<ENV_NAME>_FILE`. The agent listens on 8082 (broker events, health) and 8083
(`PUBLIC_PORT`, chat webhooks) so an ingress only ever exposes the latter.
