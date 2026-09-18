#!/usr/bin/env bash
# alice (requester) can log in but reaches nothing.
source "$(dirname "$0")/lib.sh"
ui::section "e2e 01: requester has no standing access"
e2e::login alice
nodes="$(e2e::tsh ls --format=json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
[[ "$nodes" == "0" ]] && ui::ok "tsh ls shows 0 nodes" || { ui::fail "alice sees $nodes nodes"; exit 1; }
e2e::expect_fail "ssh to ssh-dev-0 without a role" e2e::tsh ssh dev@ssh-dev-0 true
