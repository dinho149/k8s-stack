#!/usr/bin/env bash
# A low-risk role requested for longer than the auto-approve cap must never yield a grant longer than the cap.
# Teleport clamps the request to the requester role's max_duration (4h) instead of rejecting it, so the broker
# may legitimately auto-approve the CLAMPED request; the security property is the effective expiry, not the state.
source "$(dirname "$0")/lib.sh"
CAP_SECONDS=$((4 * 3600))
SLACK_SECONDS=300
ui::section "e2e 07: dev-ssh for 8h never grants more than the 4h cap"
e2e::login alice
id="$(e2e::request_id --roles dev-ssh --reason "e2e: long ttl" --max-duration 8h)"
if [[ -z "$id" ]]; then
  if grep -qiE "max_duration|max duration|exceed|invalid|denied|error" "$UI_LOG_DIR/e2e-req.log"; then
    ui::ok "Teleport rejected the 8h request outright: $(grep -iE 'max_duration|max duration|exceed|invalid|denied|error' "$UI_LOG_DIR/e2e-req.log" | head -1 | cut -c1-120)"
    exit 0
  fi
  ui::fail "request was neither created nor clearly rejected"; cat "$UI_LOG_DIR/e2e-req.log"; exit 1
fi
ui::kv "request" "$id"
ui::step "checking the effective access window Teleport recorded for the request"
window="$("$TCTL" get "access_request/$id" --format=json 2>/dev/null | python3 -c '
import sys, json, datetime
raw = json.load(sys.stdin)
r = raw[0] if isinstance(raw, list) else raw
s = r["spec"]
parse = lambda t: datetime.datetime.fromisoformat(t.replace("Z", "+00:00")[:26] + "+00:00") if "." in t else datetime.datetime.fromisoformat(t.replace("Z", "+00:00"))
print(int((parse(s["expires"]) - parse(s["created"])).total_seconds()))
')"
[[ "$window" =~ ^[0-9]+$ ]] || { ui::fail "could not read the request window (got '$window')"; exit 1; }
ui::kv "granted window" "$((window / 60)) min (cap $((CAP_SECONDS / 60)) min)"
if (( window > CAP_SECONDS + SLACK_SECONDS )); then
  ui::fail "request window exceeds the 4h cap: ${window}s"; exit 1
fi
ui::ok "8h ask was clamped to the cap (${window}s)"
sleep 6
st="$(e2e::state "$id")"
case "$st" in
  APPROVED) ui::ok "auto-approved only for the clamped window (state APPROVED, ${window}s)";;
  PENDING|DENIED) ui::ok "not auto-approved (state $st)";;
  *) ui::fail "unexpected state '$st'"; exit 1;;
esac
"$TCTL" request deny --reason "e2e cleanup" "$id" >/dev/null 2>&1 || true
