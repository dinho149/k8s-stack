#!/usr/bin/env bash
# down.sh — destroy the Teleport stack (make teleport-down). The kind cluster is Dogfood's and is left alone:
# `make down` removes it. For the local stack the dead Pulumi state and the seeded credentials are dropped too.
source "$(dirname "$0")/_common.sh"
S="$REPO_ROOT/deploy/teleport/scripts"
common::require_cloud_secrets
INFRA="$REPO_ROOT/infra/teleport"
backend="${PULUMI_BACKEND_URL:-file://$REPO_ROOT/.dogfood/teleport/pulumi}"
if [[ "$STACK" == "local" ]]; then export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-local-dev}"; fi
export PULUMI_COLOR="${PULUMI_COLOR:-$([[ -n "${CI:-}${NO_COLOR:-}" ]] && echo never || echo always)}"
ui::section "Tearing down Teleport stack $STACK"
if (cd "$INFRA" && pulumi login "$backend" >/dev/null 2>&1 && pulumi stack select "$STACK" >/dev/null 2>&1); then
  "$S/pulumi-run.sh" destroy "$STACK" --exclude-protected || true
  if [[ "$STACK" != "local" ]]; then
    ui::info "protected resources (namespace, state PVC) are kept on purpose: pulumi state unprotect + pulumi destroy to remove them"
  fi
else ui::info "no Pulumi stack '$STACK' in $backend — nothing to destroy"; fi
if [[ "$STACK" == "local" ]]; then
  (cd "$INFRA" && pulumi stack rm "$STACK" --yes --force --preserve-config >/dev/null 2>&1) \
    && ui::ok "dropped the stack state of '$STACK' (Pulumi.local.yaml kept)" || true
  rm -f "$STATE_DIR/users.json" "$STATE_DIR/harness.identity" "$UI_LOG_DIR"/.totp-window-*
  ui::ok "local Teleport stack torn down — seeded credentials removed; make teleport-up recreates everything"
fi
