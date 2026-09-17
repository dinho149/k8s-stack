#!/usr/bin/env bash
# requests.sh — pretty list of access requests (all states).
source "$(dirname "$0")/_common.sh"
ui::section "Access requests"
"$REPO_ROOT/deploy/scripts/tctl.sh" requests ls --format=json 2>/dev/null | python3 -c '
import json,sys,datetime
d=json.load(sys.stdin) or []
states={1:"PENDING",2:"APPROVED",3:"DENIED",4:"PROMOTED"}
rows=["ID|USER|ROLES|STATE|REASON|EXPIRES"]
for r in sorted(d,key=lambda r:r["metadata"].get("expires","")):
    s=r["spec"]; m=r["metadata"]
    rows.append("|".join([m["name"][:8],s.get("user",""),",".join(s.get("roles",[])),states.get(s.get("state",1),str(s.get("state"))),(s.get("request_reason") or "")[:40],(m.get("expires") or "")[:16]]))
print("\n".join(rows))
' | { mapfile -t rows; (( ${#rows[@]} > 1 )) && ui::table "${rows[@]}" || ui::info "no access requests"; }
echo; ui::info "approve: make approve ID=<id> [REASON=...]    deny: make deny ID=<id> REASON=..."
