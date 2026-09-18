#!/usr/bin/env bash
# secrets-guard.sh — refuse to touch a non-local stack with the local file backend / default passphrase.
# Used as a prerequisite of every Makefile target that reads or writes Pulumi state.
export COMMON_SKIP_PROXY_CHECK=1   # this guard is about secrets; the proxy check belongs to the scripts that talk to it
source "$(dirname "$0")/_common.sh"
common::require_cloud_secrets
[[ "$STACK" == "local" ]] || ui::ok "stack $STACK: shared backend + real secrets provider"
