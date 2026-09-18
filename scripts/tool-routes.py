#!/usr/bin/env python3
"""Generate routes for installed tools. OIDC/proxy auth must be configured before cloud exposure."""
import argparse
import json
import re
p=argparse.ArgumentParser()
p.add_argument('--domain',required=True)
p.add_argument('--tools',default='argocd')
a=p.parse_args()
if not re.fullmatch(r'[a-zA-Z0-9.-]+',a.domain):raise SystemExit('Invalid domain')
services={'argocd':('argocd','argocd-server',80),'grafana':('monitoring','monitoring-grafana',80),'keycloak':('identity','keycloak',80)}
items=[]
for tool in a.tools.split(','):
 if tool not in services:raise SystemExit('Only authenticated tool services may be exposed by this generator')
 ns,service,port=services[tool]
 items.extend([
  {'apiVersion':'v1','kind':'Namespace','metadata':{'name':ns,'labels':{'dogfood.platform/routing':'true'}}},
  {'apiVersion':'gateway.networking.k8s.io/v1','kind':'HTTPRoute','metadata':{'name':tool,'namespace':ns},'spec':{'parentRefs':[{'name':'platform','namespace':'envoy-gateway-system'}],'hostnames':[tool+'.'+a.domain],'rules':[{'backendRefs':[{'name':service,'port':port}]}]}}
 ])
print(json.dumps({'apiVersion':'v1','kind':'List','items':items}))
