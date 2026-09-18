# Local development

Everything runs in a kind cluster called `teleport-local`, reachable at **https://teleport.127.0.0.1.nip.io:3080**.
Only host port 3080 is used, the kind cluster is never the default `kind`, and your current kube context is never changed:
every script passes `--context kind-teleport-local` explicitly.

## First run

```bash
make doctor          # what is missing, what is on a wrong version, is docker up, is port 3080 free
make tsh             # tsh / tctl / tbot into ./bin
make deps            # npm + go dependencies
make up              # kind → service images → pulumi up (local file backend) → wait → summary
```

`make up` is idempotent: run it again after any change. Pulumi state lives in `infra/.state/` (gitignored) encrypted
with `PULUMI_CONFIG_PASSPHRASE`. For `STACK=local` the Makefile falls back to the throwaway passphrase `local-dev`;
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

**Local admin (break-glass):** the local `admin` user holds `editor` + `auditor` only (no `access`, no `approver`,
no logins: it can edit Teleport configuration and read audit, but cannot reach a node, database or cluster).
`make bootstrap-admin` prints a reset link; open it (accept the self-signed certificate), set a password and OTP,
then `make login-local`. Lock it again when you are done:

```bash
make tctl ARGS="lock --user=admin --message=break-glass"
```

**Headless test users:** `make seed-test-users` enrols `alice` (requester) and `bob` (requester + approver) with a
password and TOTP secret stored in `tests/.state/users.json` for the e2e scripts (which drive `tsh login` with
`expect`, preinstalled on macOS; `apt-get install expect` on Linux).

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
make login-local USER_NAME=alice         # ./bin/tsh $TSH_INSECURE_FLAG --proxy teleport.127.0.0.1.nip.io:3080 login --auth local --user alice
tsh ls                                   # nothing: requester has no standing access
tsh request create --roles dev-ssh --reason "poking around"   # auto-approved by the broker
tsh ssh dev@ssh-dev-0 hostname
tsh request create --roles prod-ssh --reason "incident 123" --nowait   # needs an approver
make requests && make approve ID=<id>
```

## Troubleshooting

- `make doctor` first. Then `make events` and `make logs SVC=operator`.
- Every long step writes a log to `.logs/<step>.log`; failures print the tail and the command to rerun.
- The proxy certificate is self-signed locally: the Makefile and scripts add `--insecure` / `curl -k` **only** when
  `STACK=local` and the proxy is `*.127.0.0.1.nip.io` (`TSH_INSECURE_FLAG` in `deploy/scripts/_common.sh`);
  any other stack verifies TLS, and a loopback proxy with a non-local stack aborts. Browsers need one click.
- `make agent-cli` only works for `STACK=local`: it reads the MCP/broker tokens and the identity signing key from the
  stack outputs and port-forwards into the kind cluster.
- `*.nip.io` needs internet DNS. Offline, add `127.0.0.1 teleport.127.0.0.1.nip.io` to `/etc/hosts`.
