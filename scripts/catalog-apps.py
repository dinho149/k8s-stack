#!/usr/bin/env python3
"""Emit pinned Argo applications. Cloud-specific Helm values must be supplied explicitly."""
import json
import os
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent.parent
repo, profile = sys.argv[1:]
items = []
for component in json.loads((root / 'catalog/components.json').read_text())['components']:
    if component.get('cloudOnly') and profile == 'local':
        continue
    sources = [{'repoURL': component['repo'], 'chart': component['chart'], 'targetRevision': component['version'],
                'helm': {'valuesObject': component['values']}}]
    if component.get('cloudOnly'):
        path = root / 'catalog/values' / f"{component['name']}.{profile}.json"
        if not path.exists():
            raise SystemExit(f'Required provider settings missing: {path}; refusing partial cloud configuration')
        sources[0]['helm']['valuesObject'].update(json.loads(path.read_text()))
    items.append({'apiVersion':'argoproj.io/v1alpha1','kind':'Application','metadata':{'name':component['name'],'namespace':'argocd'},'spec':{
        'project':'platform','sources':sources,'destination':{'server':'https://kubernetes.default.svc','namespace':component['namespace']},
        'syncPolicy':{'automated':{'prune':True,'selfHeal':True},'syncOptions':['CreateNamespace=true','ServerSideApply=true']}}})
print(json.dumps({'apiVersion':'v1','kind':'List','items':items}))
