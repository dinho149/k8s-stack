#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
mkdir -p .stack
if [[ ! -f .stack/local.env ]]; then
  python3 - <<'PY'
import os,secrets
path='.stack/local.env'
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:
 for key in ['STACK_LOCAL_TOKEN','STACK_SERVICE_TOKEN','BACKSTAGE_DB_PASSWORD']:
  f.write(f'export {key}={secrets.token_hex(32)}\n')
PY
fi
source .stack/local.env
export STACK_API_URL=http://127.0.0.1:8088
export BACKSTAGE_DATABASE_URL="postgresql://stack:$BACKSTAGE_DB_PASSWORD@127.0.0.1:15432/backstage"
export STACK_LOCAL_DEVELOPMENT=1
export NODE_ENV=development
export VITE_LOCAL_DEVELOPMENT=true
if docker container inspect stack-backstage-db >/dev/null 2>&1; then
  [[ $(docker inspect -f '{{index .Config.Labels "stack.platform/managed"}}' stack-backstage-db) == true ]] || exit 1
  docker start stack-backstage-db >/dev/null
else
  export POSTGRES_PASSWORD="$BACKSTAGE_DB_PASSWORD"
  docker run -d --name stack-backstage-db --label stack.platform/managed=true -p 127.0.0.1:15432:5432 -e POSTGRES_USER=stack -e POSTGRES_DB=backstage -e POSTGRES_PASSWORD postgres:16-alpine >/dev/null
fi
for _ in $(seq 1 30); do docker exec stack-backstage-db pg_isready -U stack >/dev/null 2>&1 && break; sleep 1; done
go build -o bin/stack ./cmd/stack
pids=()
cleanup(){ for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM
bin/stack serve > .stack/lifecycle.log 2>&1 & pids+=("$!")
(cd packages/backend && exec ../../node_modules/.bin/tsx src/index.ts --config ../../app-config.local.yaml) > .stack/backstage.log 2>&1 & pids+=("$!")
(cd packages/portal && exec ../../node_modules/.bin/vite --host 127.0.0.1) > .stack/portal.log 2>&1 & pids+=("$!")
echo 'Starting portal at http://localhost:3000; logs are in .stack/'
wait
