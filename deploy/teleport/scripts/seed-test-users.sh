#!/usr/bin/env bash
# seed-test-users.sh — headless password + TOTP enrolment for the local test users (alice, bob).
# Thin wrapper kept for CI and docs; the real work is deploy/teleport/scripts/bootstrap-users.sh.
exec "$(dirname "$0")/bootstrap-users.sh" alice,bob
