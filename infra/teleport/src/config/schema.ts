/**
 * Stack configuration schema (everything under the `teleport:` namespace).
 *
 * Non-secret settings are read as plain values; secrets are read separately as Pulumi
 * secret outputs (see profile.ts) so that a single object never mixes both.
 */
import { z } from "zod";

export const PLATFORMS = ["kind", "eks", "gke", "aks", "generic"] as const;
export const EDITIONS = ["community", "enterprise"] as const;

export const ExposureSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("nodeport"), nodePort: z.number().int().min(30000).max(32767).default(30080) }),
  z.object({
    type: z.literal("loadbalancer"),
    annotations: z.record(z.string(), z.string()).default({}),
    loadBalancerIP: z.string().optional(),
  }),
  z.object({
    type: z.literal("ingress"),
    className: z.string(),
    annotations: z.record(z.string(), z.string()).default({}),
  }),
]);

export const TlsSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("self-signed") }),
  z.object({ mode: z.literal("acme"), email: z.string().email() }),
  z.object({
    mode: z.literal("cert-manager"),
    issuerName: z.string(),
    issuerKind: z.enum(["Issuer", "ClusterIssuer"]).default("ClusterIssuer"),
    issuerGroup: z.string().default("cert-manager.io"),
  }),
  z.object({ mode: z.literal("existing-secret"), secretName: z.string() }),
]);

export const ChartModeSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("standalone"),
    storageClass: z.string().optional(),
    volumeSize: z.string().default("5Gi"),
  }),
  z.object({
    mode: z.literal("aws"),
    region: z.string(),
    backendTable: z.string(),
    auditLogTable: z.string(),
    sessionRecordingBucket: z.string(),
    auditLogMirrorOnStdout: z.boolean().default(false),
    serviceAccountRoleArn: z.string().optional(),
  }),
  z.object({
    mode: z.literal("gcp"),
    projectId: z.string(),
    backendTable: z.string(),
    auditLogTable: z.string(),
    sessionRecordingBucket: z.string(),
    credentialSecretName: z.string().optional(),
    workloadIdentityServiceAccount: z.string().optional(),
  }),
  z.object({
    mode: z.literal("azure"),
    databaseHost: z.string(),
    databaseUser: z.string(),
    sessionRecordingStorageAccount: z.string(),
    auditLogStorageAccount: z.string(),
    clientID: z.string(),
  }),
]);

export const AuthSchema = z.object({
  type: z.enum(["local", "github", "oidc", "saml"]).default("github"),
  connectorName: z.string().optional(),
  secondFactors: z.array(z.enum(["otp", "webauthn", "sso"])).min(1).default(["otp"]),
  localAuth: z.boolean().default(true),
  webauthnRpId: z.string().optional(),
});

export const GithubSchema = z.object({
  clientId: z.string().min(1),
  organization: z.string().min(1),
  display: z.string().default("GitHub"),
  teamsToRoles: z.array(z.object({ team: z.string().min(1), roles: z.array(z.string()).min(1) })).min(1),
});

export const ImagesSchema = z.object({
  registry: z.string().default(""), // "" => local images named k8s-teleport/<svc>
  tag: z.string().default("dev"),
  pullPolicy: z.enum(["IfNotPresent", "Always", "Never"]).default("IfNotPresent"),
});

export const DummiesSchema = z.object({
  enabled: z.boolean().default(true),
  sshNodes: z.record(z.string(), z.number().int().min(0).max(5)).default({ dev: 2, prod: 1 }),
  postgres: z.boolean().default(true),
  mysql: z.boolean().default(false),
  httpbin: z.boolean().default(true),
  cloudStandin: z.enum(["none", "static", "localstack"]).default("static"),
});

export const ServicesSchema = z.object({
  mcp: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  broker: z.object({ enabled: z.boolean().default(true), force: z.boolean().default(false) }).default({ enabled: true, force: false }),
  agent: z
    .object({
      enabled: z.boolean().default(false),
      adapters: z.array(z.enum(["cli", "slack", "teams", "gchat"])).default(["cli"]),
      /** api-key: Anthropic API (chat.anthropicApiKey). subscription: headless Claude Code on chat.claudeCodeOauthToken. */
      auth: z.enum(["api-key", "subscription"]).default("api-key"),
      /** keep Claude Code sessions across restarts (PVC) instead of an emptyDir */
      persistSessions: z.boolean().default(false),
    })
    .default({ enabled: false, adapters: ["cli"], auth: "api-key", persistSessions: false }),
});

export const UserSchema = z.object({
  name: z.string().min(1),
  roles: z.array(z.string()).min(1),
  traits: z.record(z.string(), z.array(z.string())).default({}),
});

export const StackConfigSchema = z.object({
  env: z.string().min(1),
  platform: z.enum(PLATFORMS),
  kubeContext: z.string().min(1),
  kubeconfig: z.string().optional(),
  clusterName: z.string().min(1),
  publicAddr: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  edition: z.enum(EDITIONS).default("community"),
  exposure: ExposureSchema,
  tls: TlsSchema,
  auth: AuthSchema,
  github: GithubSchema.optional(),
  chartMode: ChartModeSchema,
  images: ImagesSchema,
  insecureLocal: z.boolean().default(false),
  dummies: DummiesSchema,
  services: ServicesSchema,
  users: z.array(UserSchema).default([]),
});

export type StackConfig = z.infer<typeof StackConfigSchema>;
export type StackConfigInput = z.input<typeof StackConfigSchema>;
export type Platform = (typeof PLATFORMS)[number];
export type Edition = (typeof EDITIONS)[number];
export type Exposure = z.infer<typeof ExposureSchema>;
export type TlsMode = z.infer<typeof TlsSchema>;
export type ChartMode = z.infer<typeof ChartModeSchema>;
export type AuthConfig = z.infer<typeof AuthSchema>;
export type GithubConfig = z.infer<typeof GithubSchema>;
export type ImagesConfig = z.infer<typeof ImagesSchema>;
export type DummiesConfig = z.infer<typeof DummiesSchema>;
export type ServicesConfig = z.infer<typeof ServicesSchema>;
export type LocalUser = z.infer<typeof UserSchema>;

/** Names of secret config keys, read with config.getSecret* — never part of StackConfig. */
export const SECRET_KEYS = {
  githubClientSecret: "githubClientSecret",
  licensePem: "licensePem",
  chat: "chat", // object: slackBotToken, slackAppToken, slackSigningSecret, teamsAppId, teamsAppPassword, teamsTenantId, gchatServiceAccountJson, gchatProjectNumber, anthropicApiKey, claudeCodeOauthToken
} as const;
