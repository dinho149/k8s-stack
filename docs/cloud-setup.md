# Cloud installation

The modules in `infra/aws` and `infra/gcp` provision host clusters, networking, nodes, and inference workload identity. Separate root modules in `infra/data` protect durable databases with deletion protection and `prevent_destroy`. Use distinct cloud accounts/projects and remote state keys for management, previews, dev, staging, and production.

## Infrastructure

Create encrypted remote-state buckets with locking/versioning before initialization. AWS uses an S3 backend; GCP uses GCS. Supply backend settings using `tofu init -backend-config=...`, without committing credentials. Then supply the required variables, run `tofu plan -out=...`, review, and apply that saved plan.

AWS inputs: name, region, explicit Bedrock model/profile ARNs, and optional restricted public API CIDRs. The default API is private. The initial network uses one NAT gateway: use per-AZ NAT before treating the network as highly available. Configure operator EKS access entries and install EBS CSI, load balancer integration, and NetworkPolicy enforcement before bootstrap. Use a dedicated preview host because the lifecycle controller needs elevated namespace/Helm/RBAC administration privileges; the AI service has no Kubernetes RBAC binding.

GCP inputs: name, project, region, and optional authorized API networks. Nodes and API are private by default, using Dataplane V2 and Workload Identity. Cloud SQL's separate module expects Private Services Access to be configured on its supplied network. The example requires explicit IAM database-user provisioning before application use.

These modules have been statically validated; real account provisioning, quotas, billing, workload federation, backup restoration, and availability exercises require credentials and are not certified by the local test.

## Bootstrap and GitOps

Obtain a kubeconfig through your cloud CLI, then create a configuration based on `configs/local.yaml` with provider `existing`, the cloud context, non-local profile, real domain, issuer, audience, and identity mappings. Run `stack up --bootstrap`. For cloud installs, the Gateway requires a wildcard TLS Secret `envoy-gateway-system/platform-wildcard` from cert-manager and a load balancer implementation.

Configure ExternalDNS domain filters, provider credentials/identity, and unique TXT ownership; configure Velero's object-store provider and credentials. Place installation-specific values in `catalog/values/external-dns.<profile>.json` and `velero.<profile>.json`; the generator fails closed if these are missing. Do not commit secrets. Then:

```sh
export STACK_CONTEXT='<context>'
export STACK_PROFILE=dev
export STACK_REPOSITORY='https://github.com/<owner>/k8s-stack.git'
python3 scripts/configure-gitops.py --repository "$STACK_REPOSITORY" | kubectl --context "$STACK_CONTEXT" apply -f -
bash scripts/catalog-sync.sh
kubectl --context "$STACK_CONTEXT" apply -f deploy/policies.yaml
```

Apply policies after Kyverno is healthy. Install the lifecycle/agent Helm chart on the dedicated preview host with an explicit valid `lifecycle.config`; use context `in-cluster`, listener `0.0.0.0:8088`, durable state path `/workspace/.stack/state.db`, and an OIDC issuer. Build and publish the two platform images first. Provision `stack-secrets` through External Secrets; include `STACK_SERVICE_TOKEN`, chat credentials, and optional release workflow credentials. Agent identity annotations come from the cloud module outputs.

## Persistent environments

Register dev, staging, and prod cluster credentials with Argo CD using those exact names. Replace the repository placeholder in `deploy/persistent-applications.yaml`, configure AppProjects, and supply environment values. The promotion workflow records the same immutable image/revision in dev → staging → prod; protect staging/prod GitHub environments with required reviewers and branch policies before enabling it. Configure `STACK_GITHUB_REPOSITORY` and `STACK_GITHUB_TOKEN` (workflow dispatch scope) on the lifecycle service.

Persistent application Helm values must use external databases for production. The sample chart's default database is explicitly disposable; do not place production data in its PVC. There is no automated production infrastructure teardown through the preview API.

## Portal and SSO

Run Backstage with a durable PostgreSQL database and the production `app-config.yaml` populated from environment variables. Set `platform.identities` to map authenticated Backstage entity refs to lifecycle subjects. Populate the catalog with your users/groups. Configure Keycloak using `deploy/identity` and a secret containing its database/hostname/bootstrap settings and OIDC client secrets. Import the realm with organization-approved GitHub application credentials.

Set Argo CD `configs.cm.oidc.config` and Grafana `grafana.ini.auth.generic_oauth` to the Keycloak realm; deliver their client secrets through external secrets. Configure tool HTTPRoutes under the wildcard gateway. Keep raw metrics/log endpoints internal. OpenCost requires an authenticated proxy before external exposure. Tool SSO, DNS, and production certificates are installation integrations, not automatically inferred from cloud accounts.

## Build portal images

Build `packages/backend/Dockerfile` and `packages/portal/Dockerfile` from the repository root. Pass `--build-arg VITE_BACKEND_URL=https://portal.<domain>` to the frontend build. Enable `portal.enabled` in the platform chart and supply both image references, hostname, and a production Backstage configuration. Its backend listener must be `0.0.0.0:7007`; lifecycle and agent URLs should use Kubernetes service names. The portal namespace needs label `stack.platform/routing=true` for the shared Gateway. Configure durable Backstage PostgreSQL and secret-based OIDC settings before enabling this chart option.

Run `scripts/tool-routes.py --domain <domain> --tools argocd,grafana,keycloak` only after configuring their SSO, then apply its output to the management cluster. OpenCost is deliberately omitted until an authenticated proxy is configured. Apply `deploy/backup-schedule.yaml` only after a tested Velero destination exists. For staging/prod promotions, also supply `ARGOCD_SERVER` and an application-read-only `ARGOCD_AUTH_TOKEN` to the protected GitHub environment: the workflow verifies that the preceding environment is Healthy, Synced, and running the same digest.

Enable `monitoring.enabled=true` in the platform chart after installing the Prometheus Operator. Store a random `STACK_METRICS_TOKEN` in the platform Secret; the lifecycle service and ServiceMonitor use that same key. Configure Prometheus to discover ServiceMonitors in the platform namespace, then apply `deploy/monitoring/startup-alert.yaml` in the monitoring namespace. Startup histograms measure operation start through each readiness phase; the portal also retains request time for queue-delay inspection.
