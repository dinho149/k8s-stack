# Local development

Everything runs in a kind cluster called `teleport-local`, reachable at **https://teleport.127.0.0.1.nip.io:3080**.
Only host port 3080 is used, the kind cluster is never the default `kind`, and your current kube context is never changed:
every script passes `--context kind-teleport-local` explicitly.

## First run

```bash
make up              # everything: doctor → tsh + deps → TLS cert → kind → images → pulumi up → wait → local users → summary
```

That is the whole first run. Along the way `make up`:

- installs `tsh`/`tctl` into `./bin` and the npm/go dependencies when they are missing (`make tsh`, `make deps`);
- **optionally** sets up a browser-trusted certificate: one question on the first run ("Set up a browser-trusted
  certificate … with mkcert? [Y/n]"). Yes installs mkcert if needed, runs `mkcert -install` (macOS asks for your
  password once) and issues a certificate for `teleport.127.0.0.1.nip.io` — no "connection is not private" page.
  No is remembered and the proxy keeps a self-signed certificate (one click in the browser). Change your mind any
  time with `make tls && make deploy`; `LOCAL_TLS=0` (in `.env` or on the command line) never asks, `LOCAL_TLS=1`
  never asks either and always sets it up. Without a terminal (CI) nothing is installed. On Linux install mkcert
  yourself (`apt install mkcert libnss3-tools`) and run `make tls`;
- enrols the local users `admin`, `alice` and `bob` headlessly (password + TOTP) so `make login` works immediately;
- opens the web UI sign-in page and prints admin's username, password and a fresh authenticator code to paste
  (`WEB_LOGIN=0` skips this; `make web-login` repeats it any time).

`make doctor` alone shows what is missing or on a wrong version. `make up` is idempotent: run it again after any
change. Pulumi state lives in `infra/.state/` (gitignored) encrypted with `PULUMI_CONFIG_PASSPHRASE`. For `STACK=local` the Makefile falls back to the throwaway passphrase `local-dev`;
every other stack is refused (`make secrets-guard`) until it uses a shared backend (`PULUMI_BACKEND_URL=s3://...`,
`gs://`, `azblob://` or Pulumi Cloud) and a KMS secrets provider
(`pulumi stack init dev-eks --secrets-provider="awskms://alias/teleport?region=eu-west-1"`), see `docs/cloud.md`.

Install the git hooks once: `make hooks` (needs `pre-commit`; `make doctor` reminds you). They run gitleaks,
shellcheck, hadolint, actionlint, golangci-lint, typecheck/eslint on commit and semgrep + `make render` on push;
CI runs the same set, so skipping them locally only moves the failure. Details in `docs/testing.md`.

## Logging in

**GitHub SSO (default):**

1. Create an OAuth App at https://github.com/settings/developers with callback
   `https://teleport.127.0.0.1.nip.io:3080/v1/webapi/github/callback` (see `make urls`).
2. `make github-sso` stores the client id/secret as Pulumi secrets and maps GitHub teams to roles.
3. `make deploy` then `make login`. New users land on `requester` only.

**Local users (default until SSO is configured):** `make up` enrols `admin`, `alice` and `bob` with a generated
password and TOTP secret, stored in `tests/.state/users.json` (gitignored, mode 0600). Two ways in:

```bash
make login                    # tsh: picks GitHub SSO when a connector exists, else logs in headlessly as admin
USER_NAME=alice make login    # any seeded user
make web-login                # opens the web UI and prints user / password / a fresh TOTP code to paste
```

`tsh login` is driven with `expect` (preinstalled on macOS; `apt-get install expect` on Linux). Teleport rejects a
reused TOTP code, so consecutive logins may wait up to 30 s for a new window.

The local `admin` user is break-glass: `editor` + `auditor` only (no `access`, no `approver`, no logins: it can edit
Teleport configuration and read audit, but cannot reach a node, database or cluster). `make bootstrap-admin` rotates
its credentials. Lock it again when you are done:

```bash
make tctl ARGS="lock --user=admin --message=break-glass"
```

`make bootstrap-users USERS=alice,bob` (alias `make seed-test-users`) re-seeds only the test users; users already in
`users.json` are skipped because a reset token wipes their MFA devices.

## Day to day

| Command | |
|---|---|
| `make status` / `make watch` | dashboard |
| `make urls` | every URL you can open |
| `make logs SVC=auth\|proxy\|operator\|kube-agent\|ssh\|postgres\|broker\|mcp\|agent` | follow logs |
| `make requests`, `make approve ID=…`, `make deny ID=…` | access requests from the terminal |
| `make agent-cli AS=alice` | talk to the access agent without any chat platform (uses your Claude Code login) |
| `make claude-token` | store a Claude Pro/Max token for the in-cluster agent (`claude setup-token`; the token goes to Pulumi over stdin, never argv) |
| `make hooks` / `make lint` | install the pre-commit hooks / run every linter and scanner locally |
| `make tctl ARGS="get roles"` | any `tctl` command inside the auth pod |
| `CI_PREVIEW=1 make preview STACK=dev-eks PULUMI_ARGS="--config teleport:kubeContext=kind-teleport-local"` | render a cloud stack against the kind context (`CI_PREVIEW=1` skips the cloud secrets guard for preview only) |
| `make down` / `make nuke` | tear down / also wipe local state |

## Trying the access model

```bash
USER_NAME=alice make login               # headless password + TOTP login (credentials seeded by make up)
tsh ls                                   # nothing: requester has no standing access
tsh request create --roles dev-ssh --reason "poking around"   # auto-approved by the broker
tsh ssh dev@ssh-dev-0 hostname
tsh request create --roles prod-ssh --reason "incident 123" --nowait   # needs an approver
make requests && make approve ID=<id>
```

The web UI cannot raise or review requests on Community Edition: `Identity Governance → Access Requests` only shows
the "Unlock Access Requests With Teleport Enterprise" page. Requests are created with `tsh request create`, the
access agent (`make agent-cli AS=alice`, or the Slack / Teams / Google Chat adapters) or the MCP server, and approved
with `tsh request review --approve <id>` (as `bob`), `make approve`, or the agent's approver card. A grant lives
in the `tsh` session that assumed it (`tsh login --request-id=<id>`), so the elevated resources appear in `tsh ls`,
`tsh db ls`, `tsh kube ls` and `tsh apps ls` rather than in the browser; the web UI is still the place for Audit
(events, session recordings) and, as `admin`, for Zero Trust Access → Roles / Users. Holding a catalog role also
denies creating another request (every catalog role denies `create` on all resources): `tsh request drop` first.

## Troubleshooting

- `make doctor` first. Then `make events` and `make logs SVC=operator`.
- Every long step writes a log to `.logs/<step>.log`; failures print the tail and the command to rerun. `pulumi up`
  and `pulumi destroy` show a single progress line; the raw event stream is in `.logs/pulumi-up-local.log` /
  `.logs/pulumi-destroy-local.log`, and a failed run prints Pulumi's Diagnostics block.
- Browser trust: `make up` / `make tls` use mkcert, whose root CA lives in your system trust store (Firefox needs
  `brew install nss` before `mkcert -install`). Regenerate the certificate with `rm -rf infra/.state/tls && make tls
  && make deploy`. The in-cluster components (tbot, kube agent, the database CA fetch) do not trust that CA, so the
  Makefile and scripts still add `--insecure` / `curl -k` **only** when `STACK=local` and the proxy is
  `*.127.0.0.1.nip.io` (`TSH_INSECURE_FLAG` in `deploy/scripts/_common.sh`); any other stack verifies TLS, and a
  loopback proxy with a non-local stack aborts.
- `make login` says "invalid credentials": the cluster was recreated after the credentials were seeded. Run
  `make bootstrap-users` (or `make up`); `make down` removes stale credentials automatically. A working session
  is reused ("already logged in"); `TSH_RELOGIN=1 make login` forces a fresh one.
- `make agent-cli` only works for `STACK=local`: it reads the MCP/broker tokens and the identity signing key from the
  stack outputs and port-forwards into the kind cluster.
- `*.nip.io` needs internet DNS. Offline, add `127.0.0.1 teleport.127.0.0.1.nip.io` to `/etc/hosts`.
