/**
 * render.ts — pure functions turning the catalog into Teleport role specs and the broker policy.
 * No Pulumi types here so everything is trivially unit-testable.
 */
import type { RoleConditions, RoleOptions, RoleSpecV7 } from "../crds";
import type { Edition } from "../config/schema";
import { BOTS, CATALOG, FIXED_ROLES, LOW_RISK_ENVS, NEVER_AUTO_ROLES, type CatalogRole } from "./catalog";

export interface RenderedRole {
  name: string;
  description: string;
  spec: RoleSpecV7;
}

const READ = ["list", "read"];
const WRITE = ["create", "update", "delete"];
const RESOURCE_KINDS = ["node", "db", "db_server", "app", "app_server", "kube_cluster", "kube_server", "windows_desktop"];

/** Session controls every elevated (catalog) role carries. */
// require_session_mfa is int-or-string in the operator CRD: "yes" decodes to RequireMFAType_SESSION
// (a YAML boolean is rejected by the API server).
export const HARDENED_OPTIONS: RoleOptions = {
  require_session_mfa: "yes",
  disconnect_expired_cert: true,
  client_idle_timeout: "15m",
  lock: "strict",
  ssh_file_copy: false,
  ssh_port_forwarding: { local: { enabled: false }, remote: { enabled: false } },
  forward_agent: false,
  create_host_user_mode: "off",
  enhanced_recording: ["command", "network"],
};

/** Session controls per edition: pin_source_ip is an Enterprise-only role option (the auth server rejects the role otherwise). */
export function hardenedOptions(edition: Edition, sessionMfa = true): RoleOptions {
  const base = edition === "enterprise" ? { ...HARDENED_OPTIONS, pin_source_ip: true } : { ...HARDENED_OPTIONS };
  return sessionMfa ? base : withoutSessionMfa(base);
}

/** Per-session MFA only works with WebAuthn/SSO factors (Teleport rejects TOTP for it). Stacks whose second
 *  factors are OTP-only (kind, headless test users) must not require it or every elevated session is unusable;
 *  every non-kind stack is forced to WebAuthn by the profile invariants, so there it is always on. */
export function withoutSessionMfa(o: RoleOptions): RoleOptions {
  const { require_session_mfa: _drop, ...rest } = o;
  return rest;
}

export interface RenderOptions {
  harness?: boolean;
  /** require per-session MFA on every human role (default true; false only when no WebAuthn factor exists) */
  sessionMfa?: boolean;
}

/** Elevated resource access never comes with the right to change cluster configuration. */
const DENY_ALL_WRITES: RoleConditions = { rules: [{ resources: ["*"], verbs: WRITE }] };

/** Cluster security settings nobody obtains through a requestable path (deny wins across all held roles). */
const CLUSTER_CONFIG_KINDS = ["cluster_auth_preference", "cluster_networking_config", "session_recording_config"];

/** A catalog role -> Teleport role v7 spec. Access is scoped purely by the `env` label. */
export function renderCatalogRole(r: CatalogRole, edition: Edition = "community", sessionMfa = true): RenderedRole {
  const allow: RoleConditions = {};
  const envSel = { env: [...r.envs] };
  if (r.scope.nodes) {
    allow.node_labels = envSel;
    allow.logins = [...r.scope.nodes.logins];
  }
  if (r.scope.dbs) {
    allow.db_labels = envSel;
    allow.db_users = [...r.scope.dbs.users];
    allow.db_names = [...r.scope.dbs.names];
  }
  if (r.scope.kube) {
    allow.kubernetes_labels = envSel;
    allow.kubernetes_groups = [...r.scope.kube.groups];
    allow.kubernetes_resources = r.scope.kube.resources.map((x) => ({ ...x }));
  }
  if (r.scope.apps) allow.app_labels = envSel;
  if (r.scope.rules) allow.rules = r.scope.rules.map((x) => ({ resources: [...x.resources], verbs: [...x.verbs] }));
  // Rule-granting roles need writes; they still can never touch access requests (no self-approval).
  const deny: RoleConditions = r.scope.rules ? { rules: [{ resources: ["access_request"], verbs: ["update"] }] } : DENY_ALL_WRITES;
  return {
    name: r.name,
    description: r.description,
    spec: {
      options: { max_session_ttl: r.maxSessionTtl, ...hardenedOptions(edition, sessionMfa) },
      allow,
      deny,
    },
  };
}

/** Base role for every human: no resource access, may request any catalog role. */
export function renderRequesterRole(edition: Edition, sessionMfa = true): RenderedRole {
  const request: NonNullable<RoleConditions["request"]> = {
    roles: CATALOG.map((r) => r.name),
    reason: { mode: "required" },
    max_duration: "4h",
  };
  if (edition === "enterprise") {
    // Enterprise-only knobs (verified in Teleport source: checkRoleFeatureSupport).
    request.search_as_roles = CATALOG.map((r) => r.name);
    request.thresholds = [{ name: "one approval", approve: 1, deny: 1 }];
  }
  return {
    name: FIXED_ROLES.requester,
    description: "Base role: no standing access, may request catalog roles",
    spec: {
      options: { max_session_ttl: "8h", ...(sessionMfa ? { require_session_mfa: "yes" as const } : {}), disconnect_expired_cert: true, lock: "strict" },
      allow: { request },
      // Deny rules apply to every role a user holds at once, so this list must not overlap what
      // break-glass-editor grants (role/user/token/auth_connector/lock) or that role becomes useless.
      deny: { rules: [{ resources: CLUSTER_CONFIG_KINDS, verbs: ["*"] }] },
    },
  };
}

/** Humans who may approve. Community: needs the access_request update rule (tctl / broker API). */
export function renderApproverRole(edition: Edition, sessionMfa = true): RenderedRole {
  const allow: RoleConditions = {
    rules: [
      { resources: ["access_request"], verbs: ["list", "read", "update"] },
      { resources: ["access_plugin_data"], verbs: ["update"] },
      { resources: ["user"], verbs: READ },
      { resources: ["role"], verbs: READ },
    ],
  };
  if (edition === "enterprise") allow.review_requests = { roles: CATALOG.map((r) => r.name) };
  return {
    name: FIXED_ROLES.approver,
    description: "May approve or deny access requests",
    spec: { options: { max_session_ttl: "1h", ...(sessionMfa ? { require_session_mfa: "yes" as const } : {}), lock: "strict" }, allow },
  };
}

/** The CI/test harness bot role — rendered separately so it is only deployed where enabled (kind). */
export function renderHarnessRole(): RenderedRole {
  return {
    name: BOTS.harness.role,
    description: "CI/test harness: seed test users (reset tokens), drive test requests, impersonate alice/bob",
    spec: {
      allow: {
        ...botInventoryLabels(),
        rules: [
          { resources: ["access_request"], verbs: ["list", "read", "create", "update", "delete"] },
          { resources: ["user"], verbs: ["list", "read", "update"] },
          { resources: ["role"], verbs: READ },
          ...botInventoryRules(),
        ],
        impersonate: { users: ["alice", "bob"], roles: [FIXED_ROLES.requester, FIXED_ROLES.approver] },
      },
      deny: { app_labels: { env: ["prod"] } },
    },
  };
}

function botInventoryRules() {
  return RESOURCE_KINDS.map((k) => ({ resources: [k], verbs: READ }));
}

// Teleport filters resource listings by label-based access, not by rules. Wildcard selectors let
// the bots *see* every node/db/kube cluster; with no logins, db_users or kubernetes_groups they
// cannot connect to SSH, databases or Kubernetes. HTTP app access needs only labels, so apps are
// limited to the low-risk envs and prod apps are denied outright.
function botInventoryLabels(): Pick<RoleConditions, "node_labels" | "db_labels" | "kubernetes_labels" | "app_labels"> {
  const wildcard = { "*": ["*"] };
  return { node_labels: wildcard, db_labels: wildcard, kubernetes_labels: wildcard, app_labels: { env: [...LOW_RISK_ENVS] } };
}

export function renderBotRoles(edition: Edition, opts: { harness?: boolean } = {}): RenderedRole[] {
  const seeAll = botInventoryLabels();
  const denyProdApps: RoleConditions = { app_labels: { env: ["prod"] } };
  const mcp: RenderedRole = {
    name: BOTS.mcp.role,
    description: "MCP server: read users/roles/inventory, create pending access requests on behalf of users",
    spec: {
      allow: {
        ...seeAll,
        rules: [
          { resources: ["user"], verbs: READ },
          { resources: ["role"], verbs: READ },
          { resources: ["access_request"], verbs: ["list", "read", "create"] },
          { resources: ["cluster_auth_preference"], verbs: READ },
          ...botInventoryRules(),
          ...(edition === "enterprise" ? [{ resources: ["access_monitoring_rule"], verbs: READ }] : []),
        ],
      },
      deny: denyProdApps,
    },
  };
  const broker: RenderedRole = {
    name: BOTS.broker.role,
    description: "Access broker: watch access requests and approve/deny them per policy",
    spec: {
      allow: {
        ...seeAll,
        rules: [
          { resources: ["access_request"], verbs: ["list", "read", "update"] },
          { resources: ["access_plugin_data"], verbs: ["update"] },
          { resources: ["user"], verbs: READ },
          { resources: ["role"], verbs: READ },
          ...botInventoryRules(),
        ],
      },
      deny: denyProdApps,
    },
  };
  const agent: RenderedRole = {
    name: BOTS.agent.role,
    description: "Chat agent: read-only user lookup for identity mapping",
    spec: { allow: { rules: [{ resources: ["user"], verbs: READ }] } },
  };
  return [mcp, broker, agent, ...(opts.harness ? [renderHarnessRole()] : [])];
}

/** Every role Pulumi manages. The harness role is only included when explicitly enabled. */
export function renderAllRoles(edition: Edition, opts: RenderOptions = {}): RenderedRole[] {
  const mfa = opts.sessionMfa ?? true;
  return [...CATALOG.map((r) => renderCatalogRole(r, edition, mfa)), renderRequesterRole(edition, mfa), renderApproverRole(edition, mfa), ...renderBotRoles(edition, opts)];
}

/** Role names a human may be assigned directly (stack `users[].roles`, GitHub `teamsToRoles[].roles`). */
export function assignableRoleNames(): string[] {
  const bots = new Set<string>(Object.values(BOTS).map((b) => b.role));
  const managed = renderAllRoles("community", { harness: true }).map((r) => r.name).filter((n) => !bots.has(n));
  return [...managed, "editor", "auditor", "access"];
}

/** Broker policy (services/teleport-access reads this). Rendered from the same catalog. */
export function renderBrokerPolicy(): string {
  const low = CATALOG.filter((r) => r.tier === "low");
  const high = CATALOG.filter((r) => r.tier === "high");
  const q = (s: string) => JSON.stringify(s);
  const list = (xs: string[]) => `[${xs.map(q).join(", ")}]`;
  const minTtl = (rs: CatalogRole[]) => rs.map((r) => r.maxSessionTtl).sort((a, b) => toHours(a) - toHours(b))[0] ?? "2h";
  return [
    "# Generated by infra/teleport/src/policy/render.ts from the role catalog. Do not edit by hand.",
    "apiVersion: access.k8s-teleport/v1",
    "kind: ApprovalPolicy",
    "# Only these roles may be granted through the broker; anything else is denied before the rules run.",
    `allowed_roles: ${list(CATALOG.map((r) => r.name))}`,
    "defaults:",
    "  action: require_approval",
    "  max_ttl: 8h",
    `  approvers: { teleport_roles: [${q(FIXED_ROLES.approver)}], emails: [] }`,
    "  notify: { channels: [{ adapter: slack, target: \"#access-requests\" }] }",
    "rules:",
    "  - name: never-via-broker",
    `    match: { roles: ${list(NEVER_AUTO_ROLES)} }`,
    "    action: deny",
    "    reason: \"administrative roles are never granted through the access broker\"",
    "  - name: auto-approve-low-risk",
    `    match: { roles: ${list(low.map((r) => r.name))}, requested_ttl_max: ${minTtl(low)} }`,
    "    action: auto_approve",
    `    ttl_cap: ${minTtl(low)}`,
    "    reason: \"auto-approved: low-risk environment\"",
    "  - name: high-risk-needs-approval",
    `    match: { roles: ${list(high.map((r) => r.name))} }`,
    "    action: require_approval",
    `    approvers: { teleport_roles: [${q(FIXED_ROLES.approver)}], emails: [] }`,
    `    ttl_cap: ${minTtl(high)}`,
    "    notify: { channels: [{ adapter: slack, target: \"#access-requests\" }], mention_approvers: true }",
    "",
  ].join("\n");
}

function toHours(d: string): number {
  const m = /^(\d+)([hm])$/.exec(d);
  if (!m) return 99;
  return m[2] === "h" ? Number(m[1]) : Number(m[1]) / 60;
}
