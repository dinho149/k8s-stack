#!/usr/bin/env bash
# load-images.sh [tag] — build the Teleport service images and load them into kind (local) or push (cloud).
# The image list is explicit (Dogfood's own services/agent image is not part of the Teleport stack):
#   teleport-access  Go binary from the root module   (context: repo root, -f deploy/teleport/images/teleport-access/Dockerfile)
#   access-agent     npm workspace                     (context: services/access-agent, + lockfile=<repo root>)
#   ssh-node         dummy SSH node                    (context: deploy/teleport/images/ssh-node)
source "$(dirname "$0")/_common.sh"
tag="${1:-${IMAGE_TAG:-dev}}"
registry="${IMAGE_REGISTRY:-}"   # empty => local images named k8s-teleport/<svc>:<tag>, loaded into kind
images=(teleport-access access-agent ssh-node)
digests=()
for svc in "${images[@]}"; do
  img="${registry:+$registry/}k8s-teleport/$svc:$tag"; [[ -n "$registry" ]] && img="$registry/$svc:$tag"
  build_args=()
  case "$svc" in
    teleport-access) dir="$REPO_ROOT"; build_args+=(-f "$REPO_ROOT/deploy/teleport/images/teleport-access/Dockerfile");;
    # The agent build context is the workspace package, but the lockfile lives at the repo root (npm workspaces):
    # pass it in as an additional context so `npm ci` is reproducible and the Dockerfile can require it.
    access-agent)    dir="$REPO_ROOT/services/access-agent"; build_args+=(--build-context "lockfile=$REPO_ROOT");;
    ssh-node)        dir="$REPO_ROOT/deploy/teleport/images/ssh-node";;
  esac
  # ${arr[@]+"${arr[@]}"} keeps `set -u` happy on bash 3.2 (macOS) when the array is empty.
  ui::spinner "docker build $svc" docker build -q ${build_args[@]+"${build_args[@]}"} -t "$img" "$dir" || exit 1
  if [[ -n "$registry" ]]; then
    ui::spinner "docker push $img" docker push "$img" || exit 1
    d="$(docker inspect --format '{{index .RepoDigests 0}}' "$img" 2>/dev/null | sed 's/.*@//')"
    [[ -n "$d" ]] && digests+=("$svc: $d")
  else
    ui::spinner "kind load $svc" kind load docker-image --name "$KIND_CLUSTER" "$img" || exit 1
    # A re-used tag (dev) does not change the Deployment spec, so restart the pods that run this image.
    for ns in teleport-access teleport-dummies; do
      for d in $($KUBECTL -n "$ns" get deploy,statefulset -o json 2>/dev/null | python3 -c 'import json,sys; img=sys.argv[1]
for i in json.load(sys.stdin)["items"]:
    if any(c["image"]==img for c in i["spec"]["template"]["spec"]["containers"]): print(i["kind"].lower()+"/"+i["metadata"]["name"])' "$img"); do
        $KUBECTL -n "$ns" rollout restart "$d" >/dev/null 2>&1 && ui::info "restarted $ns/$d"
      done
    done
  fi
done
if (( ${#digests[@]} )); then
  # Same shape as the release workflow's job summary: paste under teleport:images in Pulumi.<stack>.yaml
  ui::section "images.digests (pin these in Pulumi.$STACK.yaml under teleport:images)"
  printf '  images:\n    digests:\n'; printf '      %s\n' "${digests[@]}"
fi
