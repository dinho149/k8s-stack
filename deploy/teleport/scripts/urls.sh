#!/usr/bin/env bash
# urls.sh — every URL you can open for the local stack.
source "$(dirname "$0")/_common.sh"
ui::section "URLs"
tls_note="$(common::tls_note)"
ui::table "WHAT|URL|NOTE" \
  "Teleport web UI|https://$PROXY_ADDR|$tls_note" \
  "GitHub SSO callback|https://$PROXY_ADDR/v1/webapi/github/callback|paste into your GitHub OAuth App" \
  "httpbin app|https://httpbin.$PROXY_ADDR|needs dev-app role" \
  "fake cloud console|https://cloud-console.$PROXY_ADDR|needs prod-app role" \
  "tsh|make teleport-login|GitHub SSO if configured, else headless local login (USER_NAME=alice)" \
  "MCP server (port-forward)|http://localhost:18380/mcp|make teleport-port-forward SVC=mcp" \
  "Access broker (port-forward)|http://localhost:18381/v1/requests|make teleport-port-forward SVC=broker"
