# Testing and security gates

## Test layers

| Layer | Where | Command | Needs cluster |
|---|---|---|---|
| Pulumi unit (config layering, invariants, chart values, role rendering, DNS rewrite, AMRs) | `infra/teleport/test` | `npm test -w infra/teleport` | no |
| Agent unit (webhook HMAC, identity assertions, notifications, Slack blocks, sessions, config fail-closed) | `services/access-agent/test` | `npm test -w services/access-agent` | no |
| Go unit (policy engine per-role semantics, assertion verification, broker service + API, MCP in-memory) | `services/teleport-access` | `go -C services/teleport-access test ./...` | no |
| Go integration (roles/users/bots, inventory labels, broker decisions) | `tests/integration` | `make test-integration` | yes |
| tsh end-to-end (see below) | `tests/e2e` | `make test-e2e` | yes |
| MCP smoke (HTTP transport + identity headers) | `tests/mcp/smoke.mjs` | see file header | yes |
| Cloud scaffolds | `infra/teleport/Pulumi.dev-*.yaml` | `CI_PREVIEW=1 make preview STACK=dev-eks PULUMI_ARGS="--config teleport:kubeContext=kind-teleport-local"` | kind only |

`make test-unit` runs the first three; CI (`.github/workflows/ci.yml`) runs everything on a fresh kind cluster.

### End-to-end scenarios (`tests/e2e`)

| Script | Asserts |
|---|---|
| `00_make_help.sh` | `make help` / `make doctor` render without colour under `NO_COLOR` |
| `01_requester_has_nothing.sh` | alice (requester) logs in and reaches nothing |
| `02_dev_request_auto_approved.sh` | `dev-ssh` is auto-approved by the broker and unlocks SSH to dev only |
| `03_prod_request_needs_approval.sh` | `prod-ssh` stays pending until a human (tctl) approves |
| `04_inventory_by_env.sh` | databases/apps/kube clusters follow the env labels of the granted roles |
| `05_agent_cli.sh` | chat -> Claude -> MCP (as alice) -> broker creates a request (skipped without Claude credentials) |
| `06_mixed_tier_stays_pending.sh` | `--roles dev-ssh,prod-ssh` is never auto-approved (mixed-tier bypass regression) |
| `07_long_ttl_not_auto_approved.sh` | `--roles dev-ssh --max-duration 8h` is rejected by Teleport or clamped to the requester's 4h `max_duration`; the recorded access window never exceeds the cap |
| `08_service_auth_fails_closed.sh` | broker approve with a body `approver` and no assertion -> 401 (400 with one); MCP with bearer + `X-Teleport-User` but no assertion -> 401 |

Headless logins use `tests/tools/seed-users` (reset token -> TOTP registration -> password) and `tests/tools/totp`;
credentials land in `tests/.state/users.json` (gitignored, created under `umask 077`, with an `enrolled_at`
timestamp because the enrolment consumes a code). `deploy/scripts/lib/tsh-login.sh` (+ `tsh-login.exp`) drives
`tsh login` for `make login` and the e2e scripts alike. Only the 30-second TOTP window index of the last code handed
out is remembered (`.logs/.totp-window-<user>`), never a code. The Go tests connect with
the `ci-harness` bot identity (`make harness-identity`, kind stack only: the harness bot is not deployed elsewhere).

TLS verification is skipped (`tsh --insecure`, `curl -k`) in exactly one case: `STACK=local` **and** the proxy is
`*.127.0.0.1.nip.io`. `deploy/scripts/_common.sh` computes `TSH_INSECURE_FLAG` /
`CURL_INSECURE_FLAG` once (`tests/e2e/lib.sh` sources it); a loopback proxy with any other stack aborts. Nothing else may spell `--insecure`
(enforced by the `tsh-insecure-guard` pre-commit hook and `.semgrep.yml`).

## Local guardrails (pre-commit)

```bash
pipx install pre-commit      # or: brew install pre-commit
make hooks                   # installs the pre-commit + pre-push hooks
pre-commit run --all-files   # warm the caches / run everything once
```

`make doctor` warns when the hooks are missing. `make lint` runs typecheck, eslint, `go vet`, gitleaks,
`pre-commit run --all-files` (when installed) and the offline CR render + kubeconform.

| Stage | Hook | Catches |
|---|---|---|
| commit | `detect-private-key`, `gitleaks` | committed credentials |
| commit | `check-yaml`, `check-json`, `end-of-file-fixer`, `trailing-whitespace`, `check-merge-conflict`, `check-added-large-files` | hygiene |
| commit | `shellcheck` (`deploy/scripts`, `tests/e2e`) | shell bugs (`--severity=warning`) |
| commit | `hadolint` (all Dockerfiles, `.hadolint.yaml`) | Dockerfile smells |
| commit | `actionlint` | workflow syntax, unpinned/invalid expressions |
| commit | `golangci-lint` (`.golangci.yml`: gosec, govet+lostcancel, errcheck, staticcheck, ineffassign, unused, bodyclose, noctx, gocritic), `gofmt` | Go defects |
| commit | `npm run typecheck` / `npm run lint` (workspaces) | TypeScript / eslint |
| commit | `tsh-insecure-guard` | hard-coded `--insecure` / `curl -k` |
| push | `semgrep` (`.semgrep.yml` + `p/golang`, `p/typescript`, `p/dockerfile`, `p/github-actions`, `p/kubernetes`) | repo-specific security rules (see below) |
| push | `make render` | rendered CRs still validate (kubeconform when installed) |

Repo Semgrep rules (`.semgrep.yml`): `InsecureSkipVerify`, trusting `X-Teleport-User`, hard-coded `--insecure`,
`POSTGRES_HOST_AUTH_METHOD=trust`, `system:masters` literals, `dangerously-skip-permissions`, `process.env` passed to
child processes, secrets in log fields, secrets on `pulumi config set` argv, `pull_request_target`, unpinned actions,
containers without `securityContext`, undigested base images. HTTP server timeouts (gosec G112/G114) and a final
`USER root` (hadolint DL3002) are enforced by golangci-lint and hadolint instead.

Before pushing a change to the policy engine, broker, MCP server, identity resolution or Pulumi policy, also run
the local `/security-review` skill in Claude Code: it is the same reviewer that runs in CI
(`claude-security-review` workflow), so findings are cheaper to fix before the PR exists.

## CI gates (`.github/workflows`)

Every workflow declares `permissions: contents: read` at the top, grants per job, pins every action to a commit SHA
(`# vX.Y.Z` comment), checks out with `persist-credentials: false`, and uses a concurrency group. No workflow uses
`pull_request_target`.

| Check (status name) | Workflow / job | What it does | Run locally |
|---|---|---|---|
| `ci / lint-and-unit` | ci.yml | `npm ci` + `npm audit --audit-level=high`, typecheck, eslint, vitest, `go vet`/`go test`, shell syntax, `make render` | `make lint test-unit` |
| `ci / pre-commit` | ci.yml | `pre-commit run --all-files` (commit + push stages) | `pre-commit run --all-files` |
| `ci / actionlint-hadolint` | ci.yml | actionlint + hadolint | `actionlint`, `hadolint **/Dockerfile` |
| `ci / govulncheck*` | ci.yml | Go vulnerability DB against the three modules | `govulncheck ./...` per module |
| `ci / osv-scanner` | ci.yml | OSV over `package-lock.json` and the three `go.mod`; SARIF to Security tab | `osv-scanner -r .` |
| `ci / semgrep` | ci.yml | `.semgrep.yml` + registry packs, `--error`, SARIF | `semgrep scan --config .semgrep.yml ...` |
| `ci / checkov` | ci.yml | rendered manifests (kubernetes) + Dockerfiles/workflows | `checkov -d tests/policy/rendered --framework kubernetes` |
| `ci / dependency-review` | ci.yml (PRs) | new dependencies with known HIGH+ vulnerabilities fail the PR | n/a |
| `ci / repo-scan` | ci.yml | Trivy `fs` (vuln + secret + misconfig) on the working tree | `trivy fs --scanners vuln,secret,misconfig .` |
| `ci / image-scan` | ci.yml | builds the three images (no push), Trivy (vuln+secret+misconfig, fail HIGH/CRITICAL, SARIF) + Grype | `make images` then `trivy image k8s-teleport/<name>:dev` |
| `ci / preview-cloud-stacks` | ci.yml | `pulumi preview` of every cloud stack against kind (`CI_PREVIEW=1`) | `CI_PREVIEW=1 make preview STACK=dev-eks ...` |
| `ci / kind-e2e` | ci.yml | full bring-up, integration + e2e; `.logs` uploaded as a 5-day artifact on failure | `make up test` |
| `codeql` | codeql.yml | CodeQL `security-extended` for Go and JS/TS (push, PR, weekly) | n/a (VS Code CodeQL extension) |
| `scorecard` | scorecard.yml | OpenSSF Scorecard, results published | `scorecard --repo=...` |
| `claude-security-review` | claude-security-review.yml | Anthropic security reviewer with `.github/claude-security-focus.md`; fails on HIGH/CRITICAL | `/security-review` |
| `claude-review` | claude-review.yml | access-model review (privilege escalation, identity binding, policy bypass, secrets); fails on `SECURITY-REVIEW: FAIL` | n/a |
| `release-images` | release-images.yml (tags `v*`) | build + push by tag only, SBOM + `provenance: mode=max`, cosign keyless sign + SBOM attest, Trivy re-scan of the pushed digest, digests in the job summary | `make images IMAGE_REGISTRY=ghcr.io/<org>/k8s-teleport IMAGE_TAG=v1.2.3` prints the same `images.digests` block |

The two Claude workflows run only for pull requests from branches of this repository
(`github.event.pull_request.head.repo.full_name == github.repository`): fork PRs cannot read the API key and must
not run with `pull-requests: write`.

### Repository secrets and settings

| Item | Where | Used by |
|---|---|---|
| `ANTHROPIC_API_KEY` | Settings -> Secrets and variables -> Actions | `claude-security-review`, `claude-review` |
| `GITHUB_TOKEN` (automatic) | n/a | everything else; `packages: write` + `id-token: write` only in `release-images` |
| Code scanning enabled | Settings -> Code security | SARIF uploads (Semgrep, Trivy, checkov, OSV, CodeQL, Scorecard) |
| Secret scanning + push protection, Dependabot alerts + security updates, read-only default workflow token, branch protection on `main` | `make repo-security REPO=owner/name` (uses `gh api`, prints every call) | required checks: `ci / lint-and-unit`, `ci / pre-commit`, `codeql`, `semgrep`, `image-scan`, `claude-security-review`; code-owner reviews, signed commits, linear history, no force-push |
| `.github/CODEOWNERS` | replace `@CHANGE-ME-security-owner` with a real team **before** enabling code-owner reviews | policy, broker/MCP, identity, workflows, Dockerfiles, scripts |
| Dependabot | `.github/dependabot.yml` | weekly: actions, npm (root + workspaces), gomod (3 modules), docker (3 Dockerfiles, refreshes `@sha256` digests) |

### Images

All three Dockerfiles pin their bases by digest: `services/teleport-access` builds on `golang:1.26-alpine` and runs
on `cgr.dev/chainguard/static` (no shell, uid 65532); `services/access-agent` builds on `cgr.dev/chainguard/node:latest-dev`
and runs on `cgr.dev/chainguard/node` (no git/apk, uid 65532, Claude Code CLI installed under `/opt/claude`,
`HEALTHCHECK` via node against `/healthz`); `deploy/images/ssh-node` runs on `cgr.dev/chainguard/wolfi-base` with only
`bash` + `shadow` (root is required because Teleport's SSH service setuids to the login user).

The agent build needs the repo root as a second build context named `lockfile` (npm workspace lockfile):
`docker build --build-context lockfile=. services/access-agent`; `make images` and both workflows pass it.
Verify a released image:

```bash
cosign verify --certificate-identity-regexp '^https://github.com/<owner>/<repo>/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/<owner>/<repo>/teleport-access@sha256:...
cosign verify-attestation --type spdxjson ... ghcr.io/<owner>/<repo>/teleport-access@sha256:...
```
