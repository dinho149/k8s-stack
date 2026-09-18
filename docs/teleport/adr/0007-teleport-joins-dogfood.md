# ADR 0007: Teleport joins the Dogfood repository

Date: 2026-09-18. Status: accepted.

## Context

Teleport Community Edition locks its own access-request web pages behind Enterprise, while its access-request API
works. We want our own UI for every just-in-time access activity, and that UI should be the Dogfood developer
portal rather than a second portal. Keeping Teleport in a separate repository would make the portal depend on
another repository's services, duplicate the kind cluster, the Make interface, CI and the agent.

## Decision

- `k8s-teleport` is imported into `k8s-stack` with its full history (`git subtree add`, then a renames-only commit)
  and archived. All further work happens here.
- The Go code joins the root module (`cmd/teleport-access`, `internal/teleportaccess/*`), so one `go vet`,
  `go test`, `govulncheck` and `golangci-lint` run covers everything, and a future portal API subcommand can import
  `internal/platform`. The root module moves to Go 1.26.6 (the Teleport API's requirement).
- Teleport deploys into the Dogfood kind cluster `dogfood-local`. The kind config maps host port 3080 to NodePort
  30380 (30080 is the Envoy gateway); the CoreDNS rewrite for `teleport.127.0.0.1.nip.io` stays a Pulumi component;
  Cilium is installed with `policyCIDRMatchMode=nodes` so Teleport's `ipBlock` egress rule to the API server holds.
- Teleport stays Pulumi-managed. It is not an Argo CD application and not in `catalog/components.json`; the Kyverno
  baseline only matches `dogfood.platform/managed` namespaces and the Teleport namespaces are never labelled so.
- `make up` does not start Teleport by default (`make teleport-up`, or `make up TELEPORT=1`): Pulumi plus Teleport
  add minutes and a few GB of RAM that preview work does not need. The Teleport scripts keep their own terminal UI
  and run in the foreground from `scripts/local.py`.
- Local state lives under `.dogfood/teleport/` and is removed with the cluster by `make down`.
- The `access-agent` (Slack / Teams / Google Chat) and Dogfood's own agent overlap. Convergence is a later step:
  Dogfood's Claude Agent SDK agent can connect to the Teleport MCP server over Streamable HTTP with the signed
  identity assertion contract (ADR 0006, `internal/teleportaccess/assertion`,
  `services/access-agent/src/identity/assertion.ts`).

## Consequences

- Host ports: 3080 (Teleport proxy) joins the Dogfood list; port-forwards move to 18380–18383.
- The pre-commit, semgrep, hadolint and shellcheck configurations came with Teleport and are path-scoped to its
  trees until the Dogfood trees adopt them; the Go hooks already cover the whole module.
- The imported TypeScript keeps its own formatting (`.prettierignore`) until it is reformatted in a follow-up.
- The Pulumi `LocalDns` component replaces the whole CoreDNS Corefile on kind; Dogfood does not customise CoreDNS
  today, so that is acceptable, and the rewrite only matches the Teleport host names.
- Cloud stack files keep their `k8s-teleport` image names and tags until a cloud stack is deployed from here.
