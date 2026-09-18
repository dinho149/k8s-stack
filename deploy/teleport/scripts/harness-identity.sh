#!/usr/bin/env bash
# harness-identity.sh — export the ci-harness bot identity (written by tbot) for local tests.
source "$(dirname "$0")/_common.sh"
umask 077   # the identity is a private key: directory and file are owner-only from creation
mkdir -p "$STATE_DIR"
out="$STATE_DIR/harness.identity"
for _ in $(seq 1 40); do
  if $KUBECTL -n teleport-access get secret ci-harness-identity -o jsonpath='{.data.identity}' 2>/dev/null | base64 -d > "$out" 2>/dev/null && [[ -s "$out" ]]; then
    chmod 0600 "$out"; ui::ok "harness identity written to .dogfood/teleport/state/harness.identity"; exit 0; fi
  sleep 3
done
ui::die "secret teleport-access/ci-harness-identity not populated yet (is tbot-ci-harness running? make logs SVC=broker)"
