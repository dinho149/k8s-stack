/**
 * render.ts — pure functions turning the catalog into Teleport role specs and the broker policy.
 * No Pulumi types here so everything is trivially unit-testable.
 */
import type { RoleConditions, RoleSpecV7 } from "../crds";
import type { Edition } from "../config/schema";
import { BOTS, CATALOG, FIXED_ROLES, NEVER_AUTO_ROLES, type CatalogRole } from "./catalog";

export interface RenderedRole {
  name: string;
  description: string;
  spec: RoleSpecV7;
}

const READ = ["list", "read"];
const RESOURCE_KINDS = ["node", "db", "db_server", "app", "app_server", "kube_cluster", "kube_server", "windows_desktop"];

/** A catalog role -> Teleport role v7 spec. Access is scoped purely by the `env` label. */
export function renderCatalogRole(r: CatalogRole): RenderedRole {
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
    allow.kubernetes_resources = r.scope.kube.resources ?? [{ kind: "*", namespace: "*", name: "*", verbs: ["*"] }];
  }
  if (r.scope.apps) allow.app_labels = envSel;
  return {
    name: r.name,
    description: r.description,
    spec: {
      options: { max_session_ttl: r.maxSessionTtl, forward_agent: false, create_host_user_mode: "off" },
      allow,
    },
  };
}

/** Base role for every human: no resource access, may request any catalog role. */
export function renderRequesterRole(edition: Edition): RenderedRole {
  const request: NonNullable<RoleConditions["request"]> = {
    roles: CATALOG.map((r) => r.name),
    max_duration: "8h",
    suggested_reviewers: ["admin"],
  };
  if (edition === "enterprise") {
    // Enterprise-only knobs (verified in Teleport source: checkRoleFeatureSupport).
    request.search_as_roles = CATALOG.map((r) => r.name);
    request.thresholds = [{ name: "one approval", approve: 1, deny: 1 }];
  }
  return {
    name: FIXED_ROLES.requester,
    description: "Base role: no standing access, may request catalog roles",
    spec: { options: { max_session_ttl: "8h" }, allow: { request } },
  };
}

/** Humans who may approve. Community: needs the access_request update rule (tctl / broker API). */
export function renderApproverRole(edition: Edition): RenderedRole {
  const allow: RoleConditions = {
    rules: [
      { resources: ["access_request"], verbs: ["list", "read", "update", "delete"] },
      { resources: ["access_plugin_data"], verbs: ["update"] },
      { resources: ["user"], verbs: READ },
      { resources: ["role"], verbs: READ },
    ],
  };
  if (edition === "enterprise") allow.review_requests = { roles: CATALOG.map((r) => r.name) };
  return { name: FIXED_ROLES.approver, description: "May approve or deny access requests", spec: { allow } };
}

export function renderBotRoles(edition: Edition): RenderedRole[] {
  const inventory = RESOURCE_KINDS.map((k) => ({ resources: [k], verbs: READ }));
  // Teleport filters resource listings by label-based access, not by rules. Wildcard selectors let
  // the bots *see* every node/db/kube cluster/app; with no logins, db_users or kubernetes_groups they
  // cannot connect to SSH, databases or Kubernetes. (HTTP app access needs only labels — the bots'
  // identities never leave their pods and every access is audited.)
  const wildcard = { "*": ["*"] };
  const seeAll: Pick<RoleConditions, "node_labels" | "db_labels" | "kubernetes_labels" | "app_labels"> = { node_labels: wildcard, db_labels: wildcard, kubernetes_labels: wildcard, app_labels: wildcard };
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
          ...inventory,
          ...(edition === "enterprise" ? [{ resources: ["access_monitoring_rule"], verbs: READ }] : []),
        ],
      },
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
          ...inventory,
        ],
      },
    },
  };
  const agent: RenderedRole = {
    name: BOTS.agent.role,
    description: "Chat agent: read-only user lookup for identity mapping",
    spec: { allow: { rules: [{ resources: ["user"], verbs: READ }] } },
  };
  const harness: RenderedRole = {
    name: BOTS.harness.role,
    description: "CI/test harness: manage test users and requests, impersonate test users",
    spec: {
      allow: {
        ...seeAll,
        rules: [
          { resources: ["access_request"], verbs: ["list", "read", "create", "update", "delete"] },
          { resources: ["user"], verbs: ["list", "read", "create", "update", "delete"] },
          { resources: ["role"], verbs: READ },
          { resources: ["token"], verbs: READ },
          { resources: ["auth_connector"], verbs: READ },
          ...inventory,
        ],
        impersonate: { users: ["alice", "bob"], roles: [FIXED_ROLES.requester, FIXED_ROLES.approver, ...CATALOG.map((r) => r.name)] },
      },
    },
  };
  return [mcp, broker, agent, harness];
}

export function renderAllRoles(edition: Edition): RenderedRole[] {
  return [...CATALOG.map(renderCatalogRole), renderRequesterRole(edition), renderApproverRole(edition), ...renderBotRoles(edition)];
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
