/**
 * EnterpriseAccess — only with `teleport:edition: enterprise`. Replaces the custom broker with
 * Teleport's native machinery: Access Monitoring Rules (automatic review of low-risk roles,
 * notifications for high-risk ones) and the official Slack / Microsoft Teams access-request plugins
 * (each joining as a Machine ID bot through the official tbot chart writing a Kubernetes Secret).
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { EnvProfile } from "../config/profile";
import { TeleportAccessMonitoringRuleV1, TeleportBotV1, TeleportProvisionToken, TeleportRoleV7 } from "../crds";
import { installChart } from "../lib/helm";
import { k8sLabels } from "../lib/labels";
import { ACCESS_NAMESPACE, CATALOG, FIXED_ROLES } from "../policy/catalog";
import type { TeleportCluster } from "./TeleportCluster";

export interface EnterpriseAccessArgs {
  profile: EnvProfile;
  cluster: TeleportCluster;
  slackChannel?: string;
  teamsRecipients?: string[];
}

/** Pure: the Access Monitoring Rules rendered from the catalog tiers. */
export function renderAccessMonitoringRules(slackChannel = "#access-requests"): Array<{ name: string; spec: Record<string, unknown> }> {
  const low = CATALOG.filter((r) => r.tier === "low").map((r) => `"${r.name}"`).join(", ");
  const high = CATALOG.filter((r) => r.tier === "high").map((r) => `"${r.name}"`).join(", ");
  return [
    {
      name: "auto-approve-low-risk",
      spec: {
        subjects: ["access_request"],
        condition: `access_request.spec.roles.contains_any(set(${low})) && !access_request.spec.roles.contains_any(set(${high}))`,
        automatic_review: { integration: "builtin", decision: "APPROVED" },
        desired_state: "reviewed",
      },
    },
    {
      name: "notify-high-risk",
      spec: {
        subjects: ["access_request"],
        condition: `access_request.spec.roles.contains_any(set(${high}))`,
        notification: { name: "slack", recipients: [slackChannel] },
      },
    },
  ];
}

export class EnterpriseAccess extends pulumi.ComponentResource {
  constructor(name: string, args: EnterpriseAccessArgs, opts?: pulumi.ComponentResourceOptions) {
    super("k8s-teleport:access:EnterpriseAccess", name, {}, opts);
    const p = args.profile;
    const ns = args.cluster.namespace.metadata.name;
    const child = (deps: pulumi.Resource[] = []): pulumi.CustomResourceOptions => ({ parent: this, dependsOn: [args.cluster.chart, ...deps] });
    const labels = { env: p.env, stack: p.stack, "managed-by": "pulumi" };

    for (const rule of renderAccessMonitoringRules(args.slackChannel)) {
      new TeleportAccessMonitoringRuleV1(`${name}-amr-${rule.name}`, { name: rule.name, namespace: ns, labels, spec: rule.spec }, child());
    }

    // Official access-request plugins, each with its own bot (role: access-plugin preset).
    const plugins: Array<{ key: "slack" | "msteams"; enabled: boolean; values: Record<string, unknown>; secretKeys: string[] }> = [
      {
        key: "slack",
        enabled: p.services.agent.adapters.includes("slack"),
        values: { slack: { token: "" }, roleToRecipients: { "*": [args.slackChannel ?? "#access-requests"], [FIXED_ROLES.approver]: [args.slackChannel ?? "#access-requests"] } },
        secretKeys: ["slackBotToken"],
      },
      {
        key: "msteams",
        enabled: p.services.agent.adapters.includes("teams"),
        values: { msteams: { appID: "", tenantID: "", teamsAppID: "" }, roleToRecipients: { "*": args.teamsRecipients ?? [] } },
        secretKeys: ["teamsAppId", "teamsAppPassword", "teamsTenantId"],
      },
    ];
    for (const pl of plugins) {
      if (!pl.enabled) continue;
      const botName = `plugin-${pl.key}`;
      const role = new TeleportRoleV7(`${name}-${botName}-role`, { name: `svc-${botName}`, namespace: ns, labels, spec: { allow: { rules: [{ resources: ["access_request"], verbs: ["list", "read"] }, { resources: ["access_plugin_data"], verbs: ["update"] }, { resources: ["user"], verbs: ["list", "read"] }, { resources: ["role"], verbs: ["list", "read"] }], review_requests: { roles: CATALOG.map((r) => r.name), preview_as_roles: CATALOG.map((r) => r.name) } } } }, child());
      const bot = new TeleportBotV1(`${name}-${botName}-bot`, { name: botName, namespace: ns, labels, spec: { roles: [`svc-${botName}`], traits: [] } }, child([role]));
      const token = new TeleportProvisionToken(`${name}-${botName}-token`, { name: botName, namespace: ns, labels, spec: { roles: ["Bot"], bot_name: botName, join_method: "kubernetes", kubernetes: { type: "in_cluster", allow: [{ service_account: `${ACCESS_NAMESPACE}:tbot-${botName}` }] } } }, child([bot]));
      const tbot = installChart(
        `${name}-${botName}-tbot`,
        {
          chart: "tbot",
          version: p.teleport.version,
          namespace: ACCESS_NAMESPACE,
          releaseName: `tbot-${botName}`,
          values: {
            clusterName: p.clusterName,
            teleportAuthAddress: p.teleport.inClusterAuthAddr,
            token: botName,
            joinMethod: "kubernetes",
            defaultOutput: { enabled: true }, // writes Secret tbot-<botName>-out
            serviceAccount: { create: true, name: `tbot-${botName}` },
          },
        },
        { parent: this, dependsOn: [token] },
      );
      installChart(
        `${name}-${botName}-chart`,
        {
          chart: `teleport-plugin-${pl.key}`,
          version: p.teleport.version,
          namespace: ACCESS_NAMESPACE,
          releaseName: `teleport-plugin-${pl.key}`,
          values: {
            teleport: { address: p.teleport.inClusterAuthAddr, identitySecretName: `tbot-${botName}-out`, identitySecretPath: "identity" },
            ...pl.values,
            secretVolumeName: "chat-secrets",
            log: { output: "stderr", severity: "INFO" },
          },
        },
        { parent: this, dependsOn: [tbot] },
      );
    }
    void k8sLabels;
    void k8s;
    this.registerOutputs({});
  }
}
