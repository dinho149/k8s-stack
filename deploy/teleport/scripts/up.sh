#!/usr/bin/env bash
# up.sh — bring the Teleport stack up on the Dogfood kind cluster (make teleport-up):
#   doctor → tsh/tctl → optional mkcert certificate → service images → pulumi up → wait → local users → summary
# The kind cluster itself is created by Dogfood (make local / make up); this script only deploys into it.
# Idempotent: run it again after any change.
source "$(dirname "$0")/_common.sh"
S="$REPO_ROOT/deploy/teleport/scripts"
common::require_cloud_secrets
export PULUMI_COLOR="${PULUMI_COLOR:-$([[ -n "${CI:-}${NO_COLOR:-}" ]] && echo never || echo always)}"

ui::section "1/7 Toolchain"
if "$S/doctor.sh" >"$UI_LOG_DIR/teleport-doctor.log" 2>&1; then ui::ok "doctor passed"; else "$S/doctor.sh"; exit 1; fi
[[ -x "$BIN_DIR/tsh" ]] || "$S/install-tsh.sh"
[[ -d "$REPO_ROOT/node_modules/@pulumi" ]] || ui::die "npm dependencies missing — run: make setup"

ui::section "2/7 TLS certificate (optional)"
"$S/local-tls.sh"

ui::section "3/7 kind cluster"
if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then ui::ok "kind cluster $KIND_CLUSTER"
else ui::die "kind cluster $KIND_CLUSTER not found — create it with: make local   (or: make up)"; fi

ui::section "4/7 Service images"
"$S/load-images.sh" "${IMAGE_TAG:-dev}"

ui::section "5/7 Pulumi ($STACK)"
"$S/stack-init.sh"
# shellcheck disable=SC2086 # PULUMI_ARGS is a user-provided list of extra pulumi flags
"$S/pulumi-run.sh" up "$STACK" ${PULUMI_ARGS:-}

ui::section "6/7 Waiting for Teleport"
"$S/wait-teleport.sh"

ui::section "7/7 Local users"
if [[ "$STACK" == "local" ]]; then "$S/bootstrap-users.sh"; else ui::info "STACK=$STACK: users come from SSO (make teleport-github-sso)"; fi

TLS_NOTE="$(common::tls_note)"
ui::box "Teleport is up" \
  "Web UI      https://$PROXY_ADDR   ($TLS_NOTE)" \
  "Login       make teleport-login       (tsh; GitHub SSO if configured, else admin via password+TOTP, no prompts)" \
  "            make teleport-web-login   (browser: prints user / password / TOTP; USER_NAME=alice|bob)" \
  "Optional    make teleport-github-sso  (switch the login to GitHub SSO)" \
  "Dashboard   make teleport-status  /  make teleport-urls  /  make teleport-requests" \
  "Agent REPL  make teleport-agent-cli" \
  "Tear down   make teleport-down        (the kind cluster stays; make down removes it)"
if [[ "$STACK" == "local" && "${WEB_LOGIN:-1}" != 0 && -t 1 && -z "${CI:-}" ]]; then "$S/web-login.sh"; fi
