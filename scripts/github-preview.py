#!/usr/bin/env python3
"""Trusted workflow reconciler: validate artifacts against current GitHub state before acting."""
import json
import os
import re
import urllib.error
import urllib.request


def request(base, path, method='GET', body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base.rstrip('/') + path, data=data, method=method,
        headers={'Content-Type': 'application/json', **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


event = json.load(open(os.environ['GITHUB_EVENT_PATH']))
repo = os.environ['GITHUB_REPOSITORY']
closed = os.environ['GITHUB_EVENT_NAME'] == 'pull_request_target'
artifact = {} if closed else json.load(open('input/preview.json'))
number = event['pull_request']['number'] if closed else int(artifact['PR_NUMBER'])
pr = request('https://api.github.com', f'/repos/{repo}/pulls/{number}', headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN']})
if pr['head']['repo']['full_name'] != repo:
    raise SystemExit('Fork previews require a separately approved workflow')
if not closed:
    if pr['state'] != 'open' or pr['head']['sha'] != artifact['REVISION']:
        raise SystemExit('Preview input superseded; no deployment performed')
    if not re.fullmatch(re.escape(f'ghcr.io/{repo.lower()}/sample@sha256:') + '[a-f0-9]{64}', artifact['IMAGE']):
        raise SystemExit('Unexpected image reference')
name = f'pr-{number}'
headers = {'Authorization': 'Bearer ' + os.environ['DOGFOOD_SERVICE_TOKEN'], 'X-Dogfood-Subject': f"github:{pr['user']['id']}", 'Idempotency-Key': f"{number}:{pr['head']['sha']}:{os.environ['GITHUB_RUN_ID']}"}
base = os.environ['DOGFOOD_API_URL']
try:
    env = request(base, f'/v1/environments/{name}', headers=headers)
except urllib.error.HTTPError as error:
    if error.code != 404:
        raise
    env = None
if closed:
    if env and env['status'] not in ['deleted', 'deleting']:
        confirmation = request(base, f'/v1/environments/{name}/confirm-delete', 'POST', {}, headers)
        operation = request(base, f'/v1/environments/{name}/destroy', 'POST', {'confirmation': confirmation['id']}, headers)
    else:
        operation = {'status': 'already absent'}
elif env and env['status'] != 'deleted':
    operation = request(base, f'/v1/environments/{name}/redeploy', 'POST', {'image': artifact['IMAGE'], 'revision': artifact['REVISION'], 'generation': env['generation']}, headers)
else:
    operation = request(base, '/v1/environments', 'POST', {'id': name, 'image': artifact['IMAGE'], 'revision': artifact['REVISION'], 'profile': 'preview', 'warm': True}, headers)
with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
    summary.write(f"## Preview {name}\n\nOperation: `{operation.get('id', operation['status'])}`\n\nSee the portal for readiness and startup timings.\n")
