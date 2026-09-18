#!/usr/bin/env python3
"""Convert temporary kubeconfig to an Argo cluster Secret without printing credentials to logs."""
import base64
import json
import subprocess
import sys

path, name, namespace = sys.argv[1:]
config = json.loads(subprocess.check_output(['kubectl', '--kubeconfig', path, 'config', 'view', '--raw', '-o', 'json']))
cluster = config['clusters'][0]['cluster']
user = config['users'][0]['user']
print(json.dumps({
    'apiVersion': 'v1', 'kind': 'Secret',
    'metadata': {'name': f'cluster-{name}', 'namespace': 'argocd', 'labels': {'argocd.argoproj.io/secret-type': 'cluster', 'dogfood.platform/managed': 'true'}},
    'stringData': {'name': name, 'server': f'https://{name}.{namespace}.svc:443',
      'config': json.dumps({'tlsClientConfig': {'insecure': False, 'caData': cluster['certificate-authority-data'], 'certData': user['client-certificate-data'], 'keyData': user['client-key-data']}})},
}))
