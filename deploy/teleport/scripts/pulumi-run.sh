#!/usr/bin/env bash
# pulumi-run.sh — `pulumi up` / `pulumi destroy` with a one-line live progress display instead of the raw
# event stream. Failures are printed as they happen, the run ends with Pulumi's own resource summary, and
# the full stream is kept in .dogfood/logs/teleport/pulumi-<cmd>-<stack>.log (plus the Diagnostics block on failure).
#
#   pulumi-run.sh up|destroy <stack> [extra pulumi args...]
#   PULUMI_RUN_REPLAY=<log> pulumi-run.sh up <stack>     # render a saved log instead of running pulumi (tests)
source "$(dirname "$0")/_common.sh"
cmd="${1:?usage: pulumi-run.sh up|destroy <stack> [args]}"; stack="${2:?stack}"; shift 2
INFRA="$REPO_ROOT/infra/teleport"
mkdir -p "$UI_LOG_DIR"
log="$UI_LOG_DIR/pulumi-$cmd-$stack.log"
label="pulumi $cmd ($stack)"
frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
# Regexes live in variables: bash 3.2 (macOS) cannot parse parentheses inside an inline [[ =~ ]] pattern.
re_fail='^[[:space:]]*([-+~]+)[[:space:]]+([^[:space:]]+)[[:space:]]+([^[:space:]]+)[[:space:]]+\*\*([a-z]+) failed\*\*(.*)$'
re_event='^[[:space:]]*([-+~]+)[[:space:]]+([^[:space:]]+)[[:space:]]+([^[:space:]]+)[[:space:]]+(creating|updating|deleting|replacing|reading|created|updated|deleted|replaced|read)( replacement| original)?[[:space:]]*\(([^)]*)\)(.*)$'

short() { printf '%s' "${1##*:}"; }                         # kubernetes:apps/v1:Deployment -> Deployment
trim() { local n="$2" s="$1"; (( ${#s} > n )) && s="${s:0:n-1}…"; printf '%s' "$s"; }

# render <- pulumi stream on stdin. TTY: one updating line. Otherwise: one compact line per finished resource.
render() {
  local done=0 failed=0 i=0 inflight="" last="" waiting="" line start=$SECONDS
  local type name action rest reason width
  progress() {
    ui::_tty || return 0
    width=$(( $(ui::cols) - 2 ))
    local txt="  ${UI_BLUE}${frames:i++%${#frames}:1}${UI_RESET} $label  ${UI_GREEN}$done done${UI_RESET}"
    local n=0; for _ in $inflight; do n=$((n+1)); done
    (( n > 0 )) && txt+="  ${UI_DIM}$n in flight${UI_RESET}"
    (( failed > 0 )) && txt+="  ${UI_RED}$failed failed${UI_RESET}"
    [[ -n "$last" ]] && txt+="  ${UI_DIM}$(trim "$last" 60)${UI_RESET}"
    [[ -n "$waiting" ]] && txt+="  ${UI_YELLOW}$(trim "$waiting" 70)${UI_RESET}"
    txt+="  ${UI_DIM}($((SECONDS-start))s)${UI_RESET}"
    # keep it on one terminal line: measure without ANSI codes
    local plain; plain="$(printf '%s' "$txt" | sed 's/\x1b\[[0-9;]*m//g')"
    if (( ${#plain} > width )); then txt="$(trim "$plain" "$width")"; fi
    printf '\r\033[K%s' "$txt"
  }
  while IFS= read -r line; do
    if [[ "$line" =~ $re_fail ]]; then
      type="${BASH_REMATCH[2]}"; name="${BASH_REMATCH[3]}"; action="${BASH_REMATCH[4]}"; rest="${BASH_REMATCH[5]}"
      failed=$((failed+1)); inflight=" ${inflight//" $name "/ } "
      ui::_tty && printf '\r\033[K'
      reason="${rest#* error: }"
      printf '  %s%s%s %s %s: %s failed%s\n' "$UI_RED" "$UI_BAD" "$UI_RESET" "$(short "$type")" "$name" "$action" "${reason:+ — $(trim "$reason" 110)}"
      progress; continue
    fi
    if [[ "$line" =~ $re_event ]]; then
      type="${BASH_REMATCH[2]}"; name="${BASH_REMATCH[3]}"; action="${BASH_REMATCH[4]}"; rest="${BASH_REMATCH[7]}"
      case "$action" in
        creating|updating|deleting|replacing|reading)
          [[ " $inflight " == *" $name "* ]] || inflight="$inflight $name"
          if [[ "$rest" == *" warning: "* ]]; then
            reason="${rest#* warning: }"; reason="${reason#\[*\]: }"; reason="${reason#\[*\] }"
            waiting="waiting: $(short "$type") $name — ${reason%%.*}"
          elif [[ "$rest" == *"; Waiting for "* || "$rest" == *"; Deployment"* ]]; then
            waiting="waiting: $(short "$type") $name"
          fi ;;
        *)
          done=$((done+1)); inflight=" ${inflight//" $name "/ } "; last="$action $(short "$type") $name"
          [[ "$waiting" == *" $name — "* || "$waiting" == *" $name" ]] && waiting=""
          if ! ui::_tty; then printf '  %s %s %s (%s)\n' "${BASH_REMATCH[1]}" "$(short "$type")" "$name" "${BASH_REMATCH[6]}"; fi ;;
      esac
      progress; continue
    fi
    [[ "$line" == "@ "* ]] && { progress; continue; }      # heartbeat
    # everything else (Outputs, Resources, Diagnostics, blank lines) is in the log
  done
  ui::_tty && printf '\r\033[K'
  return 0
}

summary() {   # one line from the "Resources:" block of the log, e.g. "+32 created, ~29 updated, 56 unchanged, 4 errored"
  awk '/^Resources:/{p=1; next} p && /^[[:space:]]*$/{p=0} p{ gsub(/^[[:space:]]+/, ""); sub(/^[0-9]+ changes\. /, ""); gsub(/ +/, " "); gsub(/^\+ /, "+"); gsub(/^~ /, "~"); gsub(/^- /, "-"); gsub(/^\+- /, "+-"); printf "%s%s", (n++ ? ", " : ""), $0 }' "$log"
}
duration() { awk '/^Duration:/{print $2}' "$log"; }

ui::step "$label ${UI_DIM}(full log: .dogfood/logs/teleport/pulumi-$cmd-$stack.log)${UI_RESET}"
rc=0
if [[ -n "${PULUMI_RUN_REPLAY:-}" ]]; then
  sed 's/\x1b\[[0-9;]*m//g' "$PULUMI_RUN_REPLAY" | tee "$log" | render
  grep -q "errored" "$log" && rc=1
else
  (cd "$INFRA" && pulumi --non-interactive --color never "$cmd" --stack "$stack" --yes --skip-preview "$@" 2>&1; echo "$?" > "$log.rc") | tee "$log" | render
  rc="$(cat "$log.rc" 2>/dev/null || echo 1)"; rm -f "$log.rc"
fi
s="$(summary)"; d="$(duration)"
if [[ "$rc" == "0" ]]; then
  ui::ok "$label: ${s:-no changes}${d:+ ${UI_DIM}in $d${UI_RESET}}"
else
  ui::fail "$label failed: ${s:-see log}${d:+ (after $d)}"
  # Pulumi's own Diagnostics block is the useful part: show it, indented, then the log path.
  awk '/^Diagnostics:/{p=1} /^(Outputs|Resources):/{p=0} p' "$log" | sed 's/^/    /' | head -60
  ui::info "full log: .dogfood/logs/teleport/pulumi-$cmd-$stack.log"
fi
exit "$rc"
