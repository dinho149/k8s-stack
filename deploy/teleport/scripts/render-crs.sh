#!/usr/bin/env bash
# render-crs.sh — render Teleport CRs offline (Pulumi mocks) and validate with kubeconform.
source "$(dirname "$0")/_common.sh"
# Start from an empty directory so renamed/removed resources do not linger from a previous layout.
out="$REPO_ROOT/tests/teleport/policy/rendered"; rm -rf "$out"; mkdir -p "$out"
ui::spinner "Rendering CRs for stack $STACK" npm run -w infra/teleport --silent render -- --stack "$STACK" --out "$out" || exit 1
if command -v kubeconform >/dev/null 2>&1; then
  schemas="$REPO_ROOT/tests/teleport/policy/schemas"
  [[ -d "$schemas" ]] || "$REPO_ROOT/deploy/teleport/scripts/crd-schemas.sh"
  ui::spinner "kubeconform" kubeconform -strict -summary -schema-location default -schema-location "$schemas/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" "$out"
else ui::warn "kubeconform not installed (brew install kubeconform) — rendered CRs are in tests/teleport/policy/rendered"; fi
