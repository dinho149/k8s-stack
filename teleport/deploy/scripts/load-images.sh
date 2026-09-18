#!/usr/bin/env bash
# load-images.sh [tag] — build service images and load them into kind (local) or push (cloud).
# Services are discovered by the presence of services/*/Dockerfile.
source "$(dirname "$0")/_common.sh"
tag="${1:-${IMAGE_TAG:-dev}}"
registry="${IMAGE_REGISTRY:-}"   # empty => local images named k8s-teleport/<svc>:<tag>, loaded into kind
shopt -s nullglob
dockerfiles=("$REPO_ROOT"/services/*/Dockerfile "$REPO_ROOT"/deploy/images/*/Dockerfile)
if (( ${#dockerfiles[@]} == 0 )); then ui::info "no service images to build yet"; exit 0; fi
digests=()
for df in "${dockerfiles[@]}"; do
  dir="$(dirname "$df")"; svc="$(basename "$dir")"
  img="${registry:+$registry/}k8s-teleport/$svc:$tag"; [[ -n "$registry" ]] && img="$registry/$svc:$tag"
  build_args=()
  # The agent build context is the workspace package, but the lockfile lives at the repo root (npm workspaces):
  # pass it in as an additional context so `npm ci` is reproducible and the Dockerfile can require it.
  [[ "$svc" == "access-agent" ]] && build_args+=(--build-context "lockfile=$REPO_ROOT")
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
