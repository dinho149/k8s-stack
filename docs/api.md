# Lifecycle API v1

All `/v1` routes require an OIDC bearer token, explicit loopback development token, or a trusted service token with a configured `X-Dogfood-Subject`. Unknown users are rejected. JSON bodies reject unknown fields and trailing content; maximum body size is 64 KiB.

| Method | Route | Purpose |
|---|---|---|
| GET | `/healthz` | Public process liveness |
| GET | `/v1/me` | Authenticated identity and roles |
| GET/POST | `/v1/environments` | Visible environments / create owned preview |
| GET | `/v1/environments/{name}` | State, generation, owner, revision, expiry, URL |
| POST | `/v1/environments/{name}/extend` | `{mode: "add" or "from-now", minutes, generation}` |
| POST | `/v1/environments/{name}/redeploy` | `{image, revision, generation}` |
| POST | `/v1/environments/{name}/confirm-delete` | Mint actor/resource/generation-bound confirmation |
| POST | `/v1/environments/{name}/destroy` | `{confirmation}` |
| GET | `/v1/environments/{name}/diagnostics` | Scoped, redacted Kubernetes events |
| GET | `/v1/operations` or `/v1/operations/{id}` | Operation phase, error, attempt and timing history |
| GET | `/v1/policies` | Effective lifecycle constraints; admins also see cluster policy objects |
| GET | `/v1/tools` | Configured tool destinations |
| POST | `/v1/promotions` | `{target, image, revision}`; dispatch protected GitHub workflow |
| POST | `/v1/link-code` | Single-use chat identity link code, valid five minutes |
| GET | `/v1/audit` | Administrator audit history |

Creation requires `Idempotency-Key`, a DNS-safe name, commit SHA, and immutable image digest. A repeated key returns the original operation; a changed payload conflicts. A new key is required when reopening a deleted preview. Images use `registry/path@sha256:<64 lowercase hex>`.

Operation statuses: `queued`, `running`, `succeeded`, `failed`, `superseded`. Environment statuses: `pending`, `ready`, `failed`, `deleting`, `deleted`. A failed delete retains `deleting` and retries later, preventing extension after cleanup starts.

`timings` contains UTC timestamps for `cluster-ready`, `platform-ready`, and `application-ready`; `requestedAt`, `startedAt`, and `finishedAt` distinguish queue, execution, and completion. Only a successful application probe produces application readiness. Failures never fabricate timing samples.

Internal routes are service-authenticated and must not be publicly routed. They resolve linked identities, atomically consume link codes, lease notification batches, and acknowledge deliveries. The Backstage backend never accepts a browser-provided subject: it derives the identity from Backstage credentials and its configured mapping.
