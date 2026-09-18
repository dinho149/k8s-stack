#!/usr/bin/env bash
# preview.sh — `pulumi preview --diff` for $STACK (make teleport-preview).
# CI_PREVIEW=1 lets a cloud stack render against the kind context with the file backend + throwaway passphrase,
# which is what the teleport CI workflow does; deploy/up/down never skip the secrets guard.
export COMMON_SKIP_PROXY_CHECK=1
source "$(dirname "$0")/_common.sh"
[[ "${CI_PREVIEW:-}" == "1" ]] || common::require_cloud_secrets
INFRA="$REPO_ROOT/infra/teleport"
backend="${PULUMI_BACKEND_URL:-file://$REPO_ROOT/.dogfood/teleport/pulumi}"
if [[ "$STACK" == "local" || "${CI_PREVIEW:-}" == "1" ]]; then export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-local-dev}"; fi
[[ "$backend" == file://* ]] && mkdir -p "${backend#file://}"
(cd "$INFRA" && pulumi login "$backend" >/dev/null)
(cd "$INFRA" && pulumi stack select "$STACK" 2>/dev/null) || (cd "$INFRA" && pulumi stack init "$STACK" --secrets-provider "${PULUMI_SECRETS_PROVIDER:-passphrase}")
ui::section "pulumi preview ($STACK)"
export TELEPORT_ALLOW_KIND_CONTEXT=1
color="$([[ -n "${CI:-}${NO_COLOR:-}" ]] && echo never || echo always)"
# shellcheck disable=SC2086 # PULUMI_ARGS is a user-provided list of extra pulumi flags
(cd "$INFRA" && pulumi --non-interactive --color "$color" preview --stack "$STACK" --diff ${PULUMI_ARGS:-})
