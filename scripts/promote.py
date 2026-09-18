#!/usr/bin/env python3
import json
import os
import pathlib
import re
import urllib.request

target, image, revision = (os.environ[x] for x in ['TARGET', 'IMAGE', 'REVISION'])
if target not in ['dev', 'staging', 'prod'] or not re.fullmatch(r'[\w./:-]+@sha256:[a-f0-9]{64}', image) or not re.fullmatch(r'[a-f0-9]{7,64}', revision):
    raise SystemExit('Invalid release input')
previous = {'staging': 'dev', 'prod': 'staging'}.get(target)
if previous:
    source = json.loads(pathlib.Path(f'environments/{previous}/release.json').read_text())
    if source['image'] != image or source['revision'] != revision:
        raise SystemExit('Promote the same image and revision through the preceding environment first')
    server = os.environ.get('ARGOCD_SERVER', '')
    token = os.environ.get('ARGOCD_AUTH_TOKEN', '')
    if not server.startswith('https://') or not token:
        raise SystemExit('Argo CD HTTPS endpoint and read-only credential required to verify the preceding environment')
    req = urllib.request.Request(server.rstrip('/') + f'/api/v1/applications/{previous}-sample', headers={'Authorization': 'Bearer '+token})
    with urllib.request.urlopen(req, timeout=20) as response:
        application = json.load(response)
    status = application.get('status', {})
    if status.get('health', {}).get('status') != 'Healthy' or status.get('sync', {}).get('status') != 'Synced' or image not in status.get('summary', {}).get('images', []):
        raise SystemExit('The preceding environment has not reached healthy, synchronized state with this image')
path = pathlib.Path(f'environments/{target}/release.json')
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps({'image': image, 'revision': revision}, indent=2) + '\n')
