#!/usr/bin/env python3
"""Generate repository-bound AppProjects and persistent ApplicationSet without unsafe string evaluation."""
import argparse
import json
p=argparse.ArgumentParser()
p.add_argument('--repository',required=True)
args=p.parse_args()
items=[]
for name,destinations,cluster in [('previews',[{'server':'https://*.preview-*.svc:443','namespace':'default'}],[]),('persistent',[{'name':x,'namespace':'sample'} for x in ['dev','staging','prod']],[])]:
 items.append({'apiVersion':'argoproj.io/v1alpha1','kind':'AppProject','metadata':{'name':name,'namespace':'argocd'},'spec':{'sourceRepos':[args.repository],'destinations':destinations,'clusterResourceWhitelist':cluster,'namespaceResourceBlacklist':[{'group':'rbac.authorization.k8s.io','kind':'RoleBinding'}]}})
print(json.dumps({'apiVersion':'v1','kind':'List','items':items}))
