# Cloud environments

The cloud stacks (`Pulumi.dev-eks.yaml`, `Pulumi.dev-gke.yaml`, `Pulumi.dev-aks.yaml`, `Pulumi.prod-eks.yaml`) are
scaffolds that render against any kubeconfig context. Only the local kind path is verified end to end.

## What to fill in

1. `teleport:kubeContext` — a context in your kubeconfig for the existing cluster (Pulumi never uses the current context).
2. `teleport:clusterName` / `teleport:publicAddr` — a DNS name you control; `clusterName` is immutable once deployed.
3. TLS — `cert-manager` (default, needs a `ClusterIssuer`), `acme` (Let's Encrypt via Teleport), or `existing-secret`.
4. GitHub SSO — `make github-sso STACK=dev-eks` (callback `https://<publicAddr>/v1/webapi/github/callback`).
5. Images — push with `IMAGE_REGISTRY=ghcr.io/<org>/k8s-teleport make images` (or the `release-images` workflow) and set `teleport:images`.
6. Backend — switch `teleport:chartMode` to `aws` / `gcp` / `azure` once the managed resources exist (tables, buckets,
   IAM role / Workload Identity / managed identity). `CloudBackend`-style annotations are rendered from the same block.
7. `teleport:dummies` — disable in production.

Then `make preview STACK=dev-eks` and `make deploy STACK=dev-eks`. `insecureLocal` must stay `false` (the schema enforces it).

## Differences from local

| | local (kind) | cloud |
|---|---|---|
| exposure | NodePort 30080 → host 3080 | `LoadBalancer` (NLB/RBS annotations) or Ingress |
| DNS | CoreDNS rewrite of the public host (LocalDns) | real DNS |
| TLS | self-signed, `tsh --insecure` | cert-manager / ACME |
| MFA | OTP | WebAuthn + OTP (admin actions need MFA for humans; the bots are exempt) |
| state backend | Pulumi local file backend | Pulumi Cloud or `s3://` / `gs://` / `azblob://` via `PULUMI_BACKEND_URL` |
