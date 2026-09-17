#!/usr/bin/env bash
# urls.sh — every URL you can open for the local stack.
source "$(dirname "$0")/_common.sh"
host="${PROXY_ADDR%%:*}"; port="${PROXY_ADDR##*:}"
ui::section "URLs"
ui::table "WHAT|URL|NOTE" \
  "Teleport web UI|https://$PROXY_ADDR|self-signed cert (accept warning)" \
  "GitHub SSO callback|https://$PROXY_ADDR/v1/webapi/github/callback|paste into your GitHub OAuth App" \
  "httpbin app|https://httpbin.$PROXY_ADDR|needs dev-app role" \
  "fake cloud console|https://cloud-console.$PROXY_ADDR|needs prod-app role" \
  "tsh|./bin/tsh --insecure --proxy $PROXY_ADDR login|or: make login" \
  "MCP server (port-forward)|http://localhost:8080/mcp|make port-forward SVC=mcp" \
  "Access broker (port-forward)|http://localhost:8081/v1/requests|make port-forward SVC=broker"
