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
| `TeleportKubeAgent` | `teleport-kube-agent` chart enrolling the cluster and hosting the app/db services |
| `DummyResources` | SSH StatefulSets, PostgreSQL with TLS, httpbin, fake cloud console, plus their Teleport App/Database CRs |
| `AccessServices` | tbot identities, Deployments and Secrets for the MCP server, access broker and chat agent |
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
| `local` | kind | NodePort 30080 → host 3080 | self-signed (`tsh --insecure`) | standalone PVC | GitHub SSO (once configured) or local |
| `dev-eks` / `dev-gke` / `dev-aks` | existing cloud cluster | LoadBalancer | cert-manager | standalone by default, `aws`/`gcp`/`azure` chartMode when backends exist | GitHub SSO + WebAuthn |
| `prod-eks` | existing cloud cluster | LoadBalancer | cert-manager | `aws` chartMode | GitHub SSO + WebAuthn |

Cloud stacks are scaffolds: they must pass `make preview STACK=…`; only `local` is deployed and tested end to end.
