# Verification record

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

High/critical npm audit findings were resolved in the lockfile. Moderate upstream findings remain in Backstage's dependency graph (including Octokit, syntax highlighting, React Router, and UUID dependencies); see `npm audit`. Do not treat this repository as production-certified based on compilation alone.
