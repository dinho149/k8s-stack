#!/usr/bin/env bash
# port-forward.sh <mcp|broker|agent> — forward an access service to localhost.
source "$(dirname "$0")/_common.sh"
case "${1:-mcp}" in
  mcp)    svc=teleport-mcp;  port=8080; local_port=18380;;
  broker) svc=access-broker; port=8081; local_port=18381;;
  agent)  svc=access-agent;  port=8082; local_port=18382;;
  *) ui::die "unknown service ${1}";;
esac
ui::step "forwarding localhost:$local_port → teleport-access/$svc:$port (ctrl-c to stop)"
exec $KUBECTL -n teleport-access port-forward "svc/$svc" "$local_port:$port"
