#!/usr/bin/env bash
# crd-schemas.sh — generate kubeconform JSON schemas from the Teleport operator CRDs (one-off).
source "$(dirname "$0")/_common.sh"
out="$REPO_ROOT/tests/teleport/policy/schemas"; mkdir -p "$out"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
ui::step "Pulling teleport-cluster chart $TELEPORT_VERSION for its CRDs"
helm pull teleport-cluster --repo https://charts.releases.teleport.dev --version "$TELEPORT_VERSION" --untar --untardir "$tmp" >/dev/null
ui::require python3
python3 -c 'import yaml' 2>/dev/null || ui::die "PyYAML is required (pip install pyyaml)"
for crd in "$tmp"/teleport-cluster/charts/teleport-operator/operator-crds/*.yaml; do
  python3 - "$crd" "$out" <<'PY'
import json, sys, os
try:
    import yaml
    docs = list(yaml.safe_load_all(open(sys.argv[1])))
except ImportError:
    sys.exit(0)
for d in docs:
    if not d or d.get("kind") != "CustomResourceDefinition": continue
    group = d["spec"]["group"]; kind = d["spec"]["names"]["kind"]
    for v in d["spec"]["versions"]:
        schema = v.get("schema", {}).get("openAPIV3Schema", {"type": "object"})
        os.makedirs(os.path.join(sys.argv[2], group), exist_ok=True)
        with open(os.path.join(sys.argv[2], group, f"{kind}_{v['name']}.json"), "w") as f:
            json.dump(schema, f)
PY
done
ui::ok "schemas in tests/teleport/policy/schemas ($(find "$out" -name '*.json' | wc -l | tr -d ' ') files)"
