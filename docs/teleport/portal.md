# The Access pages: just-in-time access from the Dogfood portal

Teleport Community Edition locks its own access-request web pages behind Enterprise, so the Dogfood portal carries
them instead. Teleport stays the engine (roles, certificates, session recording, audit); the portal is the place
where people see what they can reach, request a role, follow the decision and, as approvers, decide.

```
Browser (packages/portal, /access/*)
  │  Backstage session (guest locally, GitHub in cloud)
  ▼
Backstage backend (packages/backend, plugin "platform")   maps the signed-in user to a subject,
  │  Authorization: Bearer <teleport.serviceToken>          forwards /access/* as /v1/*
  │  X-Dogfood-Subject: <subject>
  ▼
teleport-access portal (pod access-portal + tbot, bot svc-access-portal, :8084)
  │  subject -> Teleport user (identity map or username fallback); the user must exist and not be a bot
  │  reads + request creation through internal/teleportaccess/accessapi (the same code as the MCP tools)
  │  approve/deny -> access broker, signed identity assertion (platform "portal")
  ▼
access-broker  (verifies the approver role, blocks self-approval, records access-broker/mode: portal)
```

Contract: [contracts/portal.openapi.yaml](contracts/portal.openapi.yaml). Pages (`packages/portal/src/pages/access/`):

| Tab | What it shows |
|---|---|
| My access | who you are in Teleport, active elevated roles with expiry, the `tsh login --request-id` command for each live grant, your effective access |
| Roles | the catalog with the broker's decision for each role (approved automatically, needs an approver, denied), time box, detail with approvers |
| Request | roles, reason (8–512 characters), duration; a policy preview before submitting; on success the tsh command (immediately for auto-approved roles, once approved otherwise) |
| My requests | your requests by state; detail with the decision evidence (mode, approver, rule, reviews) |
| Approvals | approvers only: pending requests from other people, approve or deny with a reason through a confirmation dialog |

What stays in `tsh`: using a grant. A grant is a certificate, so the portal shows the command
(`tsh login --request-id=<id>`) and the tsh session lists and connects to the elevated resources.

## Identity

| Where | Sign-in | Teleport user |
|---|---|---|
| kind | Backstage guest (subject `local-developer`) | `services.portal.identities` maps `local-developer` → `alice`; `identityFallback: username` lets `TELEPORT_LOCAL_SUBJECT=bob make restart` act as the approver |
| cloud | Backstage GitHub provider (`VITE_AUTH_PROVIDER=github`, `usernameMatchingUserEntityName`, organization ingested into the catalog) | the GitHub login: `teleport.subjectFromEntityName: true` and `identityFallback: username`, because Teleport's GitHub connector names users after their login |

The portal API trusts the subject only with the service token (the lifecycle API's model) and fails closed on
unknown users and bots. Approvals are never decided by the portal: the broker re-verifies the approver against
Teleport, so a wrong mapping can at most show someone their own empty access, never grant anything.

## Local development

```bash
make teleport-up                                   # deploys the access-portal pod with the rest of the stack
make teleport-portal-forward PORTAL_FORWARD=background   # 127.0.0.1:18383 + .dogfood/teleport-portal.env
make restart                                       # the Backstage backend picks up TELEPORT_PORTAL_URL / TELEPORT_SERVICE_TOKEN
make open                                          # Access tab: signed in as the guest -> alice
TELEPORT_LOCAL_SUBJECT=bob make restart            # act as bob (approver) to decide alice's production request
```

Demo: as alice request `dev-ssh` (approved on the spot; the tsh command appears), then `prod-ssh` (pending);
restart as bob, open Approvals, approve with a reason; restart as alice, the request shows the decision evidence
(`access-broker/mode: portal`, approver bob) and the tsh command. `make teleport-tctl ARGS="requests get <id>"` shows
the same annotations in Teleport.

Without the forward the Access tab says "Teleport access is not set up here" (the backend answers 503) and the
rest of the portal is unaffected.

## Tests

- Go: `internal/teleportaccess/accessapi` (guards, TTL clamp, rate limit, visibility), `internal/teleportaccess/portal`
  (auth fails closed, identity mapping, request flow, idempotency, broker pass-through), broker portal-mode test.
- Portal: `packages/portal/tests/access.spec.ts` against the mocked backend (`make test-portal`).
- Live: `make teleport-test-integration` and `make teleport-test-e2e` still cover the broker and tsh paths; the
  portal API can be exercised with the forward and `curl -H "Authorization: Bearer $TELEPORT_SERVICE_TOKEN" -H "X-Dogfood-Subject: local-developer" http://127.0.0.1:18383/v1/me`.
