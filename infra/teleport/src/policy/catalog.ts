/**
 * catalog.ts — the single source of truth for the zero-standing-privilege model.
 *
 * Every human holds only `requester`. The roles below are requestable; their risk tier decides
 * whether the access broker approves automatically (low) or asks an approver (high).
 * Both the Teleport roles (CRs) and the broker's policy.yaml are rendered from this file, so
 * the two can never drift apart.
 */
export type RiskTier = "low" | "high";

export interface CatalogRole {
  name: string;
  description: string;
  tier: RiskTier;
  /** Values of the `env` label this role grants access to. */
  envs: string[];
  scope: {
    nodes?: { logins: string[] };
    dbs?: { users: string[]; names: string[] };
    kube?: { groups: string[]; resources?: Array<{ kind: string; namespace?: string; name?: string; verbs?: string[] }> };
    apps?: boolean;
  };
  /** Max elevated session length; also the cap the broker enforces. */
  maxSessionTtl: string;
}

export const LOW_RISK_ENVS = ["local", "dev"];
export const HIGH_RISK_ENVS = ["prod"];

export const CATALOG: CatalogRole[] = [
  { name: "dev-ssh", description: "SSH as 'dev' on local/dev servers", tier: "low", envs: LOW_RISK_ENVS, scope: { nodes: { logins: ["dev"] } }, maxSessionTtl: "4h" },
  { name: "dev-db", description: "Connect to local/dev databases as app user", tier: "low", envs: LOW_RISK_ENVS, scope: { dbs: { users: ["postgres", "app"], names: ["*"] } }, maxSessionTtl: "4h" },
  { name: "dev-k8s", description: "Edit access in the dev Kubernetes cluster (dummies namespace)", tier: "low", envs: LOW_RISK_ENVS, scope: { kube: { groups: ["k8s-teleport:dev"], resources: [{ kind: "*", namespace: "teleport-dummies", name: "*", verbs: ["*"] }] } }, maxSessionTtl: "4h" },
  { name: "dev-app", description: "Open local/dev web applications", tier: "low", envs: LOW_RISK_ENVS, scope: { apps: true }, maxSessionTtl: "4h" },
  { name: "prod-ssh", description: "SSH as 'dev' on production servers", tier: "high", envs: HIGH_RISK_ENVS, scope: { nodes: { logins: ["dev"] } }, maxSessionTtl: "2h" },
  { name: "prod-db", description: "Read-only style access to production databases", tier: "high", envs: HIGH_RISK_ENVS, scope: { dbs: { users: ["readonly", "app"], names: ["*"] } }, maxSessionTtl: "2h" },
  { name: "prod-k8s", description: "View access in production Kubernetes", tier: "high", envs: HIGH_RISK_ENVS, scope: { kube: { groups: ["k8s-teleport:prod-viewer"], resources: [{ kind: "*", namespace: "*", name: "*", verbs: ["get", "list", "watch"] }] } }, maxSessionTtl: "2h" },
  { name: "prod-app", description: "Open production web applications (incl. the cloud console)", tier: "high", envs: HIGH_RISK_ENVS, scope: { apps: true }, maxSessionTtl: "2h" },
  { name: "dba", description: "Database administrator on every database", tier: "high", envs: [...LOW_RISK_ENVS, ...HIGH_RISK_ENVS], scope: { dbs: { users: ["postgres", "root", "*"], names: ["*"] } }, maxSessionTtl: "2h" },
  { name: "k8s-admin", description: "Cluster-admin on every Kubernetes cluster", tier: "high", envs: [...LOW_RISK_ENVS, ...HIGH_RISK_ENVS], scope: { kube: { groups: ["system:masters"], resources: [{ kind: "*", namespace: "*", name: "*", verbs: ["*"] }] } }, maxSessionTtl: "1h" },
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
  botHarness: "svc-ci-harness",
} as const;

export const BOTS = {
  mcp: { name: "teleport-mcp", role: FIXED_ROLES.botMcp, serviceAccount: "teleport-mcp" },
  broker: { name: "access-broker", role: FIXED_ROLES.botBroker, serviceAccount: "access-broker" },
  agent: { name: "access-agent", role: FIXED_ROLES.botAgent, serviceAccount: "access-agent" },
  harness: { name: "ci-harness", role: FIXED_ROLES.botHarness, serviceAccount: "ci-harness" },
} as const;
export type BotKey = keyof typeof BOTS;

export const ACCESS_NAMESPACE = "teleport-access";
export const AGENT_NAMESPACE = "teleport-agent";
export const DUMMIES_NAMESPACE = "teleport-dummies";

export const TOKENS = {
  kubeAgent: { name: "kube-agent", roles: ["Kube", "App", "Db", "Discovery"], serviceAccount: `${AGENT_NAMESPACE}:teleport-kube-agent` },
  sshNode: { name: "ssh-node", roles: ["Node"], serviceAccount: `${DUMMIES_NAMESPACE}:ssh-node` },
} as const;
