# Starting fresh with Dogfood

Dogfood uses new technical identifiers and a fresh installation. Existing Stack state, resources, credentials, and browser history are not imported or deleted. There are no compatibility aliases for the old CLI, variables, API header, or metric names.

## Local development

Before updating an active Stack checkout, stop its applications with the old version's `make stop`. The retained Stack database and registry containers still occupy ports 15432 and 5005, and its kind cluster holds gateway ports 18080 and 18443. Use the old version's `make down` if you want to retire its previews and cluster while retaining database/registry data. This is a separate, deliberate operation; Dogfood never does it for you.

If you need to retain the old cluster intact, use a separate host for Dogfood. Default ports are unchanged. Dogfood reports occupied ports and does not terminate untracked processes or adopt Stack resources. Keep a checkout of the old version for managing those resources later.

Review your private `.env` using `.env.example`: rename product variables from `STACK_*` to `DOGFOOD_*` and use `.dogfood/agent` for the default agent state path. Do not copy old service tokens or database credentials into the new generated environment. `make setup` creates fresh private credentials in `.dogfood/local.env`.

Then run:

```sh
make setup
make doctor
make up
```

The new CLI is `bin/dogfood`; state lives in `.dogfood`; the kind cluster is `dogfood-local` with context `kind-dogfood-local`. Dedicated containers are `dogfood-backstage-db` and `dogfood-registry`. Destructive reset requires `make reset CONFIRM=dogfood-local`. The `.stack` directory remains ignored by Git and excluded from Docker build contexts because it can contain retained secrets.

## Integrations and deployment

- Configure GitHub's `DOGFOOD_API_URL` variable and `DOGFOOD_SERVICE_TOKEN` secret before using the updated preview workflow. Update deployment secrets and external clients to the new `DOGFOOD_*` environment variables.
- Trusted service callers now use `X-Dogfood-Subject` with their service credential. Public API routes and JSON payloads are unchanged.
- Platform configuration uses `dogfood.platform/v1alpha1`. Ownership and routing labels use `dogfood.platform/*`; metrics use `dogfood_*`. Update external dashboards and scraping configuration together.
- Review authentication audiences: the default lifecycle audience is now `dogfood`. Register/configure that audience in your identity provider. Backstage, Argo CD, and Grafana retain their third-party client identifiers; their credentials and URLs must match the new installation.
- Helm service, PVC, RBAC, image, and secret defaults use the Dogfood prefix. Review rendered manifests before installing into a fresh cluster. Do not upgrade an old installation in place with these manifests.
- Review OpenTofu plans against separate infrastructure/state before provisioning a fresh cloud installation. Renamed labels and service accounts do not migrate existing resources.

The repository URL and Go module path retain `k8s-stack`. Third-party names such as Backstage, Jetstack, and kube-prometheus-stack remain unchanged. Historical verification records refer to the original Stack installation; new measurements must be recorded separately.
