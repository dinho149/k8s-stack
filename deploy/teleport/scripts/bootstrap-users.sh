#!/usr/bin/env bash
# bootstrap-users.sh — headless password + TOTP enrolment for the local users (STACK=local only).
#
#   bootstrap-users.sh [users=admin,alice,bob] [--force]
#
# Uses the ci-harness bot identity to issue reset tokens through the Teleport API (tests/tools/seed-users)
# and stores the credentials in tests/.state/users.json (0600, gitignored). Users already in the file are
# left alone (a reset token deletes existing MFA devices); --force re-enrols them.
source "$(dirname "$0")/_common.sh"
[[ "$STACK" == "local" ]] || ui::die "bootstrap-users is for STACK=local only (cloud stacks use SSO; request break-glass-editor instead)"
users="admin,alice,bob"; force=""
for a in "$@"; do case "$a" in --force) force="-force" ;; *) users="$a" ;; esac; done
ui::require go python3

"$REPO_ROOT/deploy/scripts/harness-identity.sh"

# The operator creates TeleportUser CRs asynchronously: wait until every requested user exists.
wait_users() {
  local t=0
  until "$REPO_ROOT/deploy/scripts/tctl.sh" users ls --format=json 2>/dev/null \
    | python3 -c 'import json,sys; have={u["metadata"]["name"] for u in json.load(sys.stdin)}; sys.exit(0 if set(sys.argv[1].split(",")) <= have else 1)' "$users"; do
    (( t >= 120 )) && return 1
    sleep 3; t=$((t + 3))
  done
}
ui::spinner "Waiting for users $users" wait_users || ui::die "users not created yet — check: make logs SVC=operator"

mkdir -p "$STATE_DIR"
# shellcheck disable=SC2086 # $force is empty or -force
ui::spinner "Enrolling $users (password + TOTP${force:+, re-enrol})" env TELEPORT_PROXY="$PROXY_ADDR" HARNESS_IDENTITY="$STATE_DIR/harness.identity" TELEPORT_INSECURE=1 \
  go run -C "$REPO_ROOT/tests/tools" ./seed-users -out "$STATE_DIR/users.json" -users "$users" -skip-existing $force
grep -E "^(enrolled|skipping)" "$UI_LOG_DIR/enrolling-"*.log 2>/dev/null | sed 's/^.*\.log://; s/^/    /' || true
ui::kv "credentials" "tests/.state/users.json (gitignored, 0600) — make login / make web-login"
