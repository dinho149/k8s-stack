This repository is a Teleport privileged-access platform (see docs/access-model.md). Beyond generic
vulnerability classes, treat the following as HIGH severity:

- Any path by which an access request can be approved without a human when the requested roles are not
  all auto-approvable (`services/teleport-access/internal/policy`, `internal/broker`).
- Identity taken from a caller-controlled value (HTTP header, JSON body, chat payload) instead of the signed
  `X-Teleport-Assertion` produced by `services/access-agent/src/identity` and verified in `internal/assertion`.
- Approver checks that can be satisfied by an email/local-part that is not bound to the Teleport user's traits,
  or self-approval through case or alias variants.
- Standing privilege: rendered roles granting `editor`, `access`, `system:masters`, wildcard `db_users`,
  `logins: [root]`, or bots whose `impersonate` reaches those roles (`infra/teleport/src/policy`).
- Secrets on argv, in logs, in world-readable files, or in child-process environments
  (`deploy/scripts`, `services/access-agent/src/agent`).
- TLS verification disabled outside the guarded `TSH_INSECURE_FLAG` / kind-only paths.
- Kubernetes manifests missing NetworkPolicy, securityContext hardening or automountServiceAccountToken=false.
