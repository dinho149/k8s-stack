/**
 * Stack configuration schema (everything under the `teleport:` namespace).
 *
 * Non-secret settings are read as plain values; secrets are read separately as Pulumi
 * secret outputs (see profile.ts) so that a single object never mixes both.
 */
import { z } from "zod";
import { assignableRoleNames } from "../policy/render";

/** Role names a human may hold directly: every managed non-bot role plus the Teleport presets we allow. */
const ASSIGNABLE_ROLES = new Set(assignableRoleNames());
const RoleNameSchema = z.string().min(1).refine((r) => ASSIGNABLE_ROLES.has(r), { error: (iss) => `unknown role ${JSON.stringify(iss.input)} (allowed: ${[...ASSIGNABLE_ROLES].join(", ")})` });

export const PLATFORMS = ["kind", "eks", "gke", "aks", "generic"] as const;
export const EDITIONS = ["community", "enterprise"] as const;

export const ExposureSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("nodeport"), nodePort: z.number().int().min(30000).max(32767).default(30080) }),
  z.object({
    type: z.literal("loadbalancer"),
    annotations: z.record(z.string(), z.string()).default({}),
    loadBalancerIP: z.string().optional(),
    /** CIDRs allowed to reach the proxy (rendered as spec.loadBalancerSourceRanges). Required off kind. */
    sourceRanges: z.array(z.string().regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, "must be an IPv4 CIDR")).default([]),
    /** true => cloud-internal load balancer scheme (default). false => internet-facing (needs sourceRanges). */
    internal: z.boolean().default(true),
    /** whether the load balancer sends the PROXY protocol header; rendered as the chart's proxyProtocol value */
    proxyProtocol: z.boolean().default(false),
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
  // kind only: PEM files written by deploy/teleport/scripts/local-tls.sh (mkcert) are mounted as a kubernetes.io/tls
  // Secret (tls.crt, tls.key, ca.crt). Paths are relative to infra/teleport (the Pulumi project directory).
  // The proxy verifies its own certificate chain at startup, so the issuing root (caFile) is added to its
  // trust store next to the system roots. When any file is missing the chart falls back to self-signed.
  z.object({
    mode: z.literal("local-files"),
    certFile: z.string().min(1).default("../../.dogfood/teleport/tls/teleport.crt"),
    keyFile: z.string().min(1).default("../../.dogfood/teleport/tls/teleport.key"),
    caFile: z.string().min(1).default("../../.dogfood/teleport/tls/ca.crt"),
  }),
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
    /** also write audit events to the auth pods' stdout so the cluster log pipeline (SIEM) gets a copy */
    auditLogMirrorOnStdout: z.boolean().default(true),
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
  /** kind keeps otp for headless test users; off kind the profile invariants require webauthn only */
  secondFactors: z.array(z.enum(["otp", "webauthn", "sso"])).min(1).default(["otp"]),
  /** local password logins; must be false off kind (profile invariants) */
  localAuth: z.boolean().default(true),
  webauthnRpId: z.string().optional(),
});

export const GithubSchema = z.object({
  clientId: z.string().min(1),
  organization: z.string().min(1),
  display: z.string().default("GitHub"),
  teamsToRoles: z.array(z.object({ team: z.string().min(1), roles: z.array(RoleNameSchema).min(1) })).min(1),
});

export const ImagesSchema = z.object({
  registry: z.string().default(""), // "" => local images named k8s-teleport/<svc>
  tag: z.string().default("dev"),
  pullPolicy: z.enum(["IfNotPresent", "Always", "Never"]).default("IfNotPresent"),
  /** service name -> sha256 digest ("sha256:..."). When set, images are referenced by digest, never by tag. Required off kind. */
  digests: z.record(z.string(), z.string().regex(/^sha256:[a-f0-9]{64}$/, "must be sha256:<64 hex>")).default({}),
  /** Cloud stacks: install a Kyverno ClusterPolicy that admits only cosign-signed images from `registry` and rejects `:latest`/tagless images. Requires Kyverno. */
  verifySignatures: z.boolean().default(false),
  /** Regexp for the cosign keyless certificate subject (GitHub OIDC). Derived from a ghcr.io registry when unset: `https://github.com/<org>/<repo>/.github/workflows/release-images.yml@refs/.*`. */
  signerSubjectRegexp: z.string().min(1).optional(),
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
      /** email domains allowed to talk to the agent (ALLOWED_EMAIL_DOMAINS). Required when the agent is enabled off kind. */
      allowedEmailDomains: z.array(z.string().min(3)).default([]),
      /** Slack workspace ids allowed to talk to the agent (SLACK_ALLOWED_TEAM_IDS). Required when the slack adapter is on. */
      slackAllowedTeamIds: z.array(z.string().min(1)).default([]),
    })
    .default({ enabled: false, adapters: ["cli"], auth: "api-key", persistSessions: false, allowedEmailDomains: [], slackAllowedTeamIds: [] }),
  /** CI/test harness bot (impersonates alice/bob). Only ever enabled on kind. */
  harness: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
});

export const UserSchema = z.object({
  name: z.string().min(1),
  roles: z.array(RoleNameSchema).min(1),
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
  chat: "chat", // object: slackBotToken, slackAppToken, teamsAppId, teamsAppPassword, teamsTenantId, gchatServiceAccountJson, gchatProjectNumber, anthropicApiKey, claudeCodeOauthToken
} as const;
