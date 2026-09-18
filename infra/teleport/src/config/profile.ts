/**
 * profile.ts — turns raw stack config into a fully-typed EnvProfile.
 *
 * Layering: platform defaults (src/config/platforms) <- stack config (Pulumi.<stack>.yaml)
 * <- schema defaults/validation <- invariants. Everything downstream consumes EnvProfile,
 * never pulumi.Config directly, which keeps components pure and unit-testable.
 */
import * as pulumi from "@pulumi/pulumi";
import { deepMerge, type DeepPartial } from "../lib/merge";
import { platformDefaults } from "./platforms";
import { SECRET_KEYS, StackConfigSchema, type Platform, type StackConfig, type StackConfigInput } from "./schema";

export interface TeleportAddrs {
  namespace: string;
  releaseName: string;
  version: string;
  clusterName: string;
  publicAddr: string;
  /** host part of publicAddr, e.g. teleport.127.0.0.1.nip.io */
  publicHost: string;
  /** proxy address for in-cluster agents: the public address (resolvable in-cluster via LocalDns on kind) */
  inClusterProxyAddr: string;
  /** in-cluster auth address (no proxy TLS involved) */
  inClusterAuthAddr: string;
  /** true only on kind: tolerate the self-signed proxy cert inside the cluster */
  insecure: boolean;
}

export interface Secrets {
  githubClientSecret?: pulumi.Output<string>;
  licensePem?: pulumi.Output<string>;
  chat?: pulumi.Output<Record<string, string>>;
}

export interface EnvProfile extends StackConfig {
  stack: string;
  teleport: TeleportAddrs;
  labels: { env: string; "managed-by": "pulumi"; stack: string };
  secrets: Secrets;
}

const NAMESPACE = "teleport";
const RELEASE = "teleport-cluster";

/** Pure: build a profile from an already-merged config object (used by tests). */
export function buildProfile(input: DeepPartial<StackConfigInput>, stack: string, secrets: Secrets = {}): EnvProfile {
  const platform = (input.platform ?? "generic") as Platform;
  const merged = deepMerge({} as StackConfigInput, platformDefaults[platform] as any, input as any);
  // Maps that describe a *set* are replaced by the stack config, not merged with the defaults.
  if (input.dummies?.sshNodes) (merged as any).dummies.sshNodes = input.dummies.sshNodes;
  if (input.github?.teamsToRoles) (merged as any).github.teamsToRoles = input.github.teamsToRoles;
  if (input.users) (merged as any).users = input.users;
  const parsed = StackConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`invalid teleport:* stack configuration for stack "${stack}":\n${issues}`);
  }
  const cfg = parsed.data;
  enforceInvariants(cfg, stack, secrets);

  const publicHost = cfg.publicAddr.split(":")[0];
  const teleport: TeleportAddrs = {
    namespace: NAMESPACE,
    releaseName: RELEASE,
    version: cfg.version,
    clusterName: cfg.clusterName,
    publicAddr: cfg.publicAddr,
    publicHost,
    inClusterProxyAddr: cfg.publicAddr,
    inClusterAuthAddr: `${RELEASE}-auth.${NAMESPACE}.svc.cluster.local:3025`,
    insecure: cfg.insecureLocal,
  };
  return { ...cfg, stack, teleport, labels: { env: cfg.env, "managed-by": "pulumi", stack }, secrets };
}

/** Roles that must never be a standing assignment off the local stack. */
const STANDING_ADMIN_ROLES = ["editor", "access"];
/** Container images every stack deploys; prod must pin each by digest. */
function requiredImages(cfg: StackConfig): string[] {
  const names: string[] = [];
  if (cfg.services.mcp.enabled || cfg.services.broker.enabled) names.push("teleport-access");
  if (cfg.services.agent.enabled) names.push("access-agent");
  if (cfg.dummies.enabled) names.push("ssh-node");
  return names;
}

/**
 * CI previews of the cloud stack files run against the kind context and without the GitHub client
 * secret; `TELEPORT_ALLOW_KIND_CONTEXT=1` allows exactly those two things and nothing else.
 */
export function ciPreviewEscapeHatch(): boolean {
  return process.env.TELEPORT_ALLOW_KIND_CONTEXT === "1";
}

export function enforceInvariants(cfg: StackConfig, stack: string, secrets: Secrets): void {
  const problems: string[] = [];
  const local = cfg.env === "local";
  const prod = cfg.env === "prod";
  const kind = cfg.platform === "kind";
  const allowPreview = ciPreviewEscapeHatch();

  if (cfg.insecureLocal && !kind) problems.push("insecureLocal may only be true on platform=kind");
  if (cfg.edition === "enterprise" && !secrets.licensePem) problems.push("edition=enterprise requires the secret teleport:licensePem");
  if (cfg.auth.type === "github" && !cfg.github)
    problems.push("auth.type=github requires teleport:github (clientId, organization, teamsToRoles) and the secret teleport:githubClientSecret");
  if (cfg.auth.type === "github" && cfg.github && !secrets.githubClientSecret) {
    const msg = "teleport:github is set but the secret teleport:githubClientSecret is missing (make github-sso, or: pulumi config set --secret teleport:githubClientSecret ...)";
    if (allowPreview) pulumi.log.warn(`${msg}; TELEPORT_ALLOW_KIND_CONTEXT=1: the GitHub connector is not rendered in this preview`);
    else problems.push(msg);
  }
  if (cfg.exposure.type === "nodeport" && !kind) problems.push("exposure.type=nodeport is only meant for kind");
  if (kind && cfg.kubeContext === "kind-kind") problems.push('refusing to target the default kind cluster context "kind-kind"');
  if (!kind && cfg.kubeContext.startsWith("kind-") && !allowPreview)
    problems.push(`platform=${cfg.platform} must not target the kind context "${cfg.kubeContext}" (CI previews set TELEPORT_ALLOW_KIND_CONTEXT=1)`);
  if (cfg.chartMode.mode !== "standalone" && kind) problems.push("cloud chartMode requires a cloud platform");
  if (cfg.services.agent.enabled && !cfg.services.mcp.enabled) problems.push("services.agent requires services.mcp");

  // --- no standing privilege off the local stack
  if (!local) {
    for (const u of cfg.users) {
      const bad = u.roles.filter((r) => STANDING_ADMIN_ROLES.includes(r));
      if (bad.length) problems.push(`users[${u.name}] holds standing admin role(s) ${bad.join(", ")}; request break-glass-editor instead (env=${cfg.env})`);
    }
    for (const m of cfg.github?.teamsToRoles ?? []) {
      const bad = m.roles.filter((r) => STANDING_ADMIN_ROLES.includes(r));
      if (bad.length) problems.push(`github.teamsToRoles[${m.team}] maps to standing admin role(s) ${bad.join(", ")}; use requester/approver/auditor (env=${cfg.env})`);
    }
    if (cfg.auth.type === "local") problems.push(`auth.type=local is only allowed on env=local (env=${cfg.env}); configure SSO (make github-sso)`);
    if (cfg.auth.localAuth) problems.push(`auth.localAuth must be false off env=local (env=${cfg.env})`);
    if (cfg.auth.secondFactors.includes("otp")) problems.push(`auth.secondFactors must not include otp off env=local (env=${cfg.env}); use [webauthn]`);
  }

  // --- production hardening
  if (prod && cfg.chartMode.mode === "standalone") problems.push("env=prod requires a managed backend (chartMode aws/gcp/azure), not standalone");
  if (prod && cfg.dummies.enabled) problems.push("env=prod must not deploy dummy resources (dummies.enabled=false)");
  if (prod && cfg.images.pullPolicy === "Always") problems.push('env=prod requires images.pullPolicy IfNotPresent (images are pinned by digest, not re-pulled)');
  if (prod) {
    for (const img of requiredImages(cfg)) if (!cfg.images.digests[img]) problems.push(`env=prod requires images.digests["${img}"] (sha256:...) for every deployed image`);
  }

  // --- services never exposed beyond their design
  if (cfg.services.harness.enabled && !kind) problems.push("services.harness (CI harness bot) may only be enabled on platform=kind");
  if (cfg.services.agent.enabled && !kind && cfg.services.agent.allowedEmailDomains.length === 0)
    problems.push("services.agent.allowedEmailDomains must be non-empty when the agent is enabled off kind (identity fails closed)");
  if (cfg.services.agent.enabled && cfg.services.agent.adapters.includes("slack") && cfg.services.agent.slackAllowedTeamIds.length === 0)
    problems.push("services.agent.slackAllowedTeamIds must be non-empty when the slack adapter is enabled");
  if (cfg.exposure.type === "loadbalancer" && !kind && !cfg.exposure.internal && cfg.exposure.sourceRanges.length === 0)
    problems.push("exposure.loadbalancer: an internet-facing load balancer (internal=false) requires non-empty sourceRanges");

  if (problems.length) throw new Error(`invalid configuration for stack "${stack}":\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}

/** Read the `teleport:` config namespace of the current stack. */
export function loadProfile(config = new pulumi.Config("teleport"), stack = pulumi.getStack()): EnvProfile {
  const obj = <T>(k: string): T | undefined => config.getObject<T>(k);
  const str = (k: string): string | undefined => config.get(k);
  const bool = (k: string): boolean | undefined => (config.get(k) === undefined ? undefined : config.getBoolean(k));

  const input: DeepPartial<StackConfigInput> = {
    env: str("env"),
    platform: str("platform") as Platform | undefined,
    kubeContext: str("kubeContext"),
    kubeconfig: str("kubeconfig"),
    clusterName: str("clusterName"),
    publicAddr: str("publicAddr"),
    version: str("version"),
    edition: str("edition") as any,
    exposure: obj("exposure"),
    tls: obj("tls"),
    auth: obj("auth"),
    github: obj("github"),
    chartMode: obj("chartMode"),
    images: obj("images"),
    insecureLocal: bool("insecureLocal"),
    dummies: obj("dummies"),
    services: obj("services"),
    users: obj("users"),
  };
  const secrets: Secrets = {
    githubClientSecret: config.getSecret(SECRET_KEYS.githubClientSecret),
    licensePem: config.getSecret(SECRET_KEYS.licensePem),
    chat: config.getSecretObject<Record<string, string>>(SECRET_KEYS.chat),
  };
  return buildProfile(input, stack, secrets);
}
