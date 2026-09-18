#!/usr/bin/env bash
# A high-risk request stays pending until an approver (bob, or an admin) decides.
source "$(dirname "$0")/lib.sh"
ui::section "e2e 03: prod-ssh needs a human"
e2e::login alice
e2e::tsh request create --roles prod-ssh --reason "e2e: incident" --max-duration 1h --nowait > "$UI_LOG_DIR/e2e-req.log" 2>&1 || true
id="$(grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' "$UI_LOG_DIR/e2e-req.log" | head -1)"
[[ -n "$id" ]] || { ui::fail "could not create request"; cat "$UI_LOG_DIR/e2e-req.log"; exit 1; }
ui::kv "request" "$id"
sleep 12
if e2e::wait_state "$id" APPROVED 1 2>/dev/null; then ui::fail "prod request was auto-approved!"; exit 1; fi
ui::ok "still pending after 12s (broker is waiting for a human)"
ui::step "approving as admin via tctl (what an approver's chat button does through the broker)"
"$TCTL" request approve --reason "e2e approve" "$id" >/dev/null
e2e::wait_state "$id" APPROVED 30
e2e::expect_ok "assume the approved request" e2e::tsh login --request-id "$id"
e2e::expect_ok "ssh dev@ssh-prod-0 hostname" e2e::tsh ssh dev@ssh-prod-0 hostname
