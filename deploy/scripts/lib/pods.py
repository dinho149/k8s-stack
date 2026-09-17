#!/usr/bin/env python3
"""Render `kubectl get pods -o json` (stdin) as pipe-separated rows for ui::table. Args: OK-mark BAD-mark."""
import datetime
import json
import sys

ok, bad = sys.argv[1], sys.argv[2]
now = datetime.datetime.now(datetime.timezone.utc)
for p in json.load(sys.stdin).get("items", []):
    cs = p["status"].get("containerStatuses", [])
    ready = sum(1 for c in cs if c.get("ready"))
    total = len(p["spec"]["containers"])
    phase = p["status"].get("phase", "?")
    waiting = [c["state"]["waiting"]["reason"] for c in cs if "waiting" in c.get("state", {})]
    if waiting:
        phase = waiting[0]
    restarts = sum(c.get("restartCount", 0) for c in cs)
    age = now - datetime.datetime.fromisoformat(p["metadata"]["creationTimestamp"].replace("Z", "+00:00"))
    m = int(age.total_seconds() // 60)
    a = f"{m // 60}h{m % 60:02d}m" if m >= 60 else f"{m}m"
    mark = ok if (ready == total and phase == "Running") else bad
    print(f'{p["metadata"]["namespace"]}|{p["metadata"]["name"]}|{ready}/{total} {mark}|{phase}|{restarts}|{a}')
