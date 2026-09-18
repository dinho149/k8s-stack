# Dogfood

A Kubernetes developer platform for kind, EKS, and GKE, with disposable PR previews, Backstage, and a Claude Agent SDK assistant for Slack, Teams, Google Chat, and the portal.

**Historical Stack measurement (before the Dogfood rebrand), local warm application startup: p95 43.59 seconds; 30/30 launches passed at concurrency 5.** Including queue time, p95 was 44.05 seconds against the 180-second target. Cloud and cold-host results remain unmeasured; see the [verification record](docs/verification.md). Every deployment records queue, cluster, platform, and application milestones. Cold starts, failed runs, and retries remain visible.

For the visual identity, see [brand guidance](docs/brand.md). Existing Stack users should follow [the fresh-install transition](docs/dogfood-transition.md) before starting Dogfood.

## Run locally

Install these system prerequisites first. Make installs project dependencies; it does not install or upgrade system tools.

| Tool             | Required version / installation                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GNU Make and Git | macOS: Xcode Command Line Tools (`xcode-select --install`); Linux: distribution packages                                                                                                    |
| Python           | 3.9+; [python.org](https://www.python.org/downloads/)                                                                                                                                       |
| Go               | 1.26+; [go.dev](https://go.dev/dl/)                                                                                                                                                         |
| Node.js and npm  | Node >=22 and <26 (22/24 LTS recommended); [nodejs.org](https://nodejs.org/en/download)                                                                                                     |
| Docker           | Running Docker Desktop or Docker Engine; [Docker installation](https://docs.docker.com/get-started/get-docker/)                                                                             |
| kind             | [kind installation](https://kind.sigs.k8s.io/docs/user/quick-start/#installation)                                                                                                           |
| kubectl          | Compatible with Kubernetes 1.34; [kubectl installation](https://kubernetes.io/docs/tasks/tools/)                                                                                            |
| Helm             | Helm 3 or 4; [Helm installation](https://helm.sh/docs/intro/install/)                                                                                                                       |
| ripgrep          | [ripgrep installation](https://github.com/BurntSushi/ripgrep#installation)                                                                                                                  |
| OpenTofu         | 1.10+ for infrastructure checks, formatting, and the full ship gate; [OpenTofu installation](https://opentofu.org/docs/intro/install/)                                                      |
| Pulumi, expect   | Teleport only: [Pulumi installation](https://www.pulumi.com/docs/install/); `expect` (preinstalled on macOS) drives headless `tsh` logins. mkcert is optional (browser-trusted certificate) |

Supported hosts: macOS and Linux. Allocate 8+ GB to Docker for the base stack, or 16+ GB for expanded tools and several previews. The local stack uses ports 3000, 7007, 8088, 15432, 5005, 18080, and 18443; the optional agent uses 8090. Teleport (optional) adds 3080 and the port-forwards 18380–18383.

From the repository root:

```sh
make setup
make doctor
make up
```

Open **http://localhost:3000**, or run `make open`. `make up` also ensures setup, creates the `dogfood-local` kind cluster, installs the base platform, builds the sample image, and starts PostgreSQL, the lifecycle API, Backstage, and the portal in the background. It returns only after services are ready. Repeated runs reuse healthy services and data; bootstrap reconciles cluster components and the sample image is rebuilt.

No credentials need to be sourced into your shell. Make creates private, random credentials in `.dogfood/local.env` and loads them for local commands. Guest sign-in is confined to loopback development services. The agent is optional and requires model access.

```sh
make                       # Local development dashboard
make help-all              # Complete command reference
make status                # Service health and URLs
make logs                  # Follow all service logs; Ctrl-C exits the viewer
make logs SERVICE=backend  # Follow one service
make logs SERVICE=database # Inspect PostgreSQL (also SERVICE=registry)
make restart               # Restart applications, preserving cluster and previews
make stop                  # Stop applications only
make down                  # Delete previews and cluster; retain database/registry data
```

`make down` first deletes previews through the lifecycle API and waits for cleanup. If cleanup fails, it retains the cluster and prints recovery instructions. It then stops application services and the dedicated PostgreSQL/registry containers and deletes only `dogfood-local`. It retains local credentials and lifecycle history with database data. `make up` recreates the cluster and restarts retained containers.

For a complete fresh start, `make reset CONFIRM=dogfood-local` deletes the local cluster, dedicated containers and their data, credentials, and `.dogfood` state. It leaves `.env` intact. `make clean` removes generated build/test artifacts after `make stop`.

### Teleport access (optional)

Teleport is Dogfood's engine for just-in-time, zero-standing-privilege access to servers, databases, Kubernetes and
apps. It deploys into the same `dogfood-local` cluster and is off by default:

```sh
make teleport-up           # deploy Teleport into the local cluster (or: make up TELEPORT=1)
make teleport-login        # tsh login without prompts; make teleport-login USER_NAME=alice for a seeded user
make teleport-status       # pods, Teleport inventory, pending access requests, your session
make teleport-down         # destroy the Teleport stack; the cluster stays
```

`make help-all` lists the whole **Teleport** group. Read [docs/teleport/local.md](docs/teleport/local.md) for the
walkthrough and [docs/teleport/access-model.md](docs/teleport/access-model.md) for the access model.

### Preview workflow

```sh
make preview-up NAME=pr-demo
make preview-status NAME=pr-demo
make preview-diagnostics NAME=pr-demo
make preview-extend NAME=pr-demo MINUTES=30
make preview-retry NAME=pr-demo
make preview-down NAME=pr-demo
# Review the returned confirmation ID, then:
make preview-down NAME=pr-demo CONFIRMATION=<returned-id>
```

`make preview-status` lists all previews. Creation and retry default to the recorded sample image digest and current Git HEAD; override with `IMAGE=registry/image@sha256:... REVISION=<commit-sha>`. Run `make sample-build` after changing the sample workload. Creation, retry, and confirmed deletion wait for the operation result. Extension adds minutes and preserves the API's generation checks.

Local previews deploy directly through Helm into vClusters, so an unpublished repository works. Cloud previews use Argo CD and require a reachable Git repository. Local Make commands require the default `dogfood-local` kind configuration in `platform.yaml`; they never select a cluster from your current kubectl context.

### Command reference

| Activity              | Commands                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Setup and lifecycle   | `help`, `help-all`, `setup`, `doctor`, `up`, `open`, `status`, `logs`, `stop`, `restart`, `down`, `reset`, `clean`                |
| Component development | `portal` runs the frontend in the foreground; `agent` / `agent-stop` manage the agent; `local` bootstraps only the cluster        |
| Previews              | `sample-build`, `preview-up`, `preview-status`, `preview-down`, `preview-retry`, `preview-extend`, `preview-diagnostics`          |
| Build and formatting  | `build`, `typecheck`, `format`, `format-check`, `lint`                                                                            |
| Tests                 | `test-local`, `test-agent`, `test-portal`, `test-fast`, `test-scoped`, `test`, `ship-gate`                                        |
| Additional checks     | `browser-install`, `audit`, `infra-validate`, `catalog-check`, `test-isolation`                                                   |
| Optional tools        | `catalog-sync`, `tool-routes`, `benchmark`, `benchmark-report`                                                                    |
| Teleport              | `teleport-up`, `teleport-login`, `teleport-status`, `teleport-requests`, `teleport-approve`, `teleport-down`, … (`make help-all`) |

All entries are Make targets: run `make <command>`. `make help-all` documents their arguments. Use `VERBOSE=1` to stream subprocess details and `NO_COLOR=1` to disable color. Redirected output is plain text. Complete task and service logs live under `.dogfood/logs/`; failures show a short excerpt and log location. `make logs` labels service output and masks configured secrets.

### Optional agent

Run `make setup` and `make up`, then create a private `.env` file with one `KEY=value` per line. Quoted values and comments are supported; shell expressions are not executed. The file is ignored by Git. Make loads `.env`, then generated local credentials; you do not need to copy service tokens.

For Bedrock:

```dotenv
AGENT_PROVIDER=bedrock
AWS_REGION=eu-west-2
BEDROCK_MODEL=your-enabled-model-or-inference-profile-id
AWS_PROFILE=your-profile
```

For Vertex:

```dotenv
AGENT_PROVIDER=vertex
ANTHROPIC_VERTEX_PROJECT_ID=your-project
CLOUD_ML_REGION=europe-west1
VERTEX_MODEL=your-enabled-claude-model-id
```

Use an existing authenticated AWS profile or Google Application Default Credentials with access to the chosen model. Account setup and model enablement happen in your cloud provider; Make does not create cloud accounts. Then run `make agent`, inspect `make logs SERVICE=agent`, and use the portal assistant. `make agent-stop` stops it. Slack/Teams/Google Chat installation is optional and documented in [agent setup](docs/agent-setup.md).

### Catalog and measurements

The base bootstrap installs Cilium, Argo CD, and Envoy Gateway. Expanded tools are pinned in `catalog/components.json` and are opt-in because of laptop resource requirements. Publish this repository to a Git URL reachable by Argo CD before installing them:

```sh
make catalog-check
make catalog-sync REPOSITORY=https://github.com/your-org/k8s-stack.git
make tool-routes TOOLS=argocd,grafana,keycloak
make benchmark RUNS=30 CONCURRENCY=5
make benchmark-report
```

Routes should be enabled only for installed tools. Benchmarking uses the sample digest and Git HEAD unless `IMAGE` and `REVISION` are supplied. It records failures and cleans up its own previews without deleting the host cluster. The report requires at least 30 successful warm runs and no failures to assert the target. Use documented hardware and pre-pulled images for warm comparisons. Bootstrap timings are recorded in `.dogfood/bootstrap-timing.json`.

`make test-isolation` requires two running previews; create them with `make preview-up NAME=isolation-a` and `make preview-up NAME=isolation-b`, then delete them using the normal confirmation workflow.

### Troubleshooting

- **Missing/wrong tool version:** run `make doctor` and use the prerequisite table above. Docker must be running. OpenTofu is optional for startup but required by the full checks.
- **Occupied port or an older development session:** stop the original session in its terminal before `make up`. Make refuses to kill processes it does not own.
- **Service startup failure:** use `make logs SERVICE=api`, `backend`, or `portal`, fix the reported issue, and retry `make up`. Only application processes started by the failed attempt are stopped; provisioned cluster/container resources are retained for diagnosis.
- **Database or registry ownership failure:** an existing container with the expected name must carry the `dogfood.platform/managed=true` label. Rename unrelated containers rather than relabeling them.
- **Lost local credentials:** restore `.dogfood/local.env` with the retained database, or use the explicit full reset. Do not delete credentials while retaining database data.
- **Deletion failure:** inspect `make preview-status` and `make preview-diagnostics NAME=...`; restore service health with `make up`, then retry `make down`. Full reset is available when local data can be discarded.
- **Another operation is running:** wait for the current Make operation. The OS releases the lifecycle lock when its process exits.
- **Browser dependencies on Linux:** run `make browser-install WITH_DEPS=1` to install Playwright's system dependencies; this can invoke the system package manager with elevated permissions.

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
make setup                 # Includes Chromium installation
make test-local            # Orchestration safety checks; no cluster required
make test-agent
make test-portal           # Browser checks; no cluster or model credentials
make ship-gate             # Formatting, lint, all tests, Helm, builds, infrastructure, audit
```

`make test-fast` and `make test-scoped` run the Go, orchestration, agent, and portal tests. `make test` adds lint and Helm checks. `make ship-gate` also builds all workspaces, validates the four infrastructure modules, and audits npm dependencies. Infrastructure validation downloads providers with backend initialization disabled; it does not provision cloud resources. CI uses the same Make targets.

## Repository map

| Area                                   | Location                                             |
| -------------------------------------- | ---------------------------------------------------- |
| CLI and lifecycle service              | `cmd/dogfood`, `internal/platform`                   |
| Claude agent and chat adapters         | `services/agent`                                     |
| Backstage frontend and backend plugin  | `packages/portal`, `packages/backend`                |
| Helm charts and cluster resources      | `deploy`                                             |
| Cloud hosts and retained databases     | `infra`                                              |
| Versioned platform tools               | `catalog`                                            |
| Automation and benchmarks              | `scripts`, `.github/workflows`                       |
| Teleport: Pulumi project               | `infra/teleport`                                     |
| Teleport: MCP server and access broker | `cmd/teleport-access`, `internal/teleportaccess`     |
| Teleport: access agent (chat)          | `services/access-agent`                              |
| Teleport: images, scripts, tests, docs | `deploy/teleport`, `tests/teleport`, `docs/teleport` |

## Portal experience

Dogfood has dedicated overview, environment, release, tool, policy, and assistant pages, with shareable URLs and a cobalt-and-gold identity with an original animated dog mascot in light and dark themes. The theme switcher and account controls are in the masthead. The footer and sign-in screen include “Powered by Backstage” attribution.

Preview creation and release promotion include review steps. Environment details refresh every five seconds, show real deployment milestones, and retain server-issued deletion confirmation and generation checks. Assistant history is kept only in the current browser tab’s session; changing inference provider starts a new conversation.

The portal’s shared shell, UI components, API hooks, and route pages live in `packages/portal/src`. Fonts are bundled locally. No production fixture data or new backend endpoints are required.

To run the browser checks without a Kubernetes cluster or model credentials:

```sh
make browser-install
make test-portal
```

The tests start a dedicated Vite instance on port 4173 and intercept backend requests with controlled fixtures. They exercise navigation, creation, promotions, lifecycle actions, failures, account linking, and assistant conversations. Responsive checks cover desktop, tablet, and mobile in both themes; screenshots are written to `.dogfood/portal-review/`. CI installs Chromium before running the existing ship gate.
