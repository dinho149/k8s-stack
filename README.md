# Stack

A Kubernetes developer platform for kind, EKS, and GKE, with disposable PR previews, Backstage, and a Claude Agent SDK assistant for Slack, Teams, Google Chat, and the portal.

**Measured local warm application startup: p95 43.59 seconds; 30/30 launches passed at concurrency 5.** Including queue time, p95 was 44.05 seconds against the 180-second target. Cloud and cold-host results remain unmeasured; see the [verification record](docs/verification.md). Every deployment records queue, cluster, platform, and application milestones. Cold starts, failed runs, and retries remain visible.

## Run locally

Prerequisites: Go 1.25+, Node 22/24, Docker, kind, kubectl, Helm 3, Python 3, and ripgrep. OpenTofu is needed for cloud infrastructure. The base profile fits more comfortably with 8+ GB allocated to Docker; allocate at least 16 GB for the expanded catalog and several previews.

```sh
npm ci --ignore-scripts
make doctor
make local
bash scripts/build-sample.sh > .stack/sample-image.txt
bash scripts/dev.sh
```

Open **http://localhost:3000**. Local guest sign-in is restricted to the loopback development services. `scripts/dev.sh` generates random credentials in `.stack/local.env`, starts a dedicated PostgreSQL container, and runs the lifecycle API, Backstage backend, and portal. It does not start the agent without configured cloud model access.

In another terminal:

```sh
source .stack/local.env
bin/stack up --name pr-demo \
  --image "$(cat .stack/sample-image.txt)" \
  --revision abcdef1234567
bin/stack status --name pr-demo
```

Use the environment page to see timing, extend expiry, retry, or delete. The CLI deletion flow first returns a confirmation ID:

```sh
bin/stack down --name pr-demo
bin/stack down --name pr-demo --confirmation '<returned confirmation ID>'
```

Local previews deploy directly with Helm into a vCluster so an unpublished repository works. Cloud previews use Argo CD and require a reachable, configured Git repository. The base bootstrap installs Cilium, Argo CD, and Envoy Gateway. Expanded tools are pinned in `catalog/components.json` and installed through `scripts/catalog-sync.sh`; they are not all loaded onto a small laptop automatically.

## What is implemented

- Durable preview lifecycle API, CLI, ownership checks, generation-based concurrency, explicit deletion confirmation, TTL cleanup, restart recovery, and notification outbox.
- Kubernetes preview driver, local registry/sample workload, host isolation policies, Argo cluster registration, and cloud infrastructure/data modules.
- Backstage environment management, startup breakdowns, tool directory, policy view, account-linking codes, release requests, and assistant UI.
- Claude Agent SDK with Bedrock and Vertex selection, scoped custom tools, conversation persistence, provider pinning, and bounded execution.
- Verified channel adapters, personal-chat account linking, event deduplication, and proactive ready/late/expiry/failure/cleanup messages.
- GitHub build/scan/deploy/close workflows and protected-environment promotion of immutable image digests.

## Installation requirements and limits

This repository is an initial working implementation, **not a production-certified distribution**. Cloud modules and chat adapters require real accounts, application registrations, domains, model enablement, and secrets. See the [verification record](docs/verification.md) for tested behavior and remaining checks. Read [cloud setup](docs/cloud-setup.md), [agent setup](docs/agent-setup.md), and [trust boundaries](docs/architecture.md) before deployment.

The controller and agent each use a single active replica with persistent storage. Operator identity/team mappings are configured explicitly; automatic GitHub membership synchronization is not implemented. SSO client configuration, provider storage/load-balancer integrations, backup destinations, persistent database credentials, and production protection rules must be supplied by the installation. The sample database is disposable unless external-database values are configured.

Do not expose `/internal/*`, enable local guest login outside development, or deploy the privileged preview controller to a production workload cluster. The agent itself has no cluster administration credentials or shell tools.

## Validation

```sh
make ship-gate
npm audit --audit-level=high
for dir in infra/aws infra/gcp infra/data/aws infra/data/gcp; do
  tofu -chdir="$dir" init -backend=false -input=false
  tofu -chdir="$dir" validate
done
```

Real startup benchmarking:

```sh
source .stack/local.env
python3 scripts/benchmark.py --image "$(cat .stack/sample-image.txt)" \
  --revision abcdef1234567 --runs 30 --concurrency 5
bin/stack benchmark --file .stack/benchmark.json
```

Use documented hardware and pre-pulled images for warm comparisons. The benchmark runner cleans up its own previews; it never deletes the host cluster. `stack benchmark` refuses to claim the target with fewer than 30 successful measured runs or any failures. Bootstrap timing is recorded in `.stack/bootstrap-timing.json`.

## Repository map

| Area | Location |
|---|---|
| CLI and lifecycle service | `cmd/stack`, `internal/platform` |
| Claude agent and chat adapters | `services/agent` |
| Backstage frontend and backend plugin | `packages/portal`, `packages/backend` |
| Helm charts and cluster resources | `deploy` |
| Cloud hosts and retained databases | `infra` |
| Versioned platform tools | `catalog` |
| Automation and benchmarks | `scripts`, `.github/workflows` |

Local cleanup: stop `scripts/dev.sh`, delete previews through the API, then `kind delete cluster --name stack-local`. Remove only the dedicated `stack-registry` and `stack-backstage-db` containers when their local data is no longer needed. Existing clusters are never targeted by these instructions.

## Portal experience

Stack has dedicated overview, environment, release, tool, policy, and assistant pages, with shareable URLs and a slate/iris design in light and dark themes. The theme switcher and account controls are in the masthead. The footer and sign-in screen include “Powered by Backstage” attribution.

Preview creation and release promotion include review steps. Environment details refresh every five seconds, show real deployment milestones, and retain server-issued deletion confirmation and generation checks. Assistant history is kept only in the current browser tab’s session; changing inference provider starts a new conversation.

The portal’s shared shell, UI components, API hooks, and route pages live in `packages/portal/src`. Fonts are bundled locally. No production fixture data or new backend endpoints are required.

To run the browser checks without a Kubernetes cluster or model credentials:

```sh
npx playwright install chromium
npm run test --workspace @stack/portal
```

The tests start a dedicated Vite instance on port 4173 and intercept backend requests with controlled fixtures. They exercise navigation, creation, promotions, lifecycle actions, failures, account linking, and assistant conversations. Responsive checks cover desktop, tablet, and mobile in both themes; screenshots are written to `.stack/portal-review/`. CI installs Chromium before running the existing ship gate.
