#!/usr/bin/env python3
"""Recover a release interrupted by process/network loss under the lifecycle environment lock."""
import json
import subprocess
import sys

release, namespace, flag, value = sys.argv[1:]
base=['helm'] if flag == '--in-cluster' else ['helm',flag,value]
status=subprocess.run(base+['status',release,'-n',namespace,'-o','json'],capture_output=True,text=True)
if status.returncode:
    raise SystemExit(0)
data=json.loads(status.stdout)
if not data['info']['status'].startswith('pending-'):
    raise SystemExit(0)
history=json.loads(subprocess.check_output(base+['history',release,'-n',namespace,'-o','json']))
deployed=[r['revision'] for r in history if r['status']=='deployed']
# Replaying revision 1 preserves the generated database Secret from its stored manifest.
revision=max(deployed) if deployed else min(r['revision'] for r in history)
subprocess.run(base+['rollback',release,str(revision),'-n',namespace,'--wait','--timeout','3m'],check=True,stdout=sys.stderr)
