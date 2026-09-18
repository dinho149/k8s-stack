#!/usr/bin/env bash
# port-forward.sh <mcp|broker|agent> — forward an access service to localhost.
source "$(dirname "$0")/_common.sh"
case "${1:-mcp}" in
  mcp)    svc=teleport-mcp;  port=8080;;
  broker) svc=access-broker; port=8081;;
  agent)  svc=access-agent;  port=8082;;
  *) ui::die "unknown service ${1}";;
esac
ui::step "forwarding localhost:$port → teleport-access/$svc:$port (ctrl-c to stop)"
exec $KUBECTL -n teleport-access port-forward "svc/$svc" "$port:$port"
