#!/usr/bin/env bash
# Shared environment for deploy scripts. Sourced, not executed.
set -euo pipefail
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# shellcheck source=lib/ui.sh
source "$REPO_ROOT/deploy/scripts/lib/ui.sh"
[[ -f "$REPO_ROOT/.env" ]] && set -a && source "$REPO_ROOT/.env" && set +a

STACK="${STACK:-local}"
KIND_CLUSTER="${KIND_CLUSTER:-teleport-local}"
KUBE_CONTEXT="${KUBE_CONTEXT:-kind-$KIND_CLUSTER}"
TELEPORT_VERSION="${TELEPORT_VERSION:-18.11.1}"
TELEPORT_NAMESPACE="${TELEPORT_NAMESPACE:-teleport}"
TELEPORT_RELEASE="${TELEPORT_RELEASE:-teleport-cluster}"
PROXY_ADDR="${PROXY_ADDR:-teleport.127.0.0.1.nip.io:3080}"
# shellcheck disable=SC2034 # consumed by the scripts that source this file
BIN_DIR="$REPO_ROOT/bin"
# shellcheck disable=SC2034
STATE_DIR="$REPO_ROOT/tests/.state"
# shellcheck disable=SC2034
KUBECTL="kubectl --context $KUBE_CONTEXT"
export UI_LOG_DIR="$REPO_ROOT/.logs"

if [[ "$KIND_CLUSTER" == "kind" ]]; then ui::die "refusing to operate on the default kind cluster 'kind' (KIND_CLUSTER=kind)"; fi

# ---------------------------------------------------------------------------- TLS verification policy
# The kind stack serves a self-signed certificate on *.127.0.0.1.nip.io, so tsh/tctl/curl must skip
# verification there. That is the ONLY combination where skipping is allowed: STACK=local AND the proxy
# is the loopback nip.io host. Any other stack, or a local stack pointed at a real host, verifies TLS.
# Scripts must use $TSH_INSECURE_FLAG / $CURL_INSECURE_FLAG and never spell --insecure / -k themselves
# (enforced by .semgrep.yml and the tsh-insecure-guard pre-commit hook).
TSH_INSECURE_FLAG=""
CURL_INSECURE_FLAG=""
if [[ "$STACK" == "local" && "$PROXY_ADDR" == *.127.0.0.1.nip.io* ]]; then
  TSH_INSECURE_FLAG="--insecure"
  CURL_INSECURE_FLAG="-k"
elif [[ "$PROXY_ADDR" == *.127.0.0.1.nip.io* && -z "${COMMON_SKIP_PROXY_CHECK:-}" ]]; then
  ui::die "PROXY_ADDR=$PROXY_ADDR is the loopback kind host but STACK=$STACK is not 'local'. Set STACK=local or point PROXY_ADDR at the real proxy of stack $STACK."
fi
export TSH_INSECURE_FLAG CURL_INSECURE_FLAG
# shellcheck disable=SC2089 # intentionally a string that is word-split when invoked as $TSH
TSH="${TSH:-$BIN_DIR/tsh ${TSH_INSECURE_FLAG:+$TSH_INSECURE_FLAG }--proxy $PROXY_ADDR}"

# ---------------------------------------------------------------------------- Pulumi secrets policy
# The file backend + a well-known passphrase are fine for the throwaway kind stack and nothing else.
# common::require_cloud_secrets is called by targets that touch a non-local stack.
common::require_cloud_secrets() {
  [[ "$STACK" == "local" ]] && return 0
  local backend="${PULUMI_BACKEND_URL:-file://$REPO_ROOT/infra/.state}" pass="${PULUMI_CONFIG_PASSPHRASE:-}"
  local bad=0 provider=""
  # A stack already initialised with a KMS secrets provider does not use a passphrase at all.
  [[ -f "$REPO_ROOT/infra/teleport/Pulumi.$STACK.yaml" ]] && provider="$(awk '$1=="secretsprovider:"{print $2}' "$REPO_ROOT/infra/teleport/Pulumi.$STACK.yaml")"
  if [[ "$backend" == file://* ]]; then ui::fail "stack $STACK: PULUMI_BACKEND_URL=$backend is a local file backend"; bad=1; fi
  if [[ "$pass" == "local-dev" ]]; then ui::fail "stack $STACK: PULUMI_CONFIG_PASSPHRASE is the local default 'local-dev'"; bad=1
  elif [[ -z "$pass" && "$provider" != awskms://* && "$provider" != gcpkms://* && "$provider" != azurekeyvault://* && "$provider" != hashivault://* ]]; then
    ui::fail "stack $STACK: PULUMI_CONFIG_PASSPHRASE is unset and the stack has no KMS secrets provider (found: '${provider:-none}')"; bad=1
  fi
  if (( bad )); then
    ui::info "Non-local stacks must keep state in a shared backend and encrypt secrets with a KMS provider:"
    ui::info "  export PULUMI_BACKEND_URL=s3://<bucket>   # or gs://, azblob://, https://api.pulumi.com"
    ui::info "  (cd infra/teleport && pulumi stack init $STACK --secrets-provider=\"awskms://alias/teleport?region=<region>\")"
    ui::info "  # or: --secrets-provider=\"gcpkms://projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>\""
    ui::info "  # or: --secrets-provider=\"azurekeyvault://<vault>.vault.azure.net/keys/<key>\""
    ui::info "  With a KMS provider PULUMI_CONFIG_PASSPHRASE is not needed (the stack file's secretsprovider is checked)."
    ui::die "refusing to operate on stack $STACK with local-only secrets settings"
  fi
}
true
