#!/usr/bin/env python3
"""Verify healthy preview applications and deny cross-preview pod traffic."""
import json
import subprocess

base = ['kubectl', '--context', 'kind-dogfood-local']
pods = json.loads(subprocess.check_output(base + ['get', 'pods', '-A', '-l', 'app=dogfood-sample', '-o', 'json']))['items']
pods = [p for p in pods if p['status'].get('phase') == 'Running' and p['metadata']['namespace'].startswith('preview-')]
if len({p['metadata']['namespace'] for p in pods}) < 2:
    raise SystemExit('Need two running previews to test isolation')
a = pods[0]
b = next(p for p in pods if p['metadata']['namespace'] != a['metadata']['namespace'])
for pod in [a, b]:
    subprocess.run(base + ['exec', '-n', pod['metadata']['namespace'], pod['metadata']['name'], '--', 'python', '-c', 'import urllib.request; assert urllib.request.urlopen("http://localhost:8080/readyz", timeout=3).status == 200'], check=True)
code = '''import socket,sys
s=socket.socket();s.settimeout(3)
try:s.connect((sys.argv[1],8080))
except TimeoutError:print("Cross-preview traffic blocked; both application readiness controls passed");sys.exit(0)
except OSError as exc:print("Inconclusive connectivity error:",exc);sys.exit(2)
print("ISOLATION FAILURE");sys.exit(1)
'''
subprocess.run(base + ['exec', '-n', a['metadata']['namespace'], a['metadata']['name'], '--', 'python', '-c', code, b['status']['podIP']], check=True)
