# ADR 0004 — Pulumi `kubernetes.helm.v4.Chart` for Teleport charts

**Decision.** Charts are installed with `helm.v4.Chart` through one wrapper (`src/lib/helm.ts`).

**Why.** It renders with the Helm SDK (no Helm binary in CI), registers every manifest as a Pulumi resource (real diffs,
readiness awaits) and installs the operator CRDs as ordinary templates. The Teleport charts' only hooks are optional
config-validation Jobs, disabled with `validateConfigOnDeploy: false`.

**Consequences.** If a future chart needs hooks, switch the wrapper's implementation to `helm.v3.Release`; callers do not change.
