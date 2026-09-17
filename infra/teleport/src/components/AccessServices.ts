/**
 * AccessServices — deploys the MCP server, the access broker and (optionally) the chat agent into
 * namespace teleport-access. Each Go service gets its own Machine ID bot: a tbot sidecar joins with
 * the kubernetes method (token scoped to the pod's ServiceAccount) and writes a renewing identity
 * file into a shared emptyDir that the service reads with NewDynamicIdentityFileCreds.
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type { EnvProfile } from "../config/profile";
import { k8sLabels } from "../lib/labels";
import { ACCESS_NAMESPACE, BOTS, type BotKey } from "../policy/catalog";
import type { AccessPolicy } from "./AccessPolicy";
import type { TeleportCluster } from "./TeleportCluster";
import { imageRef } from "./DummyResources";

export interface AccessServicesArgs {
  profile: EnvProfile;
  cluster: TeleportCluster;
  access: AccessPolicy;
  /** dependencies that must exist before pods start (e.g. LocalDns on kind) */
  dependsOn?: pulumi.Resource[];
}

const IDENTITY_DIR = "/var/run/teleport/identity";
const TBOT_IMAGE = "public.ecr.aws/gravitational/tbot-distroless";

/** tbot.yaml for a sidecar joining as `bot` and renewing an identity file. */
export function renderTbotConfig(p: EnvProfile, botName: string, tokenName: string): string {
  return [
    "version: v2",
    `auth_server: ${p.teleport.inClusterAuthAddr}`,
    "onboarding:",
    "  join_method: kubernetes",
    `  token: ${tokenName}`,
    "storage:",
    "  type: memory",
    "outputs:",
    "  - type: identity",
    "    destination:",
    "      type: directory",
    `      path: ${IDENTITY_DIR}`,
    // Access requests created on behalf of users cannot outlive the creator's certificate, so the
    // bots hold long certificates (the Bot's max_session_ttl caps this at 12h).
    "renewal_interval: 1h",
    "certificate_ttl: 12h",
    ...(p.teleport.insecure ? ["insecure: true"] : []),
    "",
  ].join("\n");
}

/** Pure: agent auth environment for a profile (unit-tested). */
export function renderAgentAuthEnv(p: EnvProfile): k8s.types.input.core.v1.EnvVar[] {
  return [
    { name: "CLAUDE_AUTH_MODE", value: p.services.agent.auth },
    { name: "CLAUDE_STATE_DIR", value: "/var/lib/access-agent/claude" },
    { name: "CLAUDE_ALLOW_LOCAL_LOGIN", value: "false" },
  ];
}

export class AccessServices extends pulumi.ComponentResource {
  public readonly namespace: k8s.core.v1.Namespace;
  public readonly mcpSharedToken: pulumi.Output<string>;
  public readonly brokerApiToken: pulumi.Output<string>;
  public readonly webhookSecret: pulumi.Output<string>;
  public readonly harnessIdentitySecret = "ci-harness-identity";

  constructor(name: string, args: AccessServicesArgs, opts?: pulumi.ComponentResourceOptions) {
    super("k8s-teleport:access:AccessServices", name, {}, opts);
    const p = args.profile;
    const deps = [args.cluster.chart, ...(args.dependsOn ?? [])];
    const child = (extra: pulumi.Resource[] = []): pulumi.CustomResourceOptions => ({ parent: this, dependsOn: [...deps, ...extra] });

    this.namespace = new k8s.core.v1.Namespace(`${name}-ns`, { metadata: { name: ACCESS_NAMESPACE, labels: k8sLabels(p, "teleport-access") } }, { parent: this });
    const ns = this.namespace.metadata.name;

    // shared secrets between the services (generated once, stored in state)
    const gen = (n: string) => new random.RandomPassword(`${name}-${n}`, { length: 40, special: false }, { parent: this }).result;
    this.mcpSharedToken = gen("mcp-token");
    this.brokerApiToken = gen("broker-token");
    this.webhookSecret = gen("webhook-secret");
    const secrets = new k8s.core.v1.Secret(
      `${name}-secrets`,
      { metadata: { name: "access-services", namespace: ns }, stringData: { TA_MCP_SHARED_TOKEN: this.mcpSharedToken, TA_BROKER_API_TOKEN: this.brokerApiToken, TA_BROKER_WEBHOOK_SECRET: this.webhookSecret } },
      child([this.namespace]),
    );
    const policyCm = new k8s.core.v1.ConfigMap(`${name}-policy`, { metadata: { name: "broker-policy", namespace: ns }, data: { "policy.yaml": args.access.brokerPolicyYaml } }, child([this.namespace]));

    const deployBot = (key: BotKey, spec: { image: string; args: string[]; port?: number; env: k8s.types.input.core.v1.EnvVar[]; extraVolumes?: k8s.types.input.core.v1.Volume[]; extraMounts?: k8s.types.input.core.v1.VolumeMount[]; replicas?: number; probePath?: string; identitySecretName?: string }) => {
      const bot = BOTS[key];
      const labels = k8sLabels(p, bot.name, "access-service");
      const sa = new k8s.core.v1.ServiceAccount(`${name}-${bot.name}-sa`, { metadata: { name: bot.serviceAccount, namespace: ns, labels } }, child([this.namespace]));
      const tbotCm = new k8s.core.v1.ConfigMap(`${name}-${bot.name}-tbot`, { metadata: { name: `${bot.name}-tbot`, namespace: ns, labels }, data: { "tbot.yaml": renderTbotConfig(p, bot.name, bot.name) } }, child([this.namespace]));
      const volumes: k8s.types.input.core.v1.Volume[] = [
        { name: "identity", emptyDir: { medium: "Memory" } },
        { name: "tbot-config", configMap: { name: tbotCm.metadata.name } },
        ...(spec.extraVolumes ?? []),
      ];
      const containers: k8s.types.input.core.v1.Container[] = [
        {
          name: "tbot",
          image: `${TBOT_IMAGE}:${p.teleport.version}`,
          args: ["start", "-c", "/etc/tbot/tbot.yaml"],
          env: [{ name: "TELEPORT_ANONYMOUS_TELEMETRY", value: "0" }, { name: "KUBERNETES_TOKEN_PATH", value: "/var/run/secrets/tokens/join-sa-token" }],
          volumeMounts: [
            { name: "identity", mountPath: IDENTITY_DIR },
            { name: "tbot-config", mountPath: "/etc/tbot", readOnly: true },
            { name: "join-sa-token", mountPath: "/var/run/secrets/tokens", readOnly: true },
          ],
          resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "128Mi" } },
        },
        {
          name: bot.name,
          image: spec.image,
          imagePullPolicy: p.images.pullPolicy,
          args: spec.args,
          env: [
            { name: "TA_TELEPORT_ADDR", value: p.teleport.inClusterAuthAddr },
            { name: "TA_TELEPORT_IDENTITY_FILE", value: `${IDENTITY_DIR}/identity` },
            { name: "TA_TELEPORT_INSECURE", value: String(p.teleport.insecure) },
            { name: "TA_TELEPORT_EDITION", value: p.edition },
            { name: "TA_LOG_LEVEL", value: "info" },
            ...spec.env,
          ],
          ports: spec.port ? [{ name: "http", containerPort: spec.port }] : undefined,
          volumeMounts: [{ name: "identity", mountPath: IDENTITY_DIR, readOnly: true }, ...(spec.extraMounts ?? [])],
          readinessProbe: spec.port ? { httpGet: { path: spec.probePath ?? "/readyz", port: spec.port }, initialDelaySeconds: 10, periodSeconds: 10, failureThreshold: 12 } : undefined,
          livenessProbe: spec.port ? { httpGet: { path: "/healthz", port: spec.port }, initialDelaySeconds: 20, periodSeconds: 20 } : undefined,
          resources: { requests: { cpu: "20m", memory: "64Mi" }, limits: { memory: "512Mi" } },
        },
      ];
      volumes.push({ name: "join-sa-token", projected: { sources: [{ serviceAccountToken: { path: "join-sa-token", expirationSeconds: 600 } }] } });
      const dep = new k8s.apps.v1.Deployment(
        `${name}-${bot.name}`,
        {
          metadata: { name: bot.name, namespace: ns, labels },
          spec: {
            replicas: spec.replicas ?? 1,
            selector: { matchLabels: { app: bot.name } },
            strategy: { type: "Recreate" },
            template: { metadata: { labels }, spec: { serviceAccountName: sa.metadata.name, containers, volumes, securityContext: { runAsNonRoot: true, runAsUser: 65532, fsGroup: 65532 } } },
          },
        },
        child([sa, tbotCm, secrets, policyCm, args.access.bots[bot.name], args.access.tokens[bot.name]]),
      );
      if (spec.port) {
        new k8s.core.v1.Service(`${name}-${bot.name}-svc`, { metadata: { name: bot.name, namespace: ns, labels }, spec: { selector: { app: bot.name }, ports: [{ name: "http", port: spec.port, targetPort: spec.port }] } }, child([this.namespace]));
      }
      return dep;
    };

    const goImage = imageRef(p, "teleport-access");
    const secretEnv = (key: string): k8s.types.input.core.v1.EnvVar => ({ name: key, valueFrom: { secretKeyRef: { name: secrets.metadata.name, key } } });

    if (p.services.mcp.enabled) {
      deployBot("mcp", {
        image: goImage,
        args: ["mcp", "--http", ":8080"],
        port: 8080,
        env: [secretEnv("TA_MCP_SHARED_TOKEN"), { name: "TA_MCP_POLICY_FILE", value: "/etc/teleport-access/policy.yaml" }],
        extraVolumes: [{ name: "policy", configMap: { name: policyCm.metadata.name } }],
        extraMounts: [{ name: "policy", mountPath: "/etc/teleport-access", readOnly: true }],
      });
    }

    const brokerEnabled = p.services.broker.enabled && (p.edition === "community" || p.services.broker.force);
    if (brokerEnabled) {
      deployBot("broker", {
        image: goImage,
        args: ["broker"],
        port: 8081,
        env: [
          secretEnv("TA_BROKER_API_TOKEN"),
          secretEnv("TA_BROKER_WEBHOOK_SECRET"),
          { name: "TA_BROKER_POLICY_FILE", value: "/etc/teleport-access/policy.yaml" },
          { name: "TA_BROKER_AGENT_WEBHOOK_URL", value: p.services.agent.enabled ? `http://access-agent.${ACCESS_NAMESPACE}.svc.cluster.local:8082/v1/broker/events` : "" },
          { name: "TA_BROKER_APPROVALS", value: p.edition === "enterprise" ? "review" : "setstate" },
        ],
        extraVolumes: [{ name: "policy", configMap: { name: policyCm.metadata.name } }],
        extraMounts: [{ name: "policy", mountPath: "/etc/teleport-access", readOnly: true }],
      });
    }

    // CI/test harness identity: a tbot Deployment that writes its identity into a Secret we can read
    // with kubectl (make harness-identity). Uses the tbot chart's secret destination semantics by hand.
    {
      const bot = BOTS.harness;
      const labels = k8sLabels(p, bot.name, "test-harness");
      const sa = new k8s.core.v1.ServiceAccount(`${name}-${bot.name}-sa`, { metadata: { name: bot.serviceAccount, namespace: ns, labels } }, child([this.namespace]));
      const role = new k8s.rbac.v1.Role(`${name}-${bot.name}-role`, { metadata: { name: `${bot.name}-secret-writer`, namespace: ns }, rules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["get", "create", "update", "patch"], resourceNames: [this.harnessIdentitySecret] }, { apiGroups: [""], resources: ["secrets"], verbs: ["create"] }] }, child([this.namespace]));
      new k8s.rbac.v1.RoleBinding(`${name}-${bot.name}-rb`, { metadata: { name: `${bot.name}-secret-writer`, namespace: ns }, roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: role.metadata.name }, subjects: [{ kind: "ServiceAccount", name: sa.metadata.name, namespace: ns }] }, child([role, sa]));
      const cm = new k8s.core.v1.ConfigMap(
        `${name}-${bot.name}-tbot`,
        {
          metadata: { name: `${bot.name}-tbot`, namespace: ns, labels },
          data: {
            "tbot.yaml": [
              "version: v2",
              `auth_server: ${p.teleport.inClusterAuthAddr}`,
              "onboarding:",
              "  join_method: kubernetes",
              `  token: ${bot.name}`,
              "storage:",
              "  type: memory",
              "outputs:",
              "  - type: identity",
              "    destination:",
              "      type: kubernetes_secret",
              `      name: ${this.harnessIdentitySecret}`,
              "renewal_interval: 1h",
              "certificate_ttl: 12h",
              ...(p.teleport.insecure ? ["insecure: true"] : []),
              "",
            ].join("\n"),
          },
        },
        child([this.namespace]),
      );
      new k8s.apps.v1.Deployment(
        `${name}-${bot.name}`,
        {
          metadata: { name: `tbot-${bot.name}`, namespace: ns, labels },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: bot.name } },
            template: {
              metadata: { labels },
              spec: {
                serviceAccountName: sa.metadata.name,
                containers: [
                  {
                    name: "tbot",
                    image: `${TBOT_IMAGE}:${p.teleport.version}`,
                    args: ["start", "-c", "/etc/tbot/tbot.yaml"],
                    env: [
                      { name: "TELEPORT_ANONYMOUS_TELEMETRY", value: "0" },
                      { name: "KUBERNETES_TOKEN_PATH", value: "/var/run/secrets/tokens/join-sa-token" },
                      { name: "POD_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
                    ],
                    volumeMounts: [{ name: "tbot-config", mountPath: "/etc/tbot", readOnly: true }, { name: "join-sa-token", mountPath: "/var/run/secrets/tokens", readOnly: true }],
                    resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "128Mi" } },
                  },
                ],
                volumes: [
                  { name: "tbot-config", configMap: { name: cm.metadata.name } },
                  { name: "join-sa-token", projected: { sources: [{ serviceAccountToken: { path: "join-sa-token", expirationSeconds: 600 } }] } },
                ],
              },
            },
          },
        },
        child([sa, cm, args.access.bots[bot.name], args.access.tokens[bot.name]]),
      );
    }

    // Chat agent (TypeScript) — optional; needs chat credentials in teleport:chat plus either
    // anthropicApiKey (auth: api-key) or claudeCodeOauthToken from `make claude-token` (auth: subscription).
    if (p.services.agent.enabled) {
      const bot = BOTS.agent;
      const labels = k8sLabels(p, bot.name, "access-service");
      const chat = p.secrets.chat ?? pulumi.output({} as Record<string, string>);
      const chatSecret = new k8s.core.v1.Secret(`${name}-chat`, { metadata: { name: "access-agent-chat", namespace: ns, labels }, stringData: chat }, child([this.namespace]));
      const env: k8s.types.input.core.v1.EnvVar[] = [
        ...renderAgentAuthEnv(p),
        { name: "MCP_URL", value: `http://teleport-mcp.${ACCESS_NAMESPACE}.svc.cluster.local:8080/mcp` },
        { name: "MCP_SHARED_TOKEN", valueFrom: { secretKeyRef: { name: secrets.metadata.name, key: "TA_MCP_SHARED_TOKEN" } } },
        { name: "BROKER_URL", value: `http://access-broker.${ACCESS_NAMESPACE}.svc.cluster.local:8081` },
        { name: "BROKER_API_TOKEN", valueFrom: { secretKeyRef: { name: secrets.metadata.name, key: "TA_BROKER_API_TOKEN" } } },
        { name: "BROKER_WEBHOOK_SECRET", valueFrom: { secretKeyRef: { name: secrets.metadata.name, key: "TA_BROKER_WEBHOOK_SECRET" } } },
        { name: "ADAPTERS", value: p.services.agent.adapters.filter((a) => a !== "cli").join(",") },
        { name: "PORT", value: "8082" },
        { name: "IDENTITY_STRATEGY", value: p.auth.type === "github" ? "github-login" : "email-local-part" },
      ];
      const secretKeys: Record<string, string> = {
        ANTHROPIC_API_KEY: "anthropicApiKey",
        CLAUDE_CODE_OAUTH_TOKEN: "claudeCodeOauthToken",
        SLACK_BOT_TOKEN: "slackBotToken",
        SLACK_APP_TOKEN: "slackAppToken",
        SLACK_SIGNING_SECRET: "slackSigningSecret",
        TEAMS_APP_ID: "teamsAppId",
        TEAMS_APP_PASSWORD: "teamsAppPassword",
        TEAMS_TENANT_ID: "teamsTenantId",
        GCHAT_PROJECT_NUMBER: "gchatProjectNumber",
        GCHAT_SERVICE_ACCOUNT_JSON: "gchatServiceAccountJson",
      };
      for (const [envName, key] of Object.entries(secretKeys)) {
        // In api-key mode never hand the CLI a subscription token, and vice versa (credential precedence).
        if (p.services.agent.auth === "api-key" && envName === "CLAUDE_CODE_OAUTH_TOKEN") continue;
        if (p.services.agent.auth === "subscription" && envName === "ANTHROPIC_API_KEY") continue;
        env.push({ name: envName, valueFrom: { secretKeyRef: { name: chatSecret.metadata.name, key, optional: true } } });
      }
      const stateVolume: k8s.types.input.core.v1.Volume = p.services.agent.persistSessions
        ? { name: "claude-state", persistentVolumeClaim: { claimName: new k8s.core.v1.PersistentVolumeClaim(`${name}-${bot.name}-state`, { metadata: { name: `${bot.name}-claude-state`, namespace: ns, labels }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } } }, child([this.namespace])).metadata.name } }
        : { name: "claude-state", emptyDir: {} };
      new k8s.apps.v1.Deployment(
        `${name}-${bot.name}`,
        {
          metadata: { name: bot.name, namespace: ns, labels },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: bot.name } },
            template: {
              metadata: { labels },
              spec: {
                containers: [
                  {
                    name: bot.name,
                    image: imageRef(p, "access-agent"),
                    imagePullPolicy: p.images.pullPolicy,
                    env,
                    ports: [{ name: "http", containerPort: 8082 }],
                    readinessProbe: { httpGet: { path: "/healthz", port: 8082 }, initialDelaySeconds: 5, periodSeconds: 10 },
                    volumeMounts: [{ name: "claude-state", mountPath: "/var/lib/access-agent/claude" }],
                    resources: { requests: { cpu: "50m", memory: "256Mi" }, limits: { memory: "1Gi" } },
                  },
                ],
                volumes: [stateVolume],
              },
            },
          },
        },
        child([chatSecret, secrets]),
      );
      new k8s.core.v1.Service(`${name}-${bot.name}-svc`, { metadata: { name: bot.name, namespace: ns, labels }, spec: { selector: { app: bot.name }, ports: [{ name: "http", port: 8082, targetPort: 8082 }] } }, child([this.namespace]));
    }

    this.registerOutputs({});
  }
}
