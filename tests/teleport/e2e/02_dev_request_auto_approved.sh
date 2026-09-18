#!/usr/bin/env bash
# A low-risk request is approved by the broker within seconds and unlocks SSH.
source "$(dirname "$0")/lib.sh"
ui::section "e2e 02: dev-ssh request is auto-approved"
e2e::login alice
id="$(e2e::tsh request create --roles dev-ssh --reason "e2e: low risk" --max-duration 1h --nowait --format=json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id") or d.get("metadata",{}).get("name"))' 2>/dev/null || true)"
if [[ -z "$id" || "$id" == "None" ]]; then
  e2e::tsh request create --roles dev-ssh --reason "e2e: low risk" --max-duration 1h --nowait > "$UI_LOG_DIR/e2e-req.log" 2>&1 || true
  id="$(grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' "$UI_LOG_DIR/e2e-req.log" | head -1)"
fi
[[ -n "$id" ]] || { ui::fail "could not create request"; cat "$UI_LOG_DIR/e2e-req.log" 2>/dev/null; exit 1; }
ui::kv "request" "$id"
e2e::wait_state "$id" APPROVED 60 && ui::ok "approved by the broker"
e2e::expect_ok "assume the approved request" e2e::tsh login --request-id "$id"
e2e::expect_ok "ssh dev@ssh-dev-0 hostname" e2e::tsh ssh dev@ssh-dev-0 hostname
e2e::expect_fail "prod still refused" e2e::tsh ssh dev@ssh-prod-0 true
