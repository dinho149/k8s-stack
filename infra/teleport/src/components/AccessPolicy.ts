/**
 * AccessPolicy — everything Teleport-side about *who may do what*, as operator CRs:
 * catalog roles, requester/approver, bot roles + Bots + join tokens, local users,
 * agent join tokens, the GitHub SSO connector, and the Kubernetes RBAC behind the catalog's
 * kubernetes_groups (KubeRbac).
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { EnvProfile } from "../config/profile";
import { TeleportBotV1, TeleportGithubConnector, TeleportProvisionToken, TeleportRoleV7, TeleportUser } from "../crds";
import { ACCESS_NAMESPACE, BOTS, BOT_MAX_SESSION_TTL, TOKENS, sshNodeToken, type BotKey } from "../policy/catalog";
import { renderAllRoles, renderBrokerPolicy } from "../policy/render";
import { KubeRbac } from "./KubeRbac";
import type { TeleportCluster } from "./TeleportCluster";

export interface AccessPolicyArgs {
  profile: EnvProfile;
  cluster: TeleportCluster;
}

/** Which bots a profile deploys: the harness only where explicitly enabled (kind); the portal where enabled. */
export function enabledBots(p: Pick<EnvProfile, "services">): BotKey[] {
  return (Object.keys(BOTS) as BotKey[]).filter((k) => (k !== "harness" || p.services.harness.enabled) && (k !== "portal" || p.services.portal.enabled));
}

export class AccessPolicy extends pulumi.ComponentResource {
  public readonly roleNames: pulumi.Output<string[]>;
  public readonly brokerPolicyYaml: pulumi.Output<string>;
  public readonly roles: Record<string, pulumi.Resource> = {};
  public readonly bots: Record<string, pulumi.Resource> = {};
  public readonly tokens: Record<string, pulumi.Resource> = {};
  /** ssh-node join tokens keyed by env (`ssh-node-<env>`), one per configured dummy SSH env. */
  public readonly sshNodeTokens: Record<string, pulumi.Resource> = {};
  public readonly users: Record<string, pulumi.Resource> = {};
  public readonly githubConnector?: pulumi.Resource;
  public readonly kubeRbac: KubeRbac;

  constructor(name: string, args: AccessPolicyArgs, opts?: pulumi.ComponentResourceOptions) {
    super("k8s-teleport:access:AccessPolicy", name, {}, opts);
    const p = args.profile;
    const ns = args.cluster.namespace.metadata.name;
    const child = (deps: pulumi.Resource[] = []): pulumi.CustomResourceOptions => ({ parent: this, dependsOn: [args.cluster.chart, ...deps] });
    // The operator copies CR labels onto the Teleport resource, so keep them minimal and meaningful.
    const labels = { env: p.env, stack: p.stack, "managed-by": "pulumi" };

    // --- roles (the harness role only exists where the harness bot is enabled)
    // Per-session MFA needs a WebAuthn/SSO factor; OTP-only stacks (kind) cannot satisfy it (see render.ts).
    const rendered = renderAllRoles(p.edition, { harness: p.services.harness.enabled, sessionMfa: p.auth.secondFactors.includes("webauthn") });
    for (const r of rendered) {
      this.roles[r.name] = new TeleportRoleV7(`${name}-role-${r.name}`, { name: r.name, namespace: ns, labels, annotations: { "k8s-teleport/description": r.description }, spec: r.spec }, child());
    }
    const allRoles = Object.values(this.roles);

    // --- bots + tokens (kubernetes join, scoped to a ServiceAccount in teleport-access)
    for (const key of enabledBots(p)) {
      const b = BOTS[key];
      this.bots[b.name] = new TeleportBotV1(
        `${name}-bot-${b.name}`,
        { name: b.name, namespace: ns, labels, spec: { roles: [b.role], traits: [], max_session_ttl: BOT_MAX_SESSION_TTL } },
        child([this.roles[b.role]]),
      );
      this.tokens[b.name] = new TeleportProvisionToken(
        `${name}-token-${b.name}`,
        {
          name: b.name,
          namespace: ns,
          labels,
          spec: {
            roles: ["Bot"],
            bot_name: b.name,
            join_method: "kubernetes",
            kubernetes: { type: "in_cluster", allow: [{ service_account: `${ACCESS_NAMESPACE}:${b.serviceAccount}` }] },
          },
        },
        child([this.bots[b.name]]),
      );
    }

    // --- agent tokens (kube-agent, one ssh-node token per dummy env)
    const agentTokens = [TOKENS.kubeAgent, ...(p.dummies.enabled ? Object.keys(p.dummies.sshNodes).map(sshNodeToken) : [])];
    for (const t of agentTokens) {
      this.tokens[t.name] = new TeleportProvisionToken(
        `${name}-token-${t.name}`,
        {
          name: t.name,
          namespace: ns,
          labels,
          spec: { roles: [...t.roles], join_method: "kubernetes", kubernetes: { type: "in_cluster", allow: [{ service_account: t.serviceAccount }] } },
        },
        child(),
      );
    }
    if (p.dummies.enabled) for (const env of Object.keys(p.dummies.sshNodes)) this.sshNodeTokens[env] = this.tokens[sshNodeToken(env).name];

    // --- local users (local stack only in practice: cloud stacks fail the profile invariants with local users holding editor/access)
    for (const u of p.users) {
      this.users[u.name] = new TeleportUser(
        `${name}-user-${u.name}`,
        // The TeleportUser CRD requires spec.traits to be an object when present; an empty map is serialized as
        // null by the provider and rejected by the API server, so omit it for users without traits (e.g. admin).
        { name: u.name, namespace: ns, labels, spec: { roles: u.roles, ...(Object.keys(u.traits).length ? { traits: u.traits } : {}) } },
        child(allRoles),
      );
    }

    // --- GitHub SSO
    if (p.auth.type === "github" && p.github && p.secrets.githubClientSecret) {
      const connectorName = p.auth.connectorName ?? "github";
      const secret = new k8s.core.v1.Secret(
        `${name}-github-oauth`,
        {
          metadata: {
            name: "github-oauth",
            namespace: ns,
            labels,
            // Lets the operator resolve `secret://github-oauth/client_secret` from this connector CR only.
            annotations: { "resources.teleport.dev/allow-lookup-from-cr": connectorName },
          },
          stringData: { client_secret: p.secrets.githubClientSecret },
        },
        child(),
      );
      this.githubConnector = new TeleportGithubConnector(
        `${name}-github`,
        {
          name: connectorName,
          namespace: ns,
          labels,
          spec: {
            display: p.github.display,
            client_id: p.github.clientId,
            client_secret: "secret://github-oauth/client_secret",
            redirect_url: `https://${p.publicAddr}/v1/webapi/github/callback`,
            teams_to_roles: p.github.teamsToRoles.map((m) => ({ organization: p.github!.organization, team: m.team, roles: m.roles })),
          },
        },
        child([secret, ...allRoles]),
      );
    }

    // --- Kubernetes RBAC for the catalog's kubernetes_groups (no system:masters anywhere)
    this.kubeRbac = new KubeRbac(`${name}-kube-rbac`, { profile: p }, { parent: this });

    this.roleNames = pulumi.output(rendered.map((r) => r.name));
    this.brokerPolicyYaml = pulumi.output(renderBrokerPolicy());
    this.registerOutputs({ roleNames: this.roleNames });
  }
}
