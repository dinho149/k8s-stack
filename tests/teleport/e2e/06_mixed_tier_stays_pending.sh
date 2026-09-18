#!/usr/bin/env bash
# A request mixing a low-risk role with a high-risk one must NOT be auto-approved: the broker only
# auto-approves when EVERY requested role is auto-approvable (regression test for the mixed-tier bypass).
source "$(dirname "$0")/lib.sh"
ui::section "e2e 06: mixed dev-ssh + prod-ssh request stays pending"
e2e::login alice
id="$(e2e::request_id --roles dev-ssh,prod-ssh --reason "e2e: mixed tiers" --max-duration 1h)"
[[ -n "$id" ]] || { ui::fail "could not create request"; cat "$UI_LOG_DIR/e2e-req.log"; exit 1; }
ui::kv "request" "$id"
ui::step "watching for 20s: the broker must not approve it"
t=0
while (( t < 20 )); do
  st="$(e2e::state "$id")"
  [[ "$st" == "APPROVED" ]] && { ui::fail "mixed-tier request was auto-approved after ${t}s!"; exit 1; }
  sleep 4; t=$((t+4))
done
st="$(e2e::state "$id")"
case "$st" in
  PENDING) ui::ok "still PENDING after 20s (needs a human for prod-ssh)";;
  DENIED)  ui::ok "DENIED by policy (acceptable: never approved)";;
  *) ui::fail "unexpected state '$st'"; exit 1;;
esac
e2e::expect_fail "prod still refused without approval" e2e::tsh ssh dev@ssh-prod-0 true
"$TCTL" request deny --reason "e2e cleanup" "$id" >/dev/null 2>&1 || true
