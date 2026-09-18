#!/usr/bin/env python3
"""Validate that every pinned upstream chart can be resolved without installing it."""
import concurrent.futures
import json
import pathlib
import subprocess

root=pathlib.Path(__file__).resolve().parent.parent
items=json.loads((root/'catalog/components.json').read_text())['components']
def check(item):
 result=subprocess.run(['helm','show','chart',item['chart'],'--repo',item['repo'],'--version',item['version']],capture_output=True,text=True,timeout=90)
 return item['name'],result.returncode,result.stderr.strip()
failures=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 for name,status,error in pool.map(check,items):
  print(f'{name}: {"OK" if status==0 else error}')
  if status:failures.append(name)
if failures:raise SystemExit(1)
