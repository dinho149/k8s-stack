# Local development

Teleport runs in the Dogfood kind cluster `dogfood-local`, reachable at **https://teleport.127.0.0.1.nip.io:3080**.
Only host port 3080 is added to Dogfood's ports (NodePort 30380 inside the cluster), and your current kube context is
never changed: every script passes `--context kind-dogfood-local` explicitly.

## First run

```bash
make setup           # Dogfood dependencies (npm workspaces, Go modules, Chromium)
make teleport-up     # doctor → tsh → TLS cert → images → pulumi up → wait → local users → summary
make up TELEPORT=1   # or: the Dogfood stack (cluster, lifecycle API, Backstage, portal) and Teleport in one go
```

`make teleport-up` creates the kind cluster through Dogfood's bootstrap when it does not exist yet (`make local`),
then deploys Teleport into it. Along the way it:

- installs `tsh`/`tctl` into `./bin` when they are missing (`make teleport-tsh`);
- **optionally** sets up a browser-trusted certificate: one question on the first run ("Set up a browser-trusted
  certificate … with mkcert? [Y/n]"). Yes installs mkcert if needed, runs `mkcert -install` (macOS asks for your
  password once) and issues a certificate for `teleport.127.0.0.1.nip.io` — no "connection is not private" page.
  No is remembered and the proxy keeps a self-signed certificate (one click in the browser). Change your mind any
  time with `make teleport-tls && make teleport-deploy`; `LOCAL_TLS=0` (in `.env` or on the command line) never asks, `LOCAL_TLS=1`
  never asks either and always sets it up. Without a terminal (CI) nothing is installed. On Linux install mkcert
  yourself (`apt install mkcert libnss3-tools`) and run `make teleport-tls`;
- enrols the local users `admin`, `alice` and `bob` headlessly (password + TOTP) so `make teleport-login` works immediately;
- opens the web UI sign-in page and prints admin's username, password and a fresh authenticator code to paste
  (`WEB_LOGIN=0` skips this; `make teleport-web-login` repeats it any time).

`make teleport-doctor` alone shows what is missing or on a wrong version. `make teleport-up` is idempotent: run it
again after any change. Pulumi state lives in `.dogfood/teleport/pulumi/` (gitignored) encrypted with
`PULUMI_CONFIG_PASSPHRASE`. For `STACK=local` the scripts fall back to the throwaway passphrase `local-dev`;
every other stack is refused (`make teleport-secrets-guard`) until it uses a shared backend (`PULUMI_BACKEND_URL=s3://...`,
`gs://`, `azblob://` or Pulumi Cloud) and a KMS secrets provider
(`pulumi stack init dev-eks --secrets-provider="awskms://alias/teleport?region=eu-west-1"`), see [cloud.md](cloud.md).

Install the git hooks once: `make teleport-hooks` (needs `pre-commit`; `make teleport-doctor` reminds you). They run
gitleaks, shellcheck, hadolint, actionlint, golangci-lint, typecheck/eslint on commit and semgrep +
`make teleport-render` on push; CI runs the same set, so skipping them locally only moves the failure. Details in
[testing.md](testing.md).

## Logging in

**GitHub SSO (default):**

1. Create an OAuth App at https://github.com/settings/developers with callback
   `https://teleport.127.0.0.1.nip.io:3080/v1/webapi/github/callback` (see `make teleport-urls`).
2. `make teleport-github-sso` stores the client id/secret as Pulumi secrets and maps GitHub teams to roles.
3. `make teleport-deploy` then `make teleport-login`. New users land on `requester` only.

**Local users (default until SSO is configured):** `make teleport-up` enrols `admin`, `alice` and `bob` with a
generated password and TOTP secret, stored in `.dogfood/teleport/state/users.json` (gitignored, mode 0600). Two ways in:

```bash
make teleport-login                    # tsh: picks GitHub SSO when a connector exists, else logs in headlessly as admin
make teleport-login USER_NAME=alice    # any seeded user
make teleport-web-login                # opens the web UI and prints user / password / a fresh TOTP code to paste
```

`tsh login` is driven with `expect` (preinstalled on macOS; `apt-get install expect` on Linux). Teleport rejects a
reused TOTP code, so consecutive logins may wait up to 30 s for a new window.

The local `admin` user is break-glass: `editor` + `auditor` only (no `access`, no `approver`, no logins: it can edit
Teleport configuration and read audit, but cannot reach a node, database or cluster). `make teleport-bootstrap-admin` rotates
its credentials. Lock it again when you are done:

```bash
make teleport-tctl ARGS="lock --user=admin --message=break-glass"
```

`make teleport-bootstrap-users USERS=alice,bob` (alias `make teleport-seed-test-users`) re-seeds only the test users; users already in
`users.json` are skipped because a reset token wipes their MFA devices.

## Day to day

| Command | |
|---|---|
| `make teleport-status` / `make status` | Teleport dashboard / the Dogfood one (with a Teleport row) |
| `make teleport-urls` | every URL you can open |
| `make teleport-logs SVC=auth\|proxy\|operator\|kube-agent\|ssh\|postgres\|broker\|mcp\|agent` | follow logs |
| `make teleport-requests`, `make teleport-approve ID=…`, `make teleport-deny ID=…` | access requests from the terminal |
| `make teleport-agent-cli AS=alice` | talk to the access agent without any chat platform (uses your Claude Code login) |
| `make teleport-claude-token` | store a Claude Pro/Max token for the in-cluster agent (`claude setup-token`; the token goes to Pulumi over stdin, never argv) |
| `make teleport-hooks` / `make lint` | install the pre-commit hooks / run every linter and scanner locally |
| `make teleport-tctl ARGS="get roles"` | any `tctl` command inside the auth pod |
| `make teleport-port-forward SVC=mcp\|broker\|agent` | port-forward an access service to 18380 / 18381 / 18382 |
| `CI_PREVIEW=1 make teleport-preview STACK=dev-eks PULUMI_ARGS="--config teleport:kubeContext=kind-dogfood-local"` | render a cloud stack against the kind context (`CI_PREVIEW=1` skips the cloud secrets guard for preview only) |
| `make teleport-down` / `make down` / `make reset CONFIRM=dogfood-local` | destroy the Teleport stack / also delete the cluster / also wipe all local state |

## Trying the access model

```bash
make teleport-login USER_NAME=alice      # headless password + TOTP login (credentials seeded by make teleport-up)
tsh ls                                   # nothing: requester has no standing access
tsh request create --roles dev-ssh --reason "poking around"   # auto-approved by the broker
tsh ssh dev@ssh-dev-0 hostname
tsh request create --roles prod-ssh --reason "incident 123" --nowait   # needs an approver
make teleport-requests && make teleport-approve ID=<id>
```

The web UI cannot raise or review requests on Community Edition: `Identity Governance → Access Requests` only shows
the "Unlock Access Requests With Teleport Enterprise" page. Requests are created with `tsh request create`, the
access agent (`make teleport-agent-cli AS=alice`, or the Slack / Teams / Google Chat adapters) or the MCP server, and
approved with `tsh request review --approve <id>` (as `bob`), `make teleport-approve`, or the agent's approver card. A grant lives
in the `tsh` session that assumed it (`tsh login --request-id=<id>`), so the elevated resources appear in `tsh ls`,
`tsh db ls`, `tsh kube ls` and `tsh apps ls` rather than in the browser; the web UI is still the place for Audit
(events, session recordings) and, as `admin`, for Zero Trust Access → Roles / Users. Holding a catalog role also
denies creating another request (every catalog role denies `create` on all resources): `tsh request drop` first.

## Troubleshooting

- `make teleport-doctor` first. Then `make teleport-logs SVC=operator`.
- Every long step writes a log to `.dogfood/logs/teleport/<step>.log`; failures print the tail and the command to
  rerun. `pulumi up` and `pulumi destroy` show a single progress line; the raw event stream is in
  `.dogfood/logs/teleport/pulumi-up-local.log` / `pulumi-destroy-local.log`, and a failed run prints Pulumi's
  Diagnostics block.
- Browser trust: `make teleport-up` / `make teleport-tls` use mkcert, whose root CA lives in your system trust store
  (Firefox needs `brew install nss` before `mkcert -install`). Regenerate the certificate with
  `rm -rf .dogfood/teleport/tls && make teleport-tls && make teleport-deploy`. The in-cluster components (tbot, kube
  agent, the database CA fetch) do not trust that CA, so the scripts still add `--insecure` / `curl -k` **only** when
  `STACK=local` and the proxy is `*.127.0.0.1.nip.io` (`TSH_INSECURE_FLAG` in `deploy/teleport/scripts/_common.sh`);
  any other stack verifies TLS, and a loopback proxy with a non-local stack aborts.
- `make teleport-login` says "invalid credentials": the cluster was recreated after the credentials were seeded. Run
  `make teleport-bootstrap-users` (or `make teleport-up`); `make down` removes stale credentials automatically. A
  working session is reused ("already logged in"); `make teleport-login TSH_RELOGIN=1` forces a fresh one.
- `make teleport-agent-cli` only works for `STACK=local`: it reads the MCP/broker tokens and the identity signing key
  from the stack outputs and port-forwards into the kind cluster (18380 / 18381).
- Cilium enforces the Teleport NetworkPolicies on `dogfood-local`. If a Teleport pod cannot reach the API server,
  check `kubectl -n kube-system exec ds/cilium -- cilium-dbg monitor --type drop` and that Cilium was installed with
  `policyCIDRMatchMode=nodes` (`scripts/bootstrap.sh`).
- `*.nip.io` needs internet DNS. Offline, add `127.0.0.1 teleport.127.0.0.1.nip.io` to `/etc/hosts`.
