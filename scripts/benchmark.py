#!/usr/bin/env python3
"""Run real preview lifecycle benchmarks; retain failed runs and clean up every created preview."""
import argparse
import concurrent.futures
import json
import os
import time
import urllib.request
import uuid
from pathlib import Path

p=argparse.ArgumentParser()
p.add_argument('--image',required=True)
p.add_argument('--revision',required=True)
p.add_argument('--runs',type=int,default=30)
p.add_argument('--concurrency',type=int,default=5)
p.add_argument('--output',default='.dogfood/benchmark.json')
args=p.parse_args()
base=os.environ.get('DOGFOOD_API_URL','http://127.0.0.1:8088')
token=os.environ.get('DOGFOOD_TOKEN') or os.environ['DOGFOOD_LOCAL_TOKEN']

def request(path,method='GET',body=None):
    req=urllib.request.Request(base+path,method=method,data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':str(uuid.uuid4())})
    with urllib.request.urlopen(req,timeout=30) as res:return json.load(res)

def wait(operation):
    deadline=time.monotonic()+1200
    while time.monotonic()<deadline:
        op=request('/v1/operations/'+operation['id'])
        if op['status'] in ['succeeded','failed','superseded']:return op
        time.sleep(2)
    raise TimeoutError('Lifecycle operation exceeded 20 minutes')

def launch(index):
    name='bench-'+uuid.uuid4().hex[:12]
    op=None
    try:
        op=request('/v1/environments','POST',{'id':name,'image':args.image,'revision':args.revision,'warm':True})
        result=wait(op)
        print(f"{index+1}: {name}: {result['status']}",flush=True)
        return result
    except Exception as exc:
        return {'environmentId':name,'action':'deploy','warm':True,'status':'failed','error':str(exc)}
    finally:
        if op:
            confirmation=request('/v1/environments/'+name+'/confirm-delete','POST',{})
            deletion=request('/v1/environments/'+name+'/destroy','POST',{'confirmation':confirmation['id']})
            cleanup=wait(deletion)
            if cleanup['status']!='succeeded':raise RuntimeError(f'Cleanup failed for {name}')

Path(args.output).parent.mkdir(parents=True,exist_ok=True)
results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
    futures=[pool.submit(launch,i) for i in range(args.runs)]
    for future in concurrent.futures.as_completed(futures):
        try: results.append(future.result())
        except Exception as exc: results.append({'action':'deploy','warm':True,'status':'failed','error':str(exc)})
        temp=Path(args.output+'.tmp')
        temp.write_text(json.dumps(results,indent=2)+'\n')
        temp.replace(args.output)
if any(r['status']!='succeeded' for r in results):raise SystemExit(1)
