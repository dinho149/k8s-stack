#!/usr/bin/env bash
# local-tls.sh — browser-trusted certificate for the kind proxy via mkcert (STACK=local only).
#
# Writes .dogfood/teleport/tls/teleport.{crt,key} (gitignored) for teleport.127.0.0.1.nip.io and
# *.teleport.127.0.0.1.nip.io; Pulumi mounts them as Secret teleport-local-tls (tls.mode=local-files).
# Optional. LOCAL_TLS=ask (default): one question on the first `make up`, the answer is remembered
# (.dogfood/teleport/tls/.skipped). LOCAL_TLS=0: never. LOCAL_TLS=1 (what `make tls` uses): yes, without asking.
# Without mkcert, or without a terminal to ask for consent, the proxy keeps its self-signed certificate.
# Never installs packages or touches the trust store unless a person on a real terminal said yes.
source "$(dirname "$0")/_common.sh"
[[ "$STACK" == "local" ]] || { ui::info "TLS: STACK=$STACK uses cert-manager/ACME — nothing to do here"; exit 0; }

host="${PROXY_ADDR%%:*}"
crt="$LOCAL_TLS_DIR/teleport.crt"; key="$LOCAL_TLS_DIR/teleport.key"; ca="$LOCAL_TLS_DIR/ca.crt"
mode="${LOCAL_TLS:-ask}"; skipped="$LOCAL_TLS_DIR/.skipped"

# Consent needs a real terminal and not CI. Deliberately not ui::_tty: NO_COLOR is a colour choice, not consent.
interactive() { [[ -t 0 && -t 1 && -z "${CI:-}" ]]; }
self_signed_hint() {
  ui::warn "the proxy will use a self-signed certificate: browsers show a warning for https://$PROXY_ADDR"
  ui::info "install mkcert (macOS: brew install mkcert; Firefox also needs: brew install nss; Linux: apt install mkcert libnss3-tools)"
  ui::info "then: make tls && make deploy"
}
skip() { ui::info "TLS: $1 — the proxy keeps a self-signed certificate (one browser warning). Opt in any time: make tls && make deploy"; exit 0; }
case "$mode" in
  0) skip "LOCAL_TLS=0" ;;
  1) rm -f "$skipped" ;;
  *) [[ -f "$skipped" ]] && skip "skipped earlier" ;;
esac
# One question covers everything that follows (Homebrew install, mkcert -install, certificate). Default: yes.
consent() {
  [[ "$mode" == "1" || "${YES:-0}" == "1" ]] && return 0
  interactive || return 1
  local a; read -r -p "  Set up a browser-trusted certificate for https://$PROXY_ADDR with mkcert? (installs mkcert if needed, asks for your password once; n = keep self-signed) [Y/n] " a
  if [[ -z "$a" || "$a" == [yY]* ]]; then return 0; fi
  umask 077; mkdir -p "$LOCAL_TLS_DIR"; touch "$skipped"
  skip "skipped, remembered"
}
cert_ok() {
  [[ -f "$crt" && -f "$key" && -f "$ca" ]] || return 1
  cmp -s "$ca" "$(mkcert -CAROOT)/rootCA.pem" || return 1                            # ca.crt must be the current root
  openssl x509 -in "$crt" -noout -checkend 2592000 >/dev/null 2>&1 || return 1   # > 30 days left
  local sans; sans="$(openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null)"
  [[ "$sans" == *"DNS:$host"* && "$sans" == *"DNS:*.$host"* ]] || return 1
  openssl verify -CAfile "$(mkcert -CAROOT)/rootCA.pem" "$crt" >/dev/null 2>&1        # rejects a cert from an older CA
}

if command -v mkcert >/dev/null 2>&1 && common::mkcert_ca_trusted && cert_ok; then
  ui::ok "TLS: .dogfood/teleport/tls/teleport.crt covers $host and *.$host, signed by the trusted mkcert CA"
  exit 0
fi
if ! consent; then
  if command -v mkcert >/dev/null 2>&1; then ui::warn "mkcert root CA is not installed and there is no terminal to ask for it"; fi
  self_signed_hint; exit 0
fi
if ! command -v mkcert >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || { self_signed_hint; exit 0; }
  ui::spinner "brew install mkcert" brew install mkcert || ui::die "brew install mkcert failed"
fi
ui::require openssl
if ! common::mkcert_ca_trusted; then
  ui::step "Installing the mkcert root CA into the system trust store (macOS asks for your password once)"
  mkcert -install || ui::die "mkcert -install failed"
fi
if cert_ok; then
  ui::ok "TLS: .dogfood/teleport/tls/teleport.crt covers $host and *.$host, signed by the trusted mkcert CA"
  exit 0
fi
umask 077; mkdir -p "$LOCAL_TLS_DIR"
ui::spinner "Generating a certificate for $host and *.$host" mkcert -cert-file "$crt" -key-file "$key" "$host" "*.$host"
# The proxy verifies its own chain at startup, so Pulumi ships the issuing root alongside the leaf.
cp "$(mkcert -CAROOT)/rootCA.pem" "$ca"; chmod 0600 "$ca"
ui::kv "certificate" ".dogfood/teleport/tls/teleport.crt + ca.crt (gitignored; Pulumi mounts them as Secret teleport-local-tls)"
