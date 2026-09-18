#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
name=${1:?}
[[ "$name" =~ ^[a-z][a-z0-9-]{0,39}$ ]] || exit 2
ns="preview-$name"
require_owned_namespace "$ns"
k -n argocd delete application "preview-$name" --ignore-not-found --wait=true >&2
k -n argocd delete secret "cluster-$name" --ignore-not-found >&2
h uninstall "$name" -n "$ns" --ignore-not-found --wait --timeout 3m >&2
k delete namespace "$ns" --ignore-not-found --wait=true --timeout=180s >&2
