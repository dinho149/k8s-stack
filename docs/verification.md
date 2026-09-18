# Verification record

## Dogfood rebrand — 2026-09-18

- `make ship-gate` passed: formatting, Go vet/race tests, all workspace typechecks, 32 local orchestration tests, 6 agent tests, 11 portal browser tests, Helm lint, builds, four OpenTofu module validations, and the high/critical npm audit threshold. Moderate upstream audit findings remain.
- `make catalog-check` passed. After visual refinements, all 11 portal tests, the portal production build, and formatting checks passed again.
- Browser coverage spans all eight portal routes in light/dark themes at desktop, tablet, and mobile sizes, with no horizontal overflow or uncaught page errors. Sign-in was captured in both themes at all three widths. Screenshots are in `.dogfood/portal-review/`. Visual inspection caught and corrected a clipped mobile assistant welcome mascot.
- Brand tests cover the Dogfood title/home link, SVG/PNG/manifest delivery, keyboard ear flick, assistant thinking/success reactions, and reduced-motion suppression. Security tests cover the renamed identity header, secret filtering for both new and legacy prefixes, fresh credentials, and refusal to adopt legacy ownership labels.
- A fresh isolated `bin/dogfood serve` process on a temporary loopback port passed health, authenticated `X-Dogfood-Subject` access, and `dogfood_*` metrics checks. It was stopped and its temporary database removed.
- Full fresh Kubernetes startup was **not run**: `make doctor` reported existing services on ports 8088, 7007, 3000, 15432, 5005, 18080, and 18443. Existing Stack processes, containers, cluster, and `.stack` state were left untouched. See [transition instructions](dogfood-transition.md).
- No cloud provisioning, live external chat/SSO changes, or new startup benchmark was performed. Infrastructure validation was static.

## Historical Stack verification

The remaining sections record the **pre-rebrand Stack installation**. They are historical evidence, not measurements of a fresh Dogfood deployment.

Validation performed on macOS arm64 with Docker Desktop (18 reported CPUs, approximately 8 GB Docker memory). Existing unrelated local containers remained running. Tests use only the dedicated `stack-local` cluster, local registry, and Backstage database.

## Passed

- Go compilation, vet, and race-enabled lifecycle/API tests: authorization, idempotency, expiry semantics, actor-bound and expired confirmations, deletion/extension races, restart recovery, reopen behavior, and notification supersession.
- TypeScript checking and builds for Claude agent, Backstage backend, and portal.
- Local arm64 Docker image builds for lifecycle, Claude agent, Backstage backend, and portal; Claude Agent SDK runtime import in its container.
- Agent tests for provider isolation, explicit Vertex configuration, Slack signature/replay protection, Teams JWT audience and service URL validation, and Google Chat issuer/service identity validation.
- Helm lint for sample and platform charts, including external-database rendering and optional Backstage deployment.
- Static OpenTofu initialization/validation for EKS, GKE, RDS, and Cloud SQL modules.
- GitHub workflow syntax validation with actionlint.
- Authenticated Backstage → lifecycle API request, Backstage readiness endpoint, portal HTTP response, and Argo CD through the shared gateway.
- Live preview provisioning, revision-aware HTTP readiness, expiry extension, retry/recovery, and namespace teardown.
- Cross-preview pod traffic blocked, with successful application readiness controls on both previews.
- Authenticated Prometheus metrics endpoint and optional ServiceMonitor chart rendering.

## Startup observations

A fresh preview on the already-running local host reached virtual-cluster readiness in **26.54 seconds**, platform readiness in **28.95 seconds**, and application readiness in **39.16 seconds**. A separate recovery run took **9.12 seconds** to application readiness. These are different scenarios and must not be combined as cold-cluster results.

The base platform bootstrap after an existing kind host became ready took **83 seconds**. This excludes initial kind image download and host creation; it is not a cold-cluster benchmark. Early bring-up failures were retained in local operation history and led to fixes for Cilium API access, delayed kubeconfig generation, local registry configuration, and interrupted Helm release recovery.

The 30-run benchmark at five concurrent previews completed with **30 successes and zero failures**. Application readiness p95 was **43.59 seconds from operation start**, or **44.05 seconds including queue time**, against the 180-second target. Including queue time, median application readiness was **39.31 seconds**, maximum **119.07 seconds**, and virtual-cluster readiness p95 **31.08 seconds**. All benchmark previews were torn down. Raw operations remain under `.stack/benchmark.json`; these measurements apply to the local hardware, cached images, and included sample workload, not cold hosts or cloud clusters.

## Not validated here

- Real EKS/GKE provisioning, cross-cloud workload federation, cloud DNS/TLS, production SSO integration, database backup restore, or disaster recovery.
- Paid Claude inference on Bedrock/Vertex or real Slack/Teams/Google Chat installations and proactive delivery.
- Linux host execution and cloud-node architecture matrix.
- Browser-rendered visual/interaction testing: the computer-use environment exposed no browser. The frontend build and authenticated backend paths were tested.

Those checks need the installation's cloud profiles/projects, domains, chat registrations, and credentials. They are not represented as passing local tests.

## Dependency status

High/critical npm audit findings were resolved in the lockfile. Moderate upstream findings remain in Backstage's dependency graph (including Octokit, syntax highlighting, React Router, and UUID dependencies); see `make audit`. Do not treat this repository as production-certified based on compilation alone.
