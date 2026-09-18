/**
 * NetworkPolicies — default-deny (ingress + egress) in every namespace this project owns, then the
 * minimum set of flows the system needs. The matrix (see docs/architecture.md):
 *
 *   teleport          proxy   <- anyone :3080 (front door)           -> auth:3025, dummies ssh:3022, [443 for ACME]
 *                     auth    <- proxy, operator, 3 namespaces :3025 -> kube API / SSO / cloud backends (443, 6443)
 *                     operator                                       -> auth:3025, kube API
 *   teleport-access   mcp     <- agent :8080                         -> auth, proxy
 *                     broker  <- agent :8081                         -> auth, proxy, agent:8082
 *                     agent   <- broker :8082, [anyone :8083 (chat webhooks, http adapters only)]
 *                                                                    -> mcp, broker, internet:443 (LLM + chat APIs)
 *                     harness                                        -> auth, kube API (writes its identity Secret)
 *   teleport-agent    kube-agent                                     -> proxy:3080, kube API, dummies (db/app ports)
 *   teleport-dummies  ssh     <- proxy :3022                         -> auth:3025
 *                     db      <- kube-agent :5432/:3306              -> proxy:3080 (fetch the Teleport DB CA at start)
 *                     apps    <- kube-agent :80/:8080/:4566
 *   everyone                                                         -> kube-dns :53
 *
 * The Kubernetes API server has no stable pod/namespace selector and its ClusterIP is DNAT'ed before
 * policy evaluation on most CNIs, so pods that need it get egress to TCP 443/6443 on 0.0.0.0/0 —
 * those are also the pods that legitimately need SSO / cloud backends. Nothing else may leave the cluster.
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { EnvProfile } from "../config/profile";
import { ACCESS_NAMESPACE, AGENT_NAMESPACE, BOTS, DUMMIES_NAMESPACE } from "../policy/catalog";
import { AUTH_PORT, PROXY_PORT } from "./TeleportCluster";

type Peer = k8s.types.input.networking.v1.NetworkPolicyPeer;
type Port = k8s.types.input.networking.v1.NetworkPolicyPort;
export interface RenderedPolicy {
  name: string;
  namespace: string;
  spec: k8s.types.input.networking.v1.NetworkPolicySpec;
}

const tcp = (...ports: number[]): Port[] => ports.map((port) => ({ protocol: "TCP", port }));
const ns = (name: string): Peer => ({ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": name } } });
const nsPods = (name: string, labels: Record<string, string>): Peer => ({ ...ns(name), podSelector: { matchLabels: labels } });
const pods = (labels: Record<string, string>): Peer => ({ podSelector: { matchLabels: labels } });

/** Pod selectors, matching the labels the charts and our components emit. */
export const SELECTORS = {
  proxy: { "app.kubernetes.io/component": "proxy" },
  auth: { "app.kubernetes.io/component": "auth" },
  operator: { "app.kubernetes.io/component": "operator" },
  mcp: { app: BOTS.mcp.name },
  broker: { app: BOTS.broker.name },
  agent: { app: BOTS.agent.name },
  harness: { app: BOTS.harness.name },
  kubeAgent: { "app.kubernetes.io/part-of": "kube-agents" },
  sshNodes: { "app.kubernetes.io/part-of": "ssh-nodes" },
  databases: { "app.kubernetes.io/component": "database" },
  apps: { "app.kubernetes.io/component": "app" },
} as const;

/** Ports of the chat agent: internal API (broker events, health) and the public chat webhook listener. */
export const AGENT_PORT = 8082;
export const AGENT_PUBLIC_PORT = 8083;
export const MCP_PORT = 8080;
export const BROKER_PORT = 8081;
export const DUMMY_DB_PORTS = [5432, 3306];
export const DUMMY_APP_PORTS = [80, 8080, 4566];

/** Egress to the Kubernetes API server (and, for the same pods, cloud/SSO endpoints on 443). */
const KUBE_API_EGRESS = { to: [{ ipBlock: { cidr: "0.0.0.0/0" } }], ports: tcp(443, 6443) };
const INTERNET_443_EGRESS = { to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] } }], ports: tcp(443) };
const DNS_EGRESS = { to: [nsPods("kube-system", { "k8s-app": "kube-dns" })], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] };

export function renderNetworkPolicies(p: EnvProfile): RenderedPolicy[] {
  const teleportNs = p.teleport.namespace;
  const toAuth = { to: [nsPods(teleportNs, SELECTORS.auth)], ports: tcp(AUTH_PORT) };
  const toProxy = { to: [nsPods(teleportNs, SELECTORS.proxy)], ports: tcp(PROXY_PORT) };
  const out: RenderedPolicy[] = [];
  const dummies = p.dummies.enabled;
  const httpAdapters = p.services.agent.adapters.some((a) => a === "teams" || a === "gchat");

  const baseline = (namespace: string) => {
    out.push({ name: "default-deny", namespace, spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] } });
    out.push({ name: "allow-dns", namespace, spec: { podSelector: {}, policyTypes: ["Egress"], egress: [DNS_EGRESS] } });
  };

  // ------------------------------------------------------------------ teleport (control plane)
  baseline(teleportNs);
  out.push({
    name: "proxy",
    namespace: teleportNs,
    spec: {
      podSelector: { matchLabels: SELECTORS.proxy },
      policyTypes: ["Ingress", "Egress"],
      // Front door: users, agents (reverse tunnels) and the load balancer / node port all arrive here.
      ingress: [{ ports: tcp(PROXY_PORT) }],
      egress: [
        { to: [pods(SELECTORS.auth)], ports: tcp(AUTH_PORT) },
        // SSH dummies register directly with auth, so the proxy dials them on 3022.
        ...(dummies ? [{ to: [nsPods(DUMMIES_NAMESPACE, SELECTORS.sshNodes)], ports: tcp(3022) }] : []),
        // ACME: the proxy itself talks to Let's Encrypt.
        ...(p.tls.mode === "acme" ? [INTERNET_443_EGRESS] : []),
      ],
    },
  });
  out.push({
    name: "auth",
    namespace: teleportNs,
    spec: {
      podSelector: { matchLabels: SELECTORS.auth },
      policyTypes: ["Ingress", "Egress"],
      ingress: [{ from: [pods(SELECTORS.proxy), pods(SELECTORS.operator), ns(ACCESS_NAMESPACE), ns(AGENT_NAMESPACE), ns(DUMMIES_NAMESPACE)], ports: tcp(AUTH_PORT) }],
      // kube API (TokenReview for kubernetes joins), SSO providers (GitHub/OIDC/SAML), cloud backends.
      egress: [KUBE_API_EGRESS],
    },
  });
  out.push({
    name: "operator",
    namespace: teleportNs,
    spec: { podSelector: { matchLabels: SELECTORS.operator }, policyTypes: ["Ingress", "Egress"], egress: [{ to: [pods(SELECTORS.auth)], ports: tcp(AUTH_PORT) }, KUBE_API_EGRESS] },
  });

  // ------------------------------------------------------------------ teleport-access
  baseline(ACCESS_NAMESPACE);
  out.push({
    name: "mcp",
    namespace: ACCESS_NAMESPACE,
    spec: { podSelector: { matchLabels: SELECTORS.mcp }, policyTypes: ["Ingress", "Egress"], ingress: [{ from: [pods(SELECTORS.agent)], ports: tcp(MCP_PORT) }], egress: [toAuth, toProxy] },
  });
  out.push({
    name: "broker",
    namespace: ACCESS_NAMESPACE,
    spec: {
      podSelector: { matchLabels: SELECTORS.broker },
      policyTypes: ["Ingress", "Egress"],
      ingress: [{ from: [pods(SELECTORS.agent)], ports: tcp(BROKER_PORT) }],
      egress: [toAuth, toProxy, { to: [pods(SELECTORS.agent)], ports: tcp(AGENT_PORT) }],
    },
  });
  out.push({
    name: "agent",
    namespace: ACCESS_NAMESPACE,
    spec: {
      podSelector: { matchLabels: SELECTORS.agent },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        { from: [pods(SELECTORS.broker)], ports: tcp(AGENT_PORT) },
        // Chat platforms deliver webhooks (Teams, Google Chat http mode) through an ingress controller
        // whose namespace we do not know; Slack uses socket mode and needs no ingress at all.
        ...(httpAdapters ? [{ ports: tcp(AGENT_PUBLIC_PORT) }] : []),
      ],
      egress: [
        { to: [pods(SELECTORS.mcp)], ports: tcp(MCP_PORT) },
        { to: [pods(SELECTORS.broker)], ports: tcp(BROKER_PORT) },
        // Anthropic API / Slack / Teams / Google Chat — public endpoints only, never the cluster's private ranges.
        INTERNET_443_EGRESS,
      ],
    },
  });
  if (p.services.harness.enabled) {
    out.push({
      name: "harness",
      namespace: ACCESS_NAMESPACE,
      spec: { podSelector: { matchLabels: SELECTORS.harness }, policyTypes: ["Ingress", "Egress"], egress: [toAuth, KUBE_API_EGRESS] },
    });
  }

  // ------------------------------------------------------------------ teleport-agent
  baseline(AGENT_NAMESPACE);
  out.push({
    name: "kube-agent",
    namespace: AGENT_NAMESPACE,
    spec: {
      podSelector: { matchLabels: SELECTORS.kubeAgent },
      policyTypes: ["Ingress", "Egress"],
      egress: [
        toProxy,
        // kube API for the Kubernetes service; also covers the cloud load balancer address on 443.
        KUBE_API_EGRESS,
        ...(dummies ? [{ to: [ns(DUMMIES_NAMESPACE)], ports: tcp(...DUMMY_DB_PORTS, ...DUMMY_APP_PORTS) }] : []),
      ],
    },
  });

  // ------------------------------------------------------------------ teleport-dummies
  if (dummies) {
    baseline(DUMMIES_NAMESPACE);
    out.push({
      name: "ssh-nodes",
      namespace: DUMMIES_NAMESPACE,
      spec: {
        podSelector: { matchLabels: SELECTORS.sshNodes },
        policyTypes: ["Ingress", "Egress"],
        ingress: [{ from: [nsPods(teleportNs, SELECTORS.proxy)], ports: tcp(3022) }],
        egress: [toAuth],
      },
    });
    out.push({
      name: "databases",
      namespace: DUMMIES_NAMESPACE,
      spec: {
        podSelector: { matchLabels: SELECTORS.databases },
        policyTypes: ["Ingress", "Egress"],
        ingress: [{ from: [nsPods(AGENT_NAMESPACE, SELECTORS.kubeAgent)], ports: tcp(...DUMMY_DB_PORTS) }],
        // init container fetches the Teleport database client CA from the proxy
        egress: [toProxy],
      },
    });
    out.push({
      name: "apps",
      namespace: DUMMIES_NAMESPACE,
      spec: {
        podSelector: { matchLabels: SELECTORS.apps },
        policyTypes: ["Ingress", "Egress"],
        ingress: [{ from: [nsPods(AGENT_NAMESPACE, SELECTORS.kubeAgent)], ports: tcp(...DUMMY_APP_PORTS) }],
      },
    });
  }
  return out;
}

export interface NetworkPoliciesArgs {
  profile: EnvProfile;
  /** namespaces the policies live in; policies are created after them */
  namespaces: pulumi.Resource[];
}

export class NetworkPolicies extends pulumi.ComponentResource {
  public readonly policies: k8s.networking.v1.NetworkPolicy[] = [];

  constructor(name: string, args: NetworkPoliciesArgs, opts?: pulumi.ComponentResourceOptions) {
    super("k8s-teleport:network:NetworkPolicies", name, {}, opts);
    for (const r of renderNetworkPolicies(args.profile)) {
      this.policies.push(
        new k8s.networking.v1.NetworkPolicy(
          `${name}-${r.namespace}-${r.name}`,
          { metadata: { name: r.name, namespace: r.namespace, labels: { "app.kubernetes.io/part-of": "k8s-teleport", "app.kubernetes.io/managed-by": "pulumi" } }, spec: r.spec },
          { parent: this, dependsOn: args.namespaces },
        ),
      );
    }
    this.registerOutputs({});
  }
}
