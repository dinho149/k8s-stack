#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
name=${1:?}; image=${2:?}; revision=${3:?}
[[ "$name" =~ ^[a-z][a-z0-9-]{0,39}$ ]] || exit 2
ns="preview-$name"
require_owned_namespace "$ns"
k apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Namespace
metadata:
  name: $ns
  labels:
    stack.platform/managed: 'true'
    stack.platform/environment: $name
    stack.platform/routing: 'true'
---
apiVersion: v1
kind: ResourceQuota
metadata: {name: preview, namespace: $ns}
spec:
  hard:
    requests.cpu: '4'
    requests.memory: 4Gi
    limits.memory: 8Gi
    persistentvolumeclaims: '5'
    requests.storage: 20Gi
    pods: '20'
---
apiVersion: v1
kind: LimitRange
metadata: {name: defaults, namespace: $ns}
spec:
  limits:
    - type: Container
      defaultRequest: {cpu: 50m, memory: 64Mi}
      default: {cpu: '1', memory: 512Mi}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: isolation, namespace: $ns}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - podSelector: {}
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: envoy-gateway-system}
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: argocd}
  egress:
    - to: [{podSelector: {}}]
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: kube-system}
      ports: [{port: 53, protocol: UDP}, {port: 53, protocol: TCP}]
YAML
# Control plane needs the host API. Restrict this exception to its service-account pods.
api_ip=$(k get service kubernetes -n default -o jsonpath='{.spec.clusterIP}')
k apply -f - >/dev/null <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: control-plane-api, namespace: $ns}
spec:
  podSelector:
    matchLabels: {app: vcluster}
  policyTypes: [Egress]
  egress:
    - to: [{ipBlock: {cidr: $api_ip/32}}]
      ports: [{port: 443, protocol: TCP}]
YAML
api_endpoints=$(k get endpoints kubernetes -n default -o json)
printf '%s' "$api_endpoints" | python3 -c 'import sys,json; e=json.load(sys.stdin); print(json.dumps({"apiVersion":"networking.k8s.io/v1","kind":"NetworkPolicy","metadata":{"name":"control-plane-endpoints","namespace":sys.argv[1]},"spec":{"podSelector":{"matchLabels":{"app":"vcluster"}},"policyTypes":["Egress"],"egress":[{"to":[{"ipBlock":{"cidr":a["ip"]+"/32"}} for s in e["subsets"] for a in s.get("addresses",[])],"ports":[{"port":p["port"],"protocol":"TCP"} for s in e["subsets"] for p in s.get("ports",[])]}]}}))' "$ns" | k apply -f - >/dev/null
if k get crd ciliumnetworkpolicies.cilium.io >/dev/null 2>&1; then
  k apply -f - >/dev/null <<YAML
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata: {name: control-plane-apiserver, namespace: $ns}
spec:
  endpointSelector:
    matchLabels: {app: vcluster}
  egress:
    - toEntities: [kube-apiserver, host]
      toPorts:
        - ports: [{port: '6443', protocol: TCP}, {port: '443', protocol: TCP}]
YAML
fi
if [[ "$STACK_CONTEXT" == in-cluster ]]; then
  python3 "$ROOT/scripts/recover-helm.py" "$name" "$ns" --in-cluster unused
else
  python3 "$ROOT/scripts/recover-helm.py" "$name" "$ns" --kube-context "$STACK_CONTEXT"
fi
h upgrade --install "$name" vcluster --repo https://charts.loft.sh --version 0.37.1 --namespace "$ns" -f "$ROOT/deploy/vcluster-values.yaml" --wait --timeout 5m >&2
printf 'STACK_PHASE=cluster-ready\n'
work=$(mktemp -d); pf=''
cleanup() { [[ -z "$pf" ]] || kill "$pf" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT
# Credentials are temporary and never printed or persisted to Git.
for _ in $(seq 1 60); do k get secret "vc-$name" -n "$ns" >/dev/null 2>&1 && break; sleep 1; done
k get secret "vc-$name" -n "$ns" -o jsonpath='{.data.config}' | base64 --decode > "$work/kubeconfig"
chmod 600 "$work/kubeconfig"
port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
k -n "$ns" port-forward "service/$name" "$port:443" > "$work/forward.log" 2>&1 & pf=$!
cluster=$(kubectl --kubeconfig "$work/kubeconfig" config view -o jsonpath='{.clusters[0].name}')
kubectl --kubeconfig "$work/kubeconfig" config set-cluster "$cluster" --server="https://127.0.0.1:$port" >/dev/null
for _ in $(seq 1 60); do kubectl --kubeconfig "$work/kubeconfig" get --raw=/readyz >/dev/null 2>&1 && break; sleep 1; done
kubectl --kubeconfig "$work/kubeconfig" get --raw=/readyz >/dev/null
printf 'STACK_PHASE=platform-ready\n'
if [[ "${STACK_PROFILE:-}" == local ]]; then
  python3 "$ROOT/scripts/recover-helm.py" sample default --kubeconfig "$work/kubeconfig"
  helm --kubeconfig "$work/kubeconfig" upgrade --install sample "$ROOT/deploy/charts/sample" --namespace default --set-string image="$image" --set-string revision="$revision" --wait --timeout 5m >&2
else
  # Register the virtual API with Argo CD using certificate credentials, never a cluster-admin bearer token in Git.
  python3 "$ROOT/scripts/argocd-cluster.py" "$work/kubeconfig" "$name" "$ns" | k apply -f - >/dev/null
  k apply -f - >/dev/null <<YAML
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: preview-$name
  namespace: argocd
  labels: {stack.platform/managed: 'true'}
spec:
  project: previews
  source:
    repoURL: $STACK_REPOSITORY
    targetRevision: main
    path: deploy/charts/sample
    helm:
      parameters:
        - {name: image, value: '$image'}
        - {name: revision, value: '$revision'}
  destination:
    server: https://$name.$ns.svc:443
    namespace: default
  syncPolicy:
    automated: {prune: true, selfHeal: true}
YAML
fi
k apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Service
metadata: {name: sample-route, namespace: $ns}
spec:
  selector: {app: stack-sample}
  ports: [{name: http, port: 80, targetPort: 8080}]
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: {name: sample, namespace: $ns}
spec:
  parentRefs: [{name: platform, namespace: envoy-gateway-system}]
  hostnames: ['$name.$STACK_DOMAIN']
  rules:
    - backendRefs: [{name: sample-route, port: 80}]
YAML
scheme=https; suffix=''
if [[ "${STACK_PROFILE:-}" == local ]]; then scheme=http; suffix=:18080; fi
for _ in $(seq 1 150); do
  if body=$(curl --silent --fail --max-time 3 "$scheme://$name.$STACK_DOMAIN$suffix/readyz") && [[ "$body" == "$revision" ]]; then
    printf 'STACK_PHASE=application-ready\n'; exit 0
  fi
  sleep 2
done
echo 'Application revision did not become reachable before timeout' >&2
exit 1
