#!/usr/bin/env bash
# stack-init.sh — log in to the Pulumi backend and select (or create) the stack for $STACK.
#   local: file backend under .dogfood/teleport/pulumi + the throwaway passphrase (see _common.sh / .env.example)
#   cloud: refused unless a shared backend and a KMS secrets provider (or a real passphrase) are configured.
source "$(dirname "$0")/_common.sh"
common::require_cloud_secrets
INFRA="$REPO_ROOT/infra/teleport"
backend="${PULUMI_BACKEND_URL:-file://$REPO_ROOT/.dogfood/teleport/pulumi}"
if [[ "$STACK" == "local" ]]; then export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-local-dev}"; fi
ui::step "Pulumi backend $backend"
[[ "$backend" == file://* ]] && mkdir -p "${backend#file://}"
(cd "$INFRA" && pulumi login "$backend" >/dev/null)
if ! (cd "$INFRA" && pulumi stack select "$STACK" 2>/dev/null); then
  (cd "$INFRA" && pulumi stack init "$STACK" --secrets-provider "${PULUMI_SECRETS_PROVIDER:-passphrase}")
fi
ui::ok "stack $STACK selected"
