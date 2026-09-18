#!/usr/bin/env bash
# doctor.sh — verify the local toolchain and environment for `make up`.
source "$(dirname "$0")/_common.sh"
fail=0

ui::section "Toolchain"
want() { awk -v t="$1" '$1==t {print $2}' "$REPO_ROOT/.tool-versions"; }
check_tool() { # name, binary, version-cmd, want-key, hint
  local name="$1" bin="$2" vcmd="$3" key="$4" hint="$5" have
  if ! command -v "$bin" >/dev/null 2>&1; then ui::status fail "$name" "missing — $hint"; fail=1; return; fi
  have="$(eval "$vcmd" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)"
  local w; w="$(want "$key")"
  if [[ -n "$w" && "${have%.*}" != "${w%.*}" ]]; then ui::status warn "$name" "v$have (pinned v$w)"; else ui::status ok "$name" "v$have"; fi
}
check_tool "pulumi"  pulumi  "pulumi version"                          pulumi  "brew install pulumi"
check_tool "kind"    kind    "kind version"                            kind    "brew install kind"
check_tool "kubectl" kubectl "kubectl version --client -o json | grep gitVersion" kubectl "brew install kubectl"
check_tool "helm"    helm    "helm version --short"                   helm    "brew install helm"
check_tool "node"    node    "node --version"                          nodejs  "brew install node"
check_tool "go"      go      "go version"                              golang  "brew install go"
check_tool "docker"  docker  "docker version --format '{{.Client.Version}}'" ""  "install Docker Desktop / OrbStack"
if command -v docker >/dev/null && ! docker info >/dev/null 2>&1; then ui::status fail "docker daemon" "not running — start Docker"; fail=1; fi
if [[ -x "$BIN_DIR/tsh" ]]; then ui::status ok "tsh / tctl" "$("$BIN_DIR/tsh" version 2>/dev/null | head -1 | grep -oE 'v[0-9.]+' | head -1) in ./bin"; else ui::status warn "tsh / tctl" "not installed — run: make tsh"; fi
if command -v claude >/dev/null 2>&1; then
  ui::status ok "claude code" "$(claude --version 2>/dev/null | head -1) — agent can use your subscription (make agent-cli)"
else ui::status warn "claude code" "not installed — agent needs ANTHROPIC_API_KEY or 'npm i -g @anthropic-ai/claude-code'"; fi
if command -v expect >/dev/null 2>&1; then ui::status ok "expect" "present (headless tsh login: make login, e2e)"; else ui::status warn "expect" "missing — make login / e2e need it (brew/apt install expect)"; fi
if command -v mkcert >/dev/null 2>&1; then
  if [[ -f "$(mkcert -CAROOT 2>/dev/null)/rootCA.pem" ]]; then ui::status ok "mkcert" "CA in $(mkcert -CAROOT)$( [[ -f "$LOCAL_TLS_DIR/teleport.crt" ]] && echo ", local proxy certificate present" || echo " — make tls generates the proxy certificate")"
  else ui::status warn "mkcert" "installed, root CA not created yet — make tls (asks for your password once)"; fi
else ui::status warn "mkcert" "not installed — browsers will warn about the self-signed proxy cert (brew install mkcert; make up offers it)"; fi
for opt in gitleaks kubeconform pre-commit shellcheck hadolint actionlint golangci-lint semgrep trivy; do
  if command -v "$opt" >/dev/null 2>&1; then ui::status ok "$opt" "$(command -v "$opt")"; else ui::status warn "$opt" "optional, used by make lint / pre-commit hooks (brew install $opt)"; fi
done
if [[ -d "$REPO_ROOT/.git" ]]; then
  if [[ -x "$REPO_ROOT/.git/hooks/pre-commit" && -x "$REPO_ROOT/.git/hooks/pre-push" ]] && grep -q pre-commit "$REPO_ROOT/.git/hooks/pre-commit" 2>/dev/null; then ui::status ok "git hooks" "pre-commit + pre-push installed"
  else ui::status warn "git hooks" "pre-commit hooks not installed — run: make hooks (CI runs the same checks, so commits without them fail there)"; fi
fi

ui::section "Environment"
ctx="$(kubectl config current-context 2>/dev/null || echo none)"
if [[ "$ctx" == "$KUBE_CONTEXT" ]]; then ui::status ok "kube context" "$ctx"; else ui::status ok "kube context" "current=$ctx — scripts pin --context $KUBE_CONTEXT, your context is never changed"; fi
if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then ui::status ok "kind cluster" "$KIND_CLUSTER exists"; else ui::status warn "kind cluster" "$KIND_CLUSTER not created yet (make kind-up)"; fi
port="${PROXY_ADDR##*:}"
if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  if docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -q "${KIND_CLUSTER}-control-plane.*:${port}->"; then ui::status ok "host port $port" "in use by $KIND_CLUSTER (expected)"; else ui::status fail "host port $port" "in use by another process: $(lsof -nP -iTCP:$port -sTCP:LISTEN | awk 'NR==2{print $1}')"; fail=1; fi
else ui::status ok "host port $port" "free"; fi
ui::status ok "pulumi backend" "${PULUMI_BACKEND_URL:-file://./infra/.state}"
if [[ "$STACK" == "local" ]]; then
  if [[ -z "${PULUMI_CONFIG_PASSPHRASE:-}" ]]; then ui::status warn "pulumi passphrase" "PULUMI_CONFIG_PASSPHRASE unset — Makefile defaults to 'local-dev' for STACK=local only"; else ui::status ok "pulumi passphrase" "set"; fi
elif common::require_cloud_secrets >/dev/null 2>&1; then ui::status ok "pulumi secrets" "stack $STACK: shared backend, non-default secrets"
else ui::status fail "pulumi secrets" "stack $STACK: file backend or default passphrase — run: make secrets-guard for details"; fail=1; fi
if getent hosts teleport.127.0.0.1.nip.io >/dev/null 2>&1 || dscacheutil -q host -a name teleport.127.0.0.1.nip.io 2>/dev/null | grep -q 127.0.0.1 || python3 -c 'import socket,sys; sys.exit(0 if socket.gethostbyname("teleport.127.0.0.1.nip.io")=="127.0.0.1" else 1)' 2>/dev/null; then ui::status ok "nip.io DNS" "teleport.127.0.0.1.nip.io → 127.0.0.1"; else ui::status warn "nip.io DNS" "cannot resolve *.nip.io (offline?) — add '127.0.0.1 teleport.127.0.0.1.nip.io' to /etc/hosts"; fi
if [[ -f "$REPO_ROOT/infra/teleport/Pulumi.$STACK.yaml" ]]; then
  if grep -q 'claudeCodeOauthToken' "$REPO_ROOT/infra/teleport/Pulumi.$STACK.yaml" 2>/dev/null; then ui::status ok "agent auth" "subscription token stored for stack $STACK"
  elif grep -q 'anthropicApiKey' "$REPO_ROOT/infra/teleport/Pulumi.$STACK.yaml" 2>/dev/null; then ui::status ok "agent auth" "API key stored for stack $STACK"
  else ui::status warn "agent auth" "no Claude credentials in stack $STACK — make claude-token (subscription) or set teleport:chat.anthropicApiKey"; fi
fi
if [[ -f "$REPO_ROOT/infra/teleport/Pulumi.$STACK.yaml" ]] && grep -q 'github:' "$REPO_ROOT/infra/teleport/Pulumi.$STACK.yaml" 2>/dev/null && grep -q 'clientSecret' "$REPO_ROOT/infra/teleport/Pulumi.$STACK.yaml"; then ui::status ok "GitHub SSO" "OAuth app configured for stack $STACK"; else ui::status warn "GitHub SSO" "not configured for stack $STACK — run: make github-sso (local login still works)"; fi

echo
if (( fail )); then ui::fail "doctor found blocking problems"; exit 1; else ui::ok "all good — next: make up"; fi
