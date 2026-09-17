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
with `PULUMI_CONFIG_PASSPHRASE` (default `local-dev`; put a real one in `.env`).

## Logging in

**GitHub SSO (default):**

1. Create an OAuth App at https://github.com/settings/developers with callback
   `https://teleport.127.0.0.1.nip.io:3080/v1/webapi/github/callback` (see `make urls`).
2. `make github-sso` stores the client id/secret as Pulumi secrets and maps GitHub teams to roles.
3. `make deploy` then `make login`. New users land on `requester` only.

**Local admin (break-glass):** `make bootstrap-admin` prints a reset link; open it (accept the self-signed certificate),
set a password and OTP, then `make login-local`.

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
| `make claude-token` | store a Claude Pro/Max token for the in-cluster agent (`claude setup-token`) |
| `make tctl ARGS="get roles"` | any `tctl` command inside the auth pod |
| `make preview STACK=dev-eks` | render a cloud stack against the kind context |
| `make down` / `make nuke` | tear down / also wipe local state |

## Trying the access model

```bash
./bin/tsh --insecure --proxy teleport.127.0.0.1.nip.io:3080 login --auth local --user alice
tsh ls                                   # nothing: requester has no standing access
tsh request create --roles dev-ssh --reason "poking around"   # auto-approved by the broker
tsh ssh dev@ssh-dev-0 hostname
tsh request create --roles prod-ssh --reason "incident 123" --nowait   # needs an approver
make requests && make approve ID=<id>
```

## Troubleshooting

- `make doctor` first. Then `make events` and `make logs SVC=operator`.
- Every long step writes a log to `.logs/<step>.log`; failures print the tail and the command to rerun.
- The proxy certificate is self-signed locally: `tsh --insecure` is baked into the Makefile, browsers need one click.
- `*.nip.io` needs internet DNS. Offline, add `127.0.0.1 teleport.127.0.0.1.nip.io` to `/etc/hosts`.
