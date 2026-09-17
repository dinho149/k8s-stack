#!/usr/bin/env bash
# seed-test-users.sh — headless password + TOTP enrolment for the local test users (alice, bob).
source "$(dirname "$0")/_common.sh"
ui::require go
mkdir -p "$STATE_DIR"
ui::spinner "Seeding alice and bob (password + TOTP)" env TELEPORT_PROXY="$PROXY_ADDR" HARNESS_IDENTITY="$STATE_DIR/harness.identity" TELEPORT_INSECURE=1 \
  go run -C "$REPO_ROOT/tests/tools" ./seed-users -out "$STATE_DIR/users.json" -users alice,bob
ui::kv "credentials" "tests/.state/users.json (gitignored)"
