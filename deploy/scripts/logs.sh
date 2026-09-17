#!/usr/bin/env bash
# logs.sh <svc> — follow logs of a component: auth|proxy|operator|kube-agent|ssh|broker|mcp|agent|postgres
source "$(dirname "$0")/_common.sh"
svc="${1:-auth}"
case "$svc" in
  auth)       ns=teleport;         sel="app.kubernetes.io/component=auth";;
  proxy)      ns=teleport;         sel="app.kubernetes.io/component=proxy";;
  operator)   ns=teleport;         sel="app.kubernetes.io/name=teleport-operator";;
  kube-agent) ns=teleport-agent;   sel="app=teleport-kube-agent";;
  ssh)        ns=teleport-dummies; sel="app.kubernetes.io/part-of=ssh-nodes";;
  postgres)   ns=teleport-dummies; sel="app=postgres";;
  broker)     ns=teleport-access;  sel="app=access-broker";;
  mcp)        ns=teleport-access;  sel="app=teleport-mcp";;
  agent)      ns=teleport-access;  sel="app=access-agent";;
  *) ui::die "unknown SVC=$svc (auth|proxy|operator|kube-agent|ssh|postgres|broker|mcp|agent)";;
esac
ui::step "logs for $svc  ${UI_DIM}(-n $ns -l $sel)${UI_RESET}"
exec $KUBECTL -n "$ns" logs -f --all-containers --prefix --tail="${TAIL:-100}" -l "$sel"
