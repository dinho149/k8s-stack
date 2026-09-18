#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
name=${STACK_NAME:-stack-local}
registry=stack-registry
if docker container inspect "$registry" >/dev/null 2>&1; then
  [[ $(docker inspect -f '{{index .Config.Labels "stack.platform/managed"}}' "$registry") == true ]] || { echo 'Refusing to use an unmanaged registry' >&2; exit 1; }
  docker start "$registry" >&2
else
  docker run -d --restart=unless-stopped --label stack.platform/managed=true -p 127.0.0.1:5005:5000 --name "$registry" registry:2.8.3 >&2
fi
if ! docker network inspect kind --format '{{range .Containers}}{{println .Name}}{{end}}' | rg -qx "$registry"; then docker network connect kind "$registry"; fi
for node in $(kind get nodes --name "$name"); do
  docker exec "$node" mkdir -p /etc/containerd/certs.d/localhost:5005
  docker exec -i "$node" sh -c 'cat > /etc/containerd/certs.d/localhost:5005/hosts.toml' <<'TOML'
[host."http://stack-registry:5000"]
  capabilities = ["pull", "resolve"]
TOML
done
docker build -t localhost:5005/stack-sample:dev "$ROOT/examples/sample" >&2
docker push localhost:5005/stack-sample:dev >&2
docker image inspect localhost:5005/stack-sample:dev --format '{{index .RepoDigests 0}}'
