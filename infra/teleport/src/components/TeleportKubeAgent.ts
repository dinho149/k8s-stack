/**
 * TeleportKubeAgent — enrols the Kubernetes cluster and hosts the app + db services that pick up
 * TeleportAppV3 / TeleportDatabaseV3 CRs dynamically. One chart release per environment present in
 * the stack: each release only serves the resources of *its* env (`appResources`/`databaseResources`
 * label matchers on `env`), so a compromised dev-facing agent never proxies production traffic.
 *
 * All releases share the `teleport-kube-agent` ServiceAccount because the kubernetes join token
 * (TOKENS.kubeAgent) is bound to that one account. The chart offers no `automountServiceAccountToken`
 * value, and the Kubernetes service needs the account's API token anyway (it impersonates users
 * against the API server), so the token stays mounted for these pods.
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { EnvProfile } from "../config/profile";
import { installChart } from "../lib/helm";
import { namespaceLabels, teleportLabels } from "../lib/labels";
import { hardenedContainerSecurityContext, namespaceGuardrails } from "../lib/security";
import { AGENT_NAMESPACE, TOKENS } from "../policy/catalog";
import type { TeleportCluster } from "./TeleportCluster";

export interface TeleportKubeAgentArgs {
  profile: EnvProfile;
  cluster: TeleportCluster;
  /** the kube-agent join token CR */
  token: pulumi.Resource;
}

export const KUBE_AGENT_SERVICE_ACCOUNT = "teleport-kube-agent";
/** The chart's own hardened container context (uid 9807, read-only root fs) — restated so it cannot regress. */
const KUBE_AGENT_UID = 9807;

/** Environments that get their own kube-agent release: the stack's env plus every dummy SSH env. */
export function kubeAgentEnvs(p: EnvProfile): string[] {
  const envs = [p.env, ...(p.dummies.enabled ? Object.keys(p.dummies.sshNodes) : [])];
  return [...new Set(envs)];
}

export function kubeAgentReleaseName(p: EnvProfile, env: string): string {
  return env === p.env ? "teleport-kube-agent" : `teleport-kube-agent-${env}`;
}

export function renderKubeAgentValues(p: EnvProfile, env = p.env): Record<string, unknown> {
  const primary = env === p.env;
  return {
    roles: "kube,app,db",
    proxyAddr: p.teleport.inClusterProxyAddr,
    insecureSkipProxyTLSVerify: p.teleport.insecure,
    joinParams: { method: "kubernetes", tokenName: TOKENS.kubeAgent.name },
    // The chart defaults every release to the same Secret name; one per release avoids collisions in the namespace.
    joinTokenSecret: { name: `${kubeAgentReleaseName(p, env)}-join-token` },
    // Makes the chart mount a short-lived projected token (audience = cluster name) for the join.
    teleportClusterName: p.clusterName,
    kubeClusterName: `${env}-${p.platform}`,
    labels: teleportLabels(p, "platform", "platform", { cluster: p.platform }, env),
    appResources: [{ labels: { env: [env] } }],
    databaseResources: [{ labels: { env: [env] } }],
    highAvailability: { replicaCount: 1 },
    updater: { enabled: false },
    // The join token allows exactly one ServiceAccount; the primary release creates it, the others reuse it.
    serviceAccount: { create: primary, name: KUBE_AGENT_SERVICE_ACCOUNT },
    podSecurityContext: { runAsNonRoot: true, runAsUser: KUBE_AGENT_UID, runAsGroup: KUBE_AGENT_UID, fsGroup: KUBE_AGENT_UID, seccompProfile: { type: "RuntimeDefault" } },
    securityContext: { ...hardenedContainerSecurityContext(), runAsUser: KUBE_AGENT_UID },
    initSecurityContext: { ...hardenedContainerSecurityContext(), runAsUser: KUBE_AGENT_UID },
    resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { cpu: "1", memory: "512Mi" } },
    log: { level: "INFO", format: "json" },
    extraLabels: { deployment: { stack: p.stack, env }, pod: { stack: p.stack, env, "app.kubernetes.io/part-of": "kube-agents" } },
  };
}

export class TeleportKubeAgent extends pulumi.ComponentResource {
  public readonly namespace: k8s.core.v1.Namespace;
  /** chart releases keyed by env */
  public readonly charts: Record<string, k8s.helm.v4.Chart> = {};
  /** the primary (stack env) release, kept for callers that need a single dependency */
  public readonly chart: k8s.helm.v4.Chart;

  constructor(name: string, args: TeleportKubeAgentArgs, opts?: pulumi.ComponentResourceOptions) {
    super("k8s-teleport:agent:TeleportKubeAgent", name, {}, opts);
    const p = args.profile;
    // `baseline`: the chart's pods already satisfy `restricted` (see values above); flip the label once verified.
    this.namespace = new k8s.core.v1.Namespace(`${name}-ns`, { metadata: { name: AGENT_NAMESPACE, labels: namespaceLabels(p, "teleport-kube-agent", "baseline") } }, { parent: this });
    const guardrails = namespaceGuardrails(name, { namespace: this.namespace.metadata.name, quota: { pods: 10, cpu: "2", memory: "4Gi", cpuLimit: "6", memoryLimit: "6Gi" } }, { parent: this, dependsOn: [this.namespace] });

    const envs = kubeAgentEnvs(p);
    const primaryEnv = p.env;
    this.chart = installChart(
      `${name}-chart`,
      { chart: "teleport-kube-agent", version: p.teleport.version, namespace: this.namespace.metadata.name, releaseName: kubeAgentReleaseName(p, primaryEnv), values: renderKubeAgentValues(p, primaryEnv) },
      { parent: this, dependsOn: [this.namespace, ...guardrails, args.cluster.chart, args.token] },
    );
    this.charts[primaryEnv] = this.chart;
    for (const env of envs) {
      if (env === primaryEnv) continue;
      this.charts[env] = installChart(
        `${name}-chart-${env}`,
        { chart: "teleport-kube-agent", version: p.teleport.version, namespace: this.namespace.metadata.name, releaseName: kubeAgentReleaseName(p, env), values: renderKubeAgentValues(p, env) },
        // the primary release owns the shared ServiceAccount
        { parent: this, dependsOn: [this.chart] },
      );
    }
    this.registerOutputs({});
  }
}
