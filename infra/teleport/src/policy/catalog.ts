/**
 * catalog.ts — the single source of truth for the zero-standing-privilege model.
 *
 * Every human holds only `requester`. The roles below are requestable; their risk tier decides
 * whether the access broker approves automatically (low) or asks an approver (high).
 * Both the Teleport roles (CRs) and the broker's policy.yaml are rendered from this file, so
 * the two can never drift apart.
 */
export type RiskTier = "low" | "high";

export interface CatalogRule {
  resources: string[];
  verbs: string[];
}

export interface CatalogRole {
  name: string;
  description: string;
  tier: RiskTier;
  /** Values of the `env` label this role grants access to (may be empty for rule-only roles). */
  envs: string[];
  scope: {
    nodes?: { logins: string[] };
    dbs?: { users: string[]; names: string[] };
    /** `resources` is mandatory: there is no wildcard fallback in the renderer. */
    kube?: { groups: string[]; resources: Array<{ kind: string; namespace?: string; name?: string; verbs?: string[] }> };
    apps?: boolean;
    /** Teleport RBAC rules (admin-style roles such as break-glass-editor). */
    rules?: CatalogRule[];
  };
  /** Max elevated session length; also the cap the broker enforces. */
  maxSessionTtl: string;
}

export const LOW_RISK_ENVS = ["local", "dev"];
export const HIGH_RISK_ENVS = ["prod"];
export const ALL_ENVS = [...LOW_RISK_ENVS, ...HIGH_RISK_ENVS];

/** Kubernetes groups the catalog hands out. KubeRbac.ts binds them to (Cluster)Roles. */
export const KUBE_GROUPS = {
  clusterAdmin: "k8s-teleport:cluster-admin",
  prodViewer: "k8s-teleport:prod-viewer",
  dev: "k8s-teleport:dev",
} as const;

const ALL_KUBE_RESOURCES = [{ kind: "*", namespace: "*", name: "*", verbs: ["*"] }];
const READ_KUBE_RESOURCES = [{ kind: "*", namespace: "*", name: "*", verbs: ["get", "list", "watch"] }];

export const CATALOG: CatalogRole[] = [
  { name: "dev-ssh", description: "SSH as 'dev' on local/dev servers", tier: "low", envs: LOW_RISK_ENVS, scope: { nodes: { logins: ["dev"] } }, maxSessionTtl: "4h" },
  { name: "dev-db", description: "Connect to local/dev databases as app user", tier: "low", envs: LOW_RISK_ENVS, scope: { dbs: { users: ["postgres", "app"], names: ["*"] } }, maxSessionTtl: "4h" },
  { name: "dev-k8s", description: "Edit access in the dev Kubernetes cluster (dummies namespace)", tier: "low", envs: LOW_RISK_ENVS, scope: { kube: { groups: [KUBE_GROUPS.dev], resources: [{ kind: "*", namespace: "teleport-dummies", name: "*", verbs: ["*"] }] } }, maxSessionTtl: "4h" },
  { name: "dev-app", description: "Open local/dev web applications", tier: "low", envs: LOW_RISK_ENVS, scope: { apps: true }, maxSessionTtl: "4h" },
  { name: "prod-ssh", description: "SSH as 'dev' on production servers", tier: "high", envs: HIGH_RISK_ENVS, scope: { nodes: { logins: ["dev"] } }, maxSessionTtl: "2h" },
  { name: "prod-db", description: "Read-only style access to production databases", tier: "high", envs: HIGH_RISK_ENVS, scope: { dbs: { users: ["readonly", "app"], names: ["*"] } }, maxSessionTtl: "2h" },
  { name: "prod-k8s", description: "View access in production Kubernetes", tier: "high", envs: HIGH_RISK_ENVS, scope: { kube: { groups: [KUBE_GROUPS.prodViewer], resources: READ_KUBE_RESOURCES } }, maxSessionTtl: "2h" },
  { name: "prod-app", description: "Open production web applications (incl. the cloud console)", tier: "high", envs: HIGH_RISK_ENVS, scope: { apps: true }, maxSessionTtl: "2h" },
  { name: "dev-dba", description: "Database administrator on local/dev databases", tier: "high", envs: LOW_RISK_ENVS, scope: { dbs: { users: ["postgres", "app"], names: ["*"] } }, maxSessionTtl: "2h" },
  { name: "prod-dba", description: "Database administrator on production databases", tier: "high", envs: HIGH_RISK_ENVS, scope: { dbs: { users: ["postgres", "readonly"], names: ["*"] } }, maxSessionTtl: "2h" },
  { name: "k8s-admin", description: "Cluster-admin on every Kubernetes cluster", tier: "high", envs: ALL_ENVS, scope: { kube: { groups: [KUBE_GROUPS.clusterAdmin], resources: ALL_KUBE_RESOURCES } }, maxSessionTtl: "1h" },
  {
    name: "break-glass-editor",
    description: "Time-boxed, approved administration of roles, users, tokens, auth connectors and locks (replaces a standing editor)",
    tier: "high",
    envs: [],
    scope: { rules: [{ resources: ["role", "user", "token", "auth_connector", "lock"], verbs: ["list", "read", "create", "update", "delete"] }] },
    maxSessionTtl: "1h",
  },
];

/** Roles nobody may obtain through the broker, even if requestable by mistake. */
export const NEVER_AUTO_ROLES = ["editor", "auditor", "access", "approver", "^admin-.*$"];

/** Names of the fixed (non-catalog) roles this project manages.
 *  Service roles use the `svc-` prefix: Teleport reserves `bot-<name>` for the internal role it creates per Bot. */
export const FIXED_ROLES = {
  requester: "requester",
  approver: "approver",
  botMcp: "svc-teleport-mcp",
  botBroker: "svc-access-broker",
  botAgent: "svc-access-agent",
  botPortal: "svc-access-portal",
  botHarness: "svc-ci-harness",
} as const;

export const BOTS = {
  mcp: { name: "teleport-mcp", role: FIXED_ROLES.botMcp, serviceAccount: "teleport-mcp" },
  broker: { name: "access-broker", role: FIXED_ROLES.botBroker, serviceAccount: "access-broker" },
  agent: { name: "access-agent", role: FIXED_ROLES.botAgent, serviceAccount: "access-agent" },
  /** access portal API: the backend of the Dogfood portal's Access pages (reads + request creation; approvals go via the broker) */
  portal: { name: "access-portal", role: FIXED_ROLES.botPortal, serviceAccount: "access-portal" },
  harness: { name: "ci-harness", role: FIXED_ROLES.botHarness, serviceAccount: "ci-harness" },
} as const;
export type BotKey = keyof typeof BOTS;

/** Longest certificate a bot may hold (tbot renews well within it). */
// google.protobuf.Duration JSON form: the operator rejects Go-style "2h".
export const BOT_MAX_SESSION_TTL = "7200s";

export const ACCESS_NAMESPACE = "teleport-access";
export const AGENT_NAMESPACE = "teleport-agent";
export const DUMMIES_NAMESPACE = "teleport-dummies";

export const TOKENS = {
  kubeAgent: { name: "kube-agent", roles: ["Kube", "App", "Db"], serviceAccount: `${AGENT_NAMESPACE}:teleport-kube-agent` },
} as const;

/** Join token for the dummy SSH nodes of one env: token `ssh-node-<env>`, bound to SA `teleport-dummies:ssh-node-<env>`. */
export function sshNodeToken(env: string): { name: string; roles: string[]; serviceAccount: string } {
  return { name: `ssh-node-${env}`, roles: ["Node"], serviceAccount: `${DUMMIES_NAMESPACE}:ssh-node-${env}` };
}
