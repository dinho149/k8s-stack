/**
 * TeleportKubeAgent — enrols the Kubernetes cluster itself and hosts the app + db services that
 * pick up TeleportAppV3 / TeleportDatabaseV3 CRs dynamically (resource matchers on `env`).
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { EnvProfile } from "../config/profile";
import { installChart } from "../lib/helm";
import { k8sLabels, teleportLabels } from "../lib/labels";
import { AGENT_NAMESPACE, TOKENS } from "../policy/catalog";
import type { TeleportCluster } from "./TeleportCluster";

export interface TeleportKubeAgentArgs {
  profile: EnvProfile;
  cluster: TeleportCluster;
  /** the kube-agent join token CR */
  token: pulumi.Resource;
}

export function renderKubeAgentValues(p: EnvProfile): Record<string, unknown> {
  return {
    roles: "kube,app,db",
    proxyAddr: p.teleport.inClusterProxyAddr,
    insecureSkipProxyTLSVerify: p.teleport.insecure,
    joinParams: { method: "kubernetes", tokenName: TOKENS.kubeAgent.name },
    kubeClusterName: `${p.env}-${p.platform}`,
    labels: teleportLabels(p, "platform", "platform", { cluster: p.platform }),
    appResources: [{ labels: { env: "*" } }],
    databaseResources: [{ labels: { env: "*" } }],
    highAvailability: { replicaCount: 1 },
    updater: { enabled: false },
    serviceAccount: { create: true, name: "teleport-kube-agent" },
    log: { level: "INFO", format: "json" },
    extraLabels: { deployment: { stack: p.stack }, pod: { stack: p.stack } },
  };
}

export class TeleportKubeAgent extends pulumi.ComponentResource {
  public readonly namespace: k8s.core.v1.Namespace;
  public readonly chart: k8s.helm.v4.Chart;

  constructor(name: string, args: TeleportKubeAgentArgs, opts?: pulumi.ComponentResourceOptions) {
    super("k8s-teleport:agent:TeleportKubeAgent", name, {}, opts);
    const p = args.profile;
    this.namespace = new k8s.core.v1.Namespace(`${name}-ns`, { metadata: { name: AGENT_NAMESPACE, labels: k8sLabels(p, "teleport-kube-agent") } }, { parent: this });
    this.chart = installChart(
      `${name}-chart`,
      { chart: "teleport-kube-agent", version: p.teleport.version, namespace: this.namespace.metadata.name, releaseName: "teleport-kube-agent", values: renderKubeAgentValues(p) },
      { parent: this, dependsOn: [this.namespace, args.cluster.chart, args.token] },
    );
    this.registerOutputs({});
  }
}
