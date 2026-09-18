# Coming from the standalone `k8s-teleport` repository

Teleport moved into this repository with its full history (`git subtree add`, then a renames-only commit, so
`git log --follow` works across the move). The standalone repository is archived. What changed for you:

| Before (`k8s-teleport`) | Now (`k8s-stack`) |
|---|---|
| kind cluster `teleport-local` (host port 3080 → NodePort 30080) | the Dogfood cluster `dogfood-local` (host port 3080 → NodePort 30380; 30080 belongs to the Envoy gateway) |
| `make up` | `make teleport-up` (or `make up TELEPORT=1`); the cluster itself comes from `make local` / `make up` |
| `make login`, `make web-login`, `make status`, `make requests`, `make approve ID=…`, `make tctl ARGS=…`, `make logs SVC=…`, `make agent-cli AS=…`, `make tls`, `make github-sso`, `make claude-token`, `make render`, `make test-integration`, `make test-e2e`, `make hooks` | the same names with a `teleport-` prefix (`make help-all`, group **Teleport**) |
| `make deploy` / `make preview` / `make images` / `make tsh` / `make down` | `make teleport-deploy` / `teleport-preview` / `teleport-images` / `teleport-tsh` / `teleport-down` |
| `make deps`, `make kind-up`, `make doctor` (toolchain) | `make setup`, `make local`, `make doctor` (Dogfood) + `make teleport-doctor` (Teleport tools) |
| `make nuke` | `make reset CONFIRM=dogfood-local` |
| `services/teleport-access` (own Go module) | `cmd/teleport-access` + `internal/teleportaccess/*` in the root module `github.com/yeaboi/k8s-stack` |
| `deploy/scripts`, `deploy/images`, `deploy/kind/cluster.yaml` | `deploy/teleport/scripts`, `deploy/teleport/images`; the kind config is `deploy/kind/config.yaml` |
| `tests/{integration,e2e,tools,mcp,policy}` | `tests/teleport/{…}` |
| `docs/`, `services/contracts/broker.openapi.yaml` | `docs/teleport/`, `docs/teleport/contracts/broker.openapi.yaml` |
| `infra/.state` (Pulumi), `infra/.state/tls` (mkcert), `tests/.state` (seeded users), `.logs` | `.dogfood/teleport/pulumi`, `.dogfood/teleport/tls`, `.dogfood/teleport/state`, `.dogfood/logs/teleport` |
| port-forwards 18080 (MCP), 18081 (broker), 18082 (agent) | 18380, 18381, 18382 (18080 is the Dogfood gateway); 18383 is reserved for the access portal API |
| `.env` at the repo root | still `.env` at the repo root; the Teleport block is documented in `.env.example` |
| npm packages `@k8s-teleport/infra`, `@k8s-teleport/access-agent` | `@dogfood/teleport-infra`, `@dogfood/access-agent` (workspaces of the root `package.json`) |
| CI `ci.yml` | `.github/workflows/teleport.yaml` (path-filtered) next to Dogfood's `checks.yaml`; image releases on `teleport-v*` tags |

Before the first `make teleport-up` here, run `make down` in your old `k8s-teleport` checkout: it deletes the
`teleport-local` kind cluster, which otherwise keeps host port 3080.

The cloud stack files (`infra/teleport/Pulumi.dev-*.yaml`, `Pulumi.prod-eks.yaml`) still tag resources with
`project: k8s-teleport` and expect images named `k8s-teleport/<service>`; no cloud stack has been deployed from
this repository yet, so they were left untouched.
