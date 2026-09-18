#!/usr/bin/env bash
# shellcheck disable=SC2034 # the palette/glyph variables are consumed by the scripts that source this file
# ui.sh — tiny terminal UI helpers used by every script and Make target.
#
# Pure bash + tput. Colours and unicode switch themselves off when stdout is
# not a TTY, or when NO_COLOR / CI is set, so CI logs stay plain.
#
# Usage:  source "$(dirname "$0")/lib/ui.sh"
#   ui::section "Teleport cluster"        big heading
#   ui::step "Creating kind cluster"      "▸ ..." line
#   ui::ok "done" | ui::warn "..." | ui::fail "..." | ui::info "..."
#   ui::kv "Proxy" "https://..."          aligned key/value
#   ui::spinner "Waiting for pods" cmd args...   spinner; log shown only on failure
#   ui::box "Title" "line 1" "line 2"     boxed summary
#   ui::table "COL1|COL2" "a|b" "c|d"     aligned table (pipe separated)

[[ -n "${__UI_SH_LOADED:-}" ]] && return 0
__UI_SH_LOADED=1

ui::_tty() { [[ -t 1 && -z "${NO_COLOR:-}" && -z "${CI:-}" ]]; }

if ui::_tty && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  UI_BOLD="$(tput bold)"; UI_DIM="$(tput dim)"; UI_RESET="$(tput sgr0)"
  UI_RED="$(tput setaf 1)"; UI_GREEN="$(tput setaf 2)"; UI_YELLOW="$(tput setaf 3)"
  UI_BLUE="$(tput setaf 4)"; UI_MAGENTA="$(tput setaf 5)"; UI_CYAN="$(tput setaf 6)"; UI_GREY="$(tput setaf 8 2>/dev/null || tput setaf 7)"
  UI_OK="✓"; UI_BAD="✗"; UI_WARN="!"; UI_ARROW="▸"; UI_DOT="•"
  UI_HLINE="─"; UI_TL="╭"; UI_TR="╮"; UI_BL="╰"; UI_BR="╯"; UI_V="│"
else
  UI_BOLD=""; UI_DIM=""; UI_RESET=""; UI_RED=""; UI_GREEN=""; UI_YELLOW=""; UI_BLUE=""; UI_MAGENTA=""; UI_CYAN=""; UI_GREY=""
  UI_OK="[ok]"; UI_BAD="[x]"; UI_WARN="[!]"; UI_ARROW=">"; UI_DOT="-"
  UI_HLINE="-"; UI_TL="+"; UI_TR="+"; UI_BL="+"; UI_BR="+"; UI_V="|"
fi

UI_LOG_DIR="${UI_LOG_DIR:-${REPO_ROOT:-.}/.dogfood/logs/teleport}"

ui::cols() { local c; c="$(tput cols 2>/dev/null || echo 100)"; (( c > 120 )) && c=120; echo "$c"; }

ui::hr() { local n; n="$(ui::cols)"; printf '%s%s%s\n' "$UI_GREY" "$(printf '%*s' "$n" '' | tr ' ' "$UI_HLINE")" "$UI_RESET"; }

ui::section() { printf '\n%s%s%s %s%s\n' "$UI_BOLD" "$UI_CYAN" "$UI_DOT" "$*" "$UI_RESET"; ui::hr; }
ui::step()    { printf '%s%s%s %s\n' "$UI_BLUE" "$UI_ARROW" "$UI_RESET" "$*"; }
ui::ok()      { printf '  %s%s%s %s\n' "$UI_GREEN" "$UI_OK" "$UI_RESET" "$*"; }
ui::warn()    { printf '  %s%s%s %s\n' "$UI_YELLOW" "$UI_WARN" "$UI_RESET" "$*"; }
ui::fail()    { printf '  %s%s%s %s\n' "$UI_RED" "$UI_BAD" "$UI_RESET" "$*" >&2; }
ui::info()    { printf '  %s%s%s\n' "$UI_DIM" "$*" "$UI_RESET"; }
ui::kv()      { printf '  %s%-18s%s %s\n' "$UI_DIM" "$1" "$UI_RESET" "$2"; }
ui::die()     { ui::fail "$@"; exit 1; }

# ui::status <ok|warn|fail> <label> <detail...>   one-line check result
ui::status() {
  local st="$1"; shift; local label="$1"; shift
  case "$st" in
    ok)   printf '  %s%s%s %-26s %s\n' "$UI_GREEN"  "$UI_OK"   "$UI_RESET" "$label" "$*";;
    warn) printf '  %s%s%s %-26s %s%s%s\n' "$UI_YELLOW" "$UI_WARN" "$UI_RESET" "$label" "$UI_YELLOW" "$*" "$UI_RESET";;
    *)    printf '  %s%s%s %-26s %s%s%s\n' "$UI_RED"    "$UI_BAD"  "$UI_RESET" "$label" "$UI_RED" "$*" "$UI_RESET";;
  esac
}

# ui::table "H1|H2|H3" "a|b|c" ...   aligned table, first row is the header
ui::table() {
  local rows=("$@")
  { for r in "${rows[@]}"; do printf '%s\n' "$r"; done; } | awk -F'|' -v bold="$UI_BOLD" -v dim="$UI_DIM" -v reset="$UI_RESET" '
    { n=(NF>n)?NF:n; for(i=1;i<=NF;i++){ gsub(/^ +| +$/,"",$i); cell[NR,i]=$i; l=length($i); if(l>w[i]) w[i]=l } rows=NR }
    END {
      for(r=1;r<=rows;r++){
        line="  "
        for(i=1;i<=n;i++){ line=line sprintf("%-" w[i]+2 "s", cell[r,i]) }
        if(r==1) print bold line reset; else print line
        if(r==1){ sep="  "; for(i=1;i<=n;i++){ sep=sep sprintf("%-" w[i]+2 "s", substr("--------------------------------------------------------------------------------",1,w[i])) } print dim sep reset }
      }
    }'
}

# ui::box "Title" "line" "line"...
ui::box() {
  local title="$1"; shift
  local lines=("$@") w=0 l plain
  for l in "$title" "${lines[@]}"; do
    plain="$(printf '%s' "$l" | sed 's/\x1b\[[0-9;]*m//g')"
    (( ${#plain} > w )) && w=${#plain}
  done
  (( w += 2 ))
  local bar; bar="$(printf '%*s' "$w" '' | tr ' ' "$UI_HLINE")"
  printf '%s%s%s%s%s\n' "$UI_CYAN" "$UI_TL" "$bar" "$UI_TR" "$UI_RESET"
  printf '%s%s%s %s%-*s%s %s%s%s\n' "$UI_CYAN" "$UI_V" "$UI_RESET" "$UI_BOLD" "$((w-2))" "$title" "$UI_RESET" "$UI_CYAN" "$UI_V" "$UI_RESET"
  printf '%s%s%s%s%s\n' "$UI_CYAN" "$UI_V" "$(printf '%*s' "$w" '' | tr ' ' ' ')" "$UI_V" "$UI_RESET"
  for l in "${lines[@]}"; do
    plain="$(printf '%s' "$l" | sed 's/\x1b\[[0-9;]*m//g')"
    printf '%s%s%s %s%*s %s%s%s\n' "$UI_CYAN" "$UI_V" "$UI_RESET" "$l" "$((w-2-${#plain}))" "" "$UI_CYAN" "$UI_V" "$UI_RESET"
  done
  printf '%s%s%s%s%s\n' "$UI_CYAN" "$UI_BL" "$bar" "$UI_BR" "$UI_RESET"
}

# ui::spinner "label" cmd args...
# Runs cmd with output captured to $UI_LOG_DIR/<slug>.log. Shows a spinner on a
# TTY, prints ✓/✗ with elapsed time, and dumps the log tail on failure.
ui::spinner() {
  local label="$1"; shift
  local slug; slug="$(printf '%s' "$label" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')"
  mkdir -p "$UI_LOG_DIR"
  local log="$UI_LOG_DIR/${slug:-step}.log"
  local start=$SECONDS rc=0
  if ui::_tty; then
    "$@" >"$log" 2>&1 &
    local pid=$! frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
    tput civis 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r  %s%s%s %s %s(%ss)%s' "$UI_BLUE" "${frames:i++%${#frames}:1}" "$UI_RESET" "$label" "$UI_DIM" "$((SECONDS-start))" "$UI_RESET"
      sleep 0.1
    done
    wait "$pid" || rc=$?
    tput cnorm 2>/dev/null || true
    printf '\r\033[K'
  else
    printf '  %s %s...\n' "$UI_ARROW" "$label"
    "$@" >"$log" 2>&1 || rc=$?
  fi
  if (( rc == 0 )); then
    ui::ok "$label ${UI_DIM}($((SECONDS-start))s)${UI_RESET}"
  else
    ui::fail "$label failed (exit $rc) — log: $log"
    printf '%s' "$UI_DIM"; tail -n 25 "$log" | sed 's/^/    /'; printf '%s\n' "$UI_RESET"
  fi
  return $rc
}

# ui::confirm "question"   -> 0 on yes (auto-yes when YES=1 or not a TTY)
ui::confirm() {
  [[ "${YES:-0}" == "1" ]] && return 0
  ui::_tty || return 0
  local a; read -r -p "  $1 [y/N] " a; [[ "$a" == [yY]* ]]
}

# ui::require cmd [cmd...]  -> die if any command is missing
ui::require() { local c; for c in "$@"; do command -v "$c" >/dev/null 2>&1 || ui::die "missing required tool: $c (run: make doctor)"; done; }
