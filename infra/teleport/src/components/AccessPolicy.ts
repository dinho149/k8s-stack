/**
 * AccessPolicy — everything Teleport-side about *who may do what*, as operator CRs:
 * catalog roles, requester/approver, bot roles + Bots + join tokens, local users,
 * agent join tokens, and the GitHub SSO connector.
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { EnvProfile } from "../config/profile";
import { TeleportBotV1, TeleportGithubConnector, TeleportProvisionToken, TeleportRoleV7, TeleportUser } from "../crds";
import { ACCESS_NAMESPACE, BOTS, TOKENS, type BotKey } from "../policy/catalog";
import { renderAllRoles, renderBrokerPolicy } from "../policy/render";
import type { TeleportCluster } from "./TeleportCluster";

export interface AccessPolicyArgs {
  profile: EnvProfile;
  cluster: TeleportCluster;
}

export class AccessPolicy extends pulumi.ComponentResource {
  public readonly roleNames: pulumi.Output<string[]>;
  public readonly brokerPolicyYaml: pulumi.Output<string>;
  public readonly roles: Record<string, pulumi.Resource> = {};
  public readonly bots: Record<string, pulumi.Resource> = {};
  public readonly tokens: Record<string, pulumi.Resource> = {};
  public readonly users: Record<string, pulumi.Resource> = {};
  public readonly githubConnector?: pulumi.Resource;

  constructor(name: string, args: AccessPolicyArgs, opts?: pulumi.ComponentResourceOptions) {
    super("k8s-teleport:access:AccessPolicy", name, {}, opts);
    const p = args.profile;
    const ns = args.cluster.namespace.metadata.name;
    const child = (deps: pulumi.Resource[] = []): pulumi.CustomResourceOptions => ({ parent: this, dependsOn: [args.cluster.chart, ...deps] });
    // The operator copies CR labels onto the Teleport resource, so keep them minimal and meaningful.
    const labels = { env: p.env, stack: p.stack, "managed-by": "pulumi" };

    // --- roles
    const rendered = renderAllRoles(p.edition);
    for (const r of rendered) {
      this.roles[r.name] = new TeleportRoleV7(`${name}-role-${r.name}`, { name: r.name, namespace: ns, labels, annotations: { "k8s-teleport/description": r.description }, spec: r.spec }, child());
    }
    const allRoles = Object.values(this.roles);

    // --- bots + tokens (kubernetes join, scoped to a ServiceAccount in teleport-access)
    for (const key of Object.keys(BOTS) as BotKey[]) {
      const b = BOTS[key];
      this.bots[b.name] = new TeleportBotV1(
        `${name}-bot-${b.name}`,
        { name: b.name, namespace: ns, labels, spec: { roles: [b.role], traits: [], max_session_ttl: "12h" } },
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

    // --- agent tokens (kube-agent, ssh dummy nodes)
    for (const t of Object.values(TOKENS)) {
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

    // --- local users (admin break-glass + headless test users)
    for (const u of p.users) {
      this.users[u.name] = new TeleportUser(
        `${name}-user-${u.name}`,
        { name: u.name, namespace: ns, labels, spec: { roles: u.roles, traits: u.traits } },
        child(allRoles),
      );
    }

    // --- GitHub SSO
    if (p.auth.type === "github" && p.github && p.secrets.githubClientSecret) {
      const secret = new k8s.core.v1.Secret(
        `${name}-github-oauth`,
        {
          metadata: {
            name: "github-oauth",
            namespace: ns,
            labels,
            // Lets the operator resolve `secret://github-oauth/client_secret` from the connector CR.
            annotations: { "resources.teleport.dev/allow-lookup-from-cr": "*" },
          },
          stringData: { client_secret: p.secrets.githubClientSecret },
        },
        child(),
      );
      this.githubConnector = new TeleportGithubConnector(
        `${name}-github`,
        {
          name: p.auth.connectorName ?? "github",
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

    this.roleNames = pulumi.output(rendered.map((r) => r.name));
    this.brokerPolicyYaml = pulumi.output(renderBrokerPolicy());
    this.registerOutputs({ roleNames: this.roleNames });
  }
}
