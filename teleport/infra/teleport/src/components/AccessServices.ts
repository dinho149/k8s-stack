/**
 * AccessServices — deploys the MCP server, the access broker and (optionally) the chat agent into
 * namespace teleport-access. Each Go service gets its own Machine ID bot: a tbot sidecar joins with
 * the kubernetes method (token scoped to the pod's ServiceAccount) and writes a renewing identity
 * file into a shared emptyDir that the service reads with NewDynamicIdentityFileCreds.
 *
 * Secrets never reach the chat agent as environment values: they are mounted as 0400 files and the
 * agent is pointed at them with `<NAME>_FILE` variables (see renderAgentEnv / CHAT_SECRET_LAYOUT).
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type { EnvProfile } from "../config/profile";
import { k8sLabels, namespaceLabels } from "../lib/labels";
import {
  hardenedContainerSecurityContext,
  hardenedPodSecurityContext,
  IN_CLUSTER_CREDENTIALS_PATH,
  namespaceGuardrails,
  NONROOT_UID,
  projectedInClusterCredentialsVolume,
  projectedJoinTokenVolume,
  resources,
  scratchVolumes,
} from "../lib/security";
import { ACCESS_NAMESPACE, BOTS, type BotKey } from "../policy/catalog";
import type { AccessPolicy } from "./AccessPolicy";
import type { TeleportCluster } from "./TeleportCluster";
import { imageRef } from "./DummyResources";
import { AGENT_PORT, AGENT_PUBLIC_PORT, BROKER_PORT, MCP_PORT } from "./NetworkPolicies";

export interface AccessServicesArgs {
  profile: EnvProfile;
  cluster: TeleportCluster;
  access: AccessPolicy;
  /** dependencies that must exist before pods start (e.g. LocalDns on kind) */
  dependsOn?: pulumi.Resource[];
}

const IDENTITY_DIR = "/var/run/teleport/identity";
const TBOT_IMAGE = "public.ecr.aws/gravitational/tbot-distroless";
/** the shared service secrets (tokens, signing key), mounted as files for the agent */
export const SERVICES_SECRET_NAME = "access-services";
export const SERVICES_SECRET_DIR = "/var/run/secrets/access-services";
export const CHAT_SECRET_DIR = "/var/run/secrets/chat";
const AGENT_STATE_DIR = "/var/lib/access-agent";
const AGENT_HOME = "/home/app";

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
    // Short-lived identities, renewed often: a leaked identity file is useful for at most 2h. Access
    // requests created through the MCP server are bounded by this too (max_duration on the roles).
    "renewal_interval: 30m",
    "certificate_ttl: 2h",
    ...(p.teleport.insecure ? ["insecure: true"] : []),
    "",
  ].join("\n");
}

/** Pure: agent auth environment for a profile (unit-tested). */
export function renderAgentAuthEnv(p: EnvProfile): k8s.types.input.core.v1.EnvVar[] {
  return [
    { name: "CLAUDE_AUTH_MODE", value: p.services.agent.auth },
    { name: "CLAUDE_STATE_DIR", value: `${AGENT_STATE_DIR}/claude` },
    { name: "CLAUDE_ALLOW_LOCAL_LOGIN", value: "false" },
  ];
}

/** env var name -> key in the `teleport:chat` secret object, grouped by the Secret that carries it. */
export const CHAT_SECRET_LAYOUT = {
  llm: { ANTHROPIC_API_KEY: "anthropicApiKey", CLAUDE_CODE_OAUTH_TOKEN: "claudeCodeOauthToken" },
  slack: { SLACK_BOT_TOKEN: "slackBotToken", SLACK_APP_TOKEN: "slackAppToken" }, // socket mode only: no signing secret
  teams: { TEAMS_APP_ID: "teamsAppId", TEAMS_APP_PASSWORD: "teamsAppPassword", TEAMS_TENANT_ID: "teamsTenantId" },
  gchat: { GCHAT_PROJECT_NUMBER: "gchatProjectNumber", GCHAT_SERVICE_ACCOUNT_JSON: "gchatServiceAccountJson" },
} as const;
export type ChatSecretGroup = keyof typeof CHAT_SECRET_LAYOUT;

export interface ChatSecretMount {
  group: ChatSecretGroup;
  secretName: string;
  mountPath: string;
  /** env var name (= file name inside the mount) -> key in teleport:chat */
  keys: Record<string, string>;
}

/** Pure: which chat Secrets exist for a profile — one for the LLM credential, one per enabled adapter. */
export function renderChatSecretMounts(p: EnvProfile): ChatSecretMount[] {
  // In api-key mode never hand the CLI a subscription token, and vice versa (credential precedence).
  const llmKeys: Record<string, string> = p.services.agent.auth === "api-key" ? { ANTHROPIC_API_KEY: CHAT_SECRET_LAYOUT.llm.ANTHROPIC_API_KEY } : { CLAUDE_CODE_OAUTH_TOKEN: CHAT_SECRET_LAYOUT.llm.CLAUDE_CODE_OAUTH_TOKEN };
  const groups: Array<[ChatSecretGroup, Record<string, string>]> = [["llm", llmKeys]];
  for (const adapter of p.services.agent.adapters) {
    if (adapter === "cli") continue;
    groups.push([adapter, { ...CHAT_SECRET_LAYOUT[adapter] }]);
  }
  return groups.map(([group, keys]) => ({ group, secretName: `access-agent-${group}`, mountPath: `${CHAT_SECRET_DIR}/${group}`, keys }));
}

/** Pure: the chat agent's environment. `presentChatKeys` are the keys actually set in teleport:chat. */
export function renderAgentEnv(p: EnvProfile, presentChatKeys: string[]): k8s.types.input.core.v1.EnvVar[] {
  const env: k8s.types.input.core.v1.EnvVar[] = [
    ...renderAgentAuthEnv(p),
    { name: "HOME", value: AGENT_HOME },
    { name: "MCP_URL", value: `http://${BOTS.mcp.name}.${ACCESS_NAMESPACE}.svc.cluster.local:${MCP_PORT}/mcp` },
    { name: "BROKER_URL", value: `http://${BOTS.broker.name}.${ACCESS_NAMESPACE}.svc.cluster.local:${BROKER_PORT}` },
    { name: "ADAPTERS", value: p.services.agent.adapters.filter((a) => a !== "cli").join(",") },
    // internal listener (broker events, health) and the public chat-webhook listener are separate ports
    { name: "PORT", value: String(AGENT_PORT) },
    { name: "PUBLIC_PORT", value: String(AGENT_PUBLIC_PORT) },
    { name: "SESSION_FILE", value: `${AGENT_STATE_DIR}/sessions.json` },
    // Identity is never derived from email text: chat users map to Teleport users by trait lookup.
    { name: "IDENTITY_STRATEGY", value: "trait-lookup" },
    { name: "ALLOWED_EMAIL_DOMAINS", value: p.services.agent.allowedEmailDomains.join(",") },
    { name: "SLACK_ALLOWED_TEAM_IDS", value: p.services.agent.slackAllowedTeamIds.join(",") },
    { name: "MCP_SHARED_TOKEN_FILE", value: `${SERVICES_SECRET_DIR}/TA_MCP_SHARED_TOKEN` },
    { name: "BROKER_API_TOKEN_FILE", value: `${SERVICES_SECRET_DIR}/TA_BROKER_API_TOKEN` },
    { name: "BROKER_WEBHOOK_SECRET_FILE", value: `${SERVICES_SECRET_DIR}/TA_BROKER_WEBHOOK_SECRET` },
    { name: "IDENTITY_SIGNING_KEY_FILE", value: `${SERVICES_SECRET_DIR}/TA_IDENTITY_SIGNING_KEY` },
  ];
  for (const m of renderChatSecretMounts(p)) {
    for (const [envName, chatKey] of Object.entries(m.keys)) {
      if (!presentChatKeys.includes(chatKey)) continue; // the agent fails closed on a missing _FILE, so only point at files that exist
      env.push({ name: `${envName}_FILE`, value: `${m.mountPath}/${envName}` });
    }
  }
  return env;
}

export class AccessServices extends pulumi.ComponentResource {
  public readonly namespace: k8s.core.v1.Namespace;
  public readonly mcpSharedToken: pulumi.Output<string>;
  public readonly brokerApiToken: pulumi.Output<string>;
  public readonly webhookSecret: pulumi.Output<string>;
  /** HMAC key for the per-turn identity assertions between agent, MCP server and broker. */
  public readonly identitySigningKey: pulumi.Output<string>;
  public readonly harnessIdentitySecret = "ci-harness-identity";

  constructor(name: string, args: AccessServicesArgs, opts?: pulumi.ComponentResourceOptions) {
    super("k8s-teleport:access:AccessServices", name, {}, opts);
    const p = args.profile;
    const deps = [args.cluster.chart, ...(args.dependsOn ?? [])];
    const child = (extra: pulumi.Resource[] = []): pulumi.CustomResourceOptions => ({ parent: this, dependsOn: [...deps, ...extra] });

    this.namespace = new k8s.core.v1.Namespace(`${name}-ns`, { metadata: { name: ACCESS_NAMESPACE, labels: namespaceLabels(p, "teleport-access", "restricted") } }, { parent: this });
    const ns = this.namespace.metadata.name;
    namespaceGuardrails(name, { namespace: ns, quota: { pods: 12, cpu: "2", memory: "4Gi", cpuLimit: "8", memoryLimit: "8Gi" } }, child([this.namespace]));

    // shared secrets between the services (generated once, stored in state)
    const gen = (n: string, length = 40) => new random.RandomPassword(`${name}-${n}`, { length, special: false }, { parent: this }).result;
    this.mcpSharedToken = gen("mcp-token");
    this.brokerApiToken = gen("broker-token");
    this.webhookSecret = gen("webhook-secret");
    this.identitySigningKey = gen("identity-signing-key", 48);
    const secrets = new k8s.core.v1.Secret(
      `${name}-secrets`,
      {
        metadata: { name: SERVICES_SECRET_NAME, namespace: ns },
        immutable: true,
        stringData: { TA_MCP_SHARED_TOKEN: this.mcpSharedToken, TA_BROKER_API_TOKEN: this.brokerApiToken, TA_BROKER_WEBHOOK_SECRET: this.webhookSecret, TA_IDENTITY_SIGNING_KEY: this.identitySigningKey },
      },
      { ...child([this.namespace]), replaceOnChanges: ["stringData"], deleteBeforeReplace: true },
    );
    const policyCm = new k8s.core.v1.ConfigMap(`${name}-policy`, { metadata: { name: "broker-policy", namespace: ns }, data: { "policy.yaml": args.access.brokerPolicyYaml } }, child([this.namespace]));

    const tbotContainer = (extraEnv: k8s.types.input.core.v1.EnvVar[] = [], extraMounts: k8s.types.input.core.v1.VolumeMount[] = []): k8s.types.input.core.v1.Container => ({
      name: "tbot",
      image: `${TBOT_IMAGE}:${p.teleport.version}`,
      args: ["start", "-c", "/etc/tbot/tbot.yaml"],
      env: [{ name: "TELEPORT_ANONYMOUS_TELEMETRY", value: "0" }, { name: "KUBERNETES_TOKEN_PATH", value: "/var/run/secrets/tokens/join-sa-token" }, ...extraEnv],
      volumeMounts: [
        { name: "tbot-config", mountPath: "/etc/tbot", readOnly: true },
        { name: "join-sa-token", mountPath: "/var/run/secrets/tokens", readOnly: true },
        ...extraMounts,
      ],
      securityContext: hardenedContainerSecurityContext(),
      resources: resources({ cpu: "10m", memory: "32Mi" }, { cpu: "200m", memory: "128Mi" }),
    });

    const deployBot = (key: BotKey, spec: { image: string; args: string[]; port: number; env: k8s.types.input.core.v1.EnvVar[]; extraVolumes?: k8s.types.input.core.v1.Volume[]; extraMounts?: k8s.types.input.core.v1.VolumeMount[]; replicas?: number; probePath?: string }) => {
      const bot = BOTS[key];
      const labels = k8sLabels(p, bot.name, "access-service");
      const sa = new k8s.core.v1.ServiceAccount(`${name}-${bot.name}-sa`, { metadata: { name: bot.serviceAccount, namespace: ns, labels }, automountServiceAccountToken: false }, child([this.namespace]));
      const tbotCm = new k8s.core.v1.ConfigMap(`${name}-${bot.name}-tbot`, { metadata: { name: `${bot.name}-tbot`, namespace: ns, labels }, data: { "tbot.yaml": renderTbotConfig(p, bot.name, bot.name) } }, child([this.namespace]));
      const scratch = scratchVolumes(bot.name, ["/var/lib/teleport-access"]);
      const volumes: k8s.types.input.core.v1.Volume[] = [
        { name: "identity", emptyDir: { medium: "Memory" } },
        { name: "tbot-config", configMap: { name: tbotCm.metadata.name } },
        projectedJoinTokenVolume(),
        ...scratch.volumes,
        ...(spec.extraVolumes ?? []),
      ];
      const containers: k8s.types.input.core.v1.Container[] = [
        tbotContainer([], [{ name: "identity", mountPath: IDENTITY_DIR }]),
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
          ports: [{ name: "http", containerPort: spec.port }],
          volumeMounts: [{ name: "identity", mountPath: IDENTITY_DIR, readOnly: true }, ...scratch.mounts, ...(spec.extraMounts ?? [])],
          readinessProbe: { httpGet: { path: spec.probePath ?? "/readyz", port: spec.port }, initialDelaySeconds: 10, periodSeconds: 10, failureThreshold: 12 },
          livenessProbe: { httpGet: { path: "/healthz", port: spec.port }, initialDelaySeconds: 20, periodSeconds: 20 },
          securityContext: hardenedContainerSecurityContext(),
          resources: resources({ cpu: "20m", memory: "64Mi" }, { cpu: "1", memory: "512Mi" }),
        },
      ];
      const dep = new k8s.apps.v1.Deployment(
        `${name}-${bot.name}`,
        {
          metadata: { name: bot.name, namespace: ns, labels },
          spec: {
            replicas: spec.replicas ?? 1,
            selector: { matchLabels: { app: bot.name } },
            strategy: { type: "Recreate" },
            template: {
              metadata: { labels },
              spec: { serviceAccountName: sa.metadata.name, automountServiceAccountToken: false, containers, volumes, securityContext: hardenedPodSecurityContext(NONROOT_UID) },
            },
          },
        },
        child([sa, tbotCm, secrets, policyCm, args.access.bots[bot.name], args.access.tokens[bot.name]]),
      );
      new k8s.core.v1.Service(`${name}-${bot.name}-svc`, { metadata: { name: bot.name, namespace: ns, labels }, spec: { type: "ClusterIP", selector: { app: bot.name }, ports: [{ name: "http", port: spec.port, targetPort: spec.port }] } }, child([this.namespace]));
      return dep;
    };

    const goImage = imageRef(p, "teleport-access");
    const secretEnv = (key: string): k8s.types.input.core.v1.EnvVar => ({ name: key, valueFrom: { secretKeyRef: { name: secrets.metadata.name, key } } });

    if (p.services.mcp.enabled) {
      deployBot("mcp", {
        image: goImage,
        args: ["mcp", "--http", `:${MCP_PORT}`],
        port: MCP_PORT,
        env: [secretEnv("TA_MCP_SHARED_TOKEN"), secretEnv("TA_IDENTITY_SIGNING_KEY"), { name: "TA_MCP_POLICY_FILE", value: "/etc/teleport-access/policy.yaml" }],
        extraVolumes: [{ name: "policy", configMap: { name: policyCm.metadata.name } }],
        extraMounts: [{ name: "policy", mountPath: "/etc/teleport-access", readOnly: true }],
      });
    }

    const brokerEnabled = p.services.broker.enabled && (p.edition === "community" || p.services.broker.force);
    if (brokerEnabled) {
      deployBot("broker", {
        image: goImage,
        args: ["broker"],
        port: BROKER_PORT,
        env: [
          secretEnv("TA_BROKER_API_TOKEN"),
          secretEnv("TA_BROKER_WEBHOOK_SECRET"),
          secretEnv("TA_IDENTITY_SIGNING_KEY"),
          { name: "TA_BROKER_POLICY_FILE", value: "/etc/teleport-access/policy.yaml" },
          { name: "TA_BROKER_STATE_FILE", value: "/var/lib/teleport-access/broker-state.json" },
          { name: "TA_BROKER_AGENT_WEBHOOK_URL", value: p.services.agent.enabled ? `http://${BOTS.agent.name}.${ACCESS_NAMESPACE}.svc.cluster.local:${AGENT_PORT}/v1/broker/events` : "" },
          { name: "TA_BROKER_APPROVALS", value: p.edition === "enterprise" ? "review" : "setstate" },
        ],
        extraVolumes: [{ name: "policy", configMap: { name: policyCm.metadata.name } }],
        extraMounts: [{ name: "policy", mountPath: "/etc/teleport-access", readOnly: true }],
      });
    }

    // CI/test harness identity (kind only): a tbot Deployment that writes its identity into a Secret we
    // can read with kubectl (make harness-identity). The Secret is pre-created here so the tbot's Role
    // never needs an unscoped `create` on secrets.
    if (p.services.harness.enabled) {
      const bot = BOTS.harness;
      const labels = k8sLabels(p, bot.name, "test-harness");
      const sa = new k8s.core.v1.ServiceAccount(`${name}-${bot.name}-sa`, { metadata: { name: bot.serviceAccount, namespace: ns, labels }, automountServiceAccountToken: false }, child([this.namespace]));
      const identitySecret = new k8s.core.v1.Secret(
        `${name}-${bot.name}-identity`,
        { metadata: { name: this.harnessIdentitySecret, namespace: ns, labels }, data: {} },
        // tbot owns the contents from here on; Pulumi must not revert them on the next `up`.
        { ...child([this.namespace]), ignoreChanges: ["data", "stringData"] },
      );
      const role = new k8s.rbac.v1.Role(
        `${name}-${bot.name}-role`,
        { metadata: { name: `${bot.name}-secret-writer`, namespace: ns }, rules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["get", "update", "patch"], resourceNames: [this.harnessIdentitySecret] }] },
        child([this.namespace]),
      );
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
              "renewal_interval: 30m",
              "certificate_ttl: 2h",
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
                automountServiceAccountToken: false,
                securityContext: hardenedPodSecurityContext(NONROOT_UID),
                containers: [
                  tbotContainer(
                    [{ name: "POD_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } }],
                    // in-cluster credentials for the kubernetes_secret destination, short-lived instead of auto-mounted
                    [{ name: "kube-api-credentials", mountPath: IN_CLUSTER_CREDENTIALS_PATH, readOnly: true }],
                  ),
                ],
                volumes: [{ name: "tbot-config", configMap: { name: cm.metadata.name } }, projectedJoinTokenVolume(), projectedInClusterCredentialsVolume()],
              },
            },
          },
        },
        child([sa, cm, identitySecret, args.access.bots[bot.name], args.access.tokens[bot.name]]),
      );
    }

    // Chat agent (TypeScript) — optional; needs chat credentials in teleport:chat plus either
    // anthropicApiKey (auth: api-key) or claudeCodeOauthToken from `make claude-token` (auth: subscription).
    if (p.services.agent.enabled) {
      const bot = BOTS.agent;
      const labels = k8sLabels(p, bot.name, "access-service");
      const chat = p.secrets.chat ?? pulumi.output({} as Record<string, string>);
      const sa = new k8s.core.v1.ServiceAccount(`${name}-${bot.name}-sa`, { metadata: { name: bot.serviceAccount, namespace: ns, labels }, automountServiceAccountToken: false }, child([this.namespace]));

      // One Secret per credential group, holding only the keys that group needs, mounted as 0400 files.
      const mounts = renderChatSecretMounts(p);
      const chatSecrets = mounts.map(
        (m) =>
          new k8s.core.v1.Secret(
            `${name}-chat-${m.group}`,
            {
              metadata: { name: m.secretName, namespace: ns, labels },
              immutable: true,
              stringData: chat.apply((c) => Object.fromEntries(Object.entries(m.keys).flatMap(([envName, key]) => (c[key] ? [[envName, c[key]]] : [])))),
            },
            { ...child([this.namespace]), replaceOnChanges: ["stringData"], deleteBeforeReplace: true },
          ),
      );
      const env = chat.apply((c) => renderAgentEnv(p, Object.keys(c).filter((k) => Boolean(c[k]))));
      const scratch = scratchVolumes(bot.name, ["/tmp", AGENT_HOME, AGENT_STATE_DIR], "256Mi");
      const stateVolume: k8s.types.input.core.v1.Volume = p.services.agent.persistSessions
        ? { name: "claude-state", persistentVolumeClaim: { claimName: new k8s.core.v1.PersistentVolumeClaim(`${name}-${bot.name}-state`, { metadata: { name: `${bot.name}-claude-state`, namespace: ns, labels }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Gi" } } } }, child([this.namespace])).metadata.name } }
        : { name: "claude-state", emptyDir: { sizeLimit: "1Gi" } };
      new k8s.apps.v1.Deployment(
        `${name}-${bot.name}`,
        {
          metadata: { name: bot.name, namespace: ns, labels },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: bot.name } },
            strategy: { type: "Recreate" },
            template: {
              metadata: { labels },
              spec: {
                serviceAccountName: sa.metadata.name,
                automountServiceAccountToken: false,
                securityContext: hardenedPodSecurityContext(NONROOT_UID),
                containers: [
                  {
                    name: bot.name,
                    image: imageRef(p, "access-agent"),
                    imagePullPolicy: p.images.pullPolicy,
                    env,
                    ports: [
                      { name: "http", containerPort: AGENT_PORT },
                      { name: "public", containerPort: AGENT_PUBLIC_PORT },
                    ],
                    readinessProbe: { httpGet: { path: "/healthz", port: AGENT_PORT }, initialDelaySeconds: 5, periodSeconds: 10 },
                    volumeMounts: [
                      ...scratch.mounts,
                      { name: "claude-state", mountPath: `${AGENT_STATE_DIR}/claude` },
                      { name: "access-services", mountPath: SERVICES_SECRET_DIR, readOnly: true },
                      ...mounts.map((m) => ({ name: `chat-${m.group}`, mountPath: m.mountPath, readOnly: true })),
                    ],
                    securityContext: hardenedContainerSecurityContext(),
                    resources: resources({ cpu: "50m", memory: "256Mi" }, { cpu: "2", memory: "1Gi" }),
                  },
                ],
                volumes: [
                  ...scratch.volumes,
                  stateVolume,
                  { name: "access-services", secret: { secretName: secrets.metadata.name, defaultMode: 0o400 } },
                  ...mounts.map((m, i) => ({ name: `chat-${m.group}`, secret: { secretName: chatSecrets[i].metadata.name, defaultMode: 0o400 } })),
                ],
              },
            },
          },
        },
        child([sa, ...chatSecrets, secrets]),
      );
      new k8s.core.v1.Service(
        `${name}-${bot.name}-svc`,
        {
          metadata: { name: bot.name, namespace: ns, labels },
          spec: {
            type: "ClusterIP",
            selector: { app: bot.name },
            ports: [
              { name: "http", port: AGENT_PORT, targetPort: AGENT_PORT },
              { name: "public", port: AGENT_PUBLIC_PORT, targetPort: AGENT_PUBLIC_PORT },
            ],
          },
        },
        child([this.namespace]),
      );
    }

    this.registerOutputs({});
  }
}
