/** Kubernetes / network hardening: pure renderers of the components (no Pulumi runtime needed). */
import { describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { buildProfile } from "../src/config/profile";
import { renderNetworkPolicies, SELECTORS, AGENT_PORT, AGENT_PUBLIC_PORT } from "../src/components/NetworkPolicies";
import { renderImagePolicy, signerSubjectRegexp } from "../src/components/ImagePolicy";
import { CHAT_SECRET_LAYOUT, renderAgentEnv, renderChatSecretMounts, renderTbotConfig } from "../src/components/AccessServices";
import { imageRef, renderCaFetchScript, renderPgHba, renderSshNodeConfig } from "../src/components/DummyResources";
import { kubeAgentEnvs, kubeAgentReleaseName, renderKubeAgentValues } from "../src/components/TeleportKubeAgent";
import { hardenedContainerSecurityContext, hardenedPodSecurityContext } from "../src/lib/security";
import { namespaceLabels } from "../src/lib/labels";

const kind = buildProfile({ platform: "kind", kubeContext: "kind-dogfood-local", version: "18.11.1", auth: { type: "local" } }, "local");
const github = { clientId: "id", organization: "org", teamsToRoles: [{ team: "eng", roles: ["requester"] }] };
const cloud = (extra: Record<string, unknown> = {}) =>
  buildProfile(
    {
      platform: "eks",
      kubeContext: "eks-dev",
      env: "dev",
      clusterName: "t.example.com",
      publicAddr: "t.example.com:443",
      version: "18.11.1",
      auth: { type: "github", localAuth: false, secondFactors: ["webauthn"] },
      github,
      services: { agent: { allowedEmailDomains: ["example.com"], slackAllowedTeamIds: ["T123"] } },
      ...extra,
    },
    "dev-eks",
    { githubClientSecret: pulumi.secret("s") },
  );

const find = (p: ReturnType<typeof buildProfile>, namespace: string, name: string) => {
  const r = renderNetworkPolicies(p).find((x) => x.namespace === namespace && x.name === name);
  if (!r) throw new Error(`policy ${namespace}/${name} not rendered`);
  return r.spec as any;
};

describe("security contexts", () => {
  it("are restricted-PSS compliant", () => {
    expect(hardenedContainerSecurityContext()).toEqual({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" }, runAsNonRoot: true });
    expect(hardenedPodSecurityContext()).toMatchObject({ runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532, seccompProfile: { type: "RuntimeDefault" } });
    expect(hardenedPodSecurityContext(999).runAsUser).toBe(999);
  });

  it("namespace labels carry Pod Security Admission levels", () => {
    const l = namespaceLabels(kind, "x", "restricted");
    expect(l["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    expect(l["pod-security.kubernetes.io/warn"]).toBe("restricted");
    expect(l["pod-security.kubernetes.io/audit"]).toBe("restricted");
    expect(namespaceLabels(kind, "x", "baseline")["pod-security.kubernetes.io/enforce"]).toBe("baseline");
  });
});

describe("renderNetworkPolicies", () => {
  it("default-denies ingress and egress in every namespace, with DNS allowed", () => {
    for (const ns of ["teleport", "teleport-access", "teleport-agent", "teleport-dummies"]) {
      expect(find(kind, ns, "default-deny")).toEqual({ podSelector: {}, policyTypes: ["Ingress", "Egress"] });
      const dns = find(kind, ns, "allow-dns");
      expect(dns.egress[0].ports).toEqual([{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }]);
      expect(dns.egress[0].to[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"]).toBe("kube-system");
    }
  });

  it("no dummies namespace policies when dummies are disabled", () => {
    const names = renderNetworkPolicies(cloud()).map((r) => r.namespace);
    expect(names).not.toContain("teleport-dummies");
  });

  it("proxy is the only front door; auth accepts 3025 from proxy, operator and the three namespaces", () => {
    const proxy = find(kind, "teleport", "proxy");
    expect(proxy.ingress).toEqual([{ ports: [{ protocol: "TCP", port: 3080 }] }]);
    expect(proxy.egress[0]).toEqual({ to: [{ podSelector: { matchLabels: SELECTORS.auth } }], ports: [{ protocol: "TCP", port: 3025 }] });
    const auth = find(kind, "teleport", "auth");
    const from = auth.ingress[0].from.map((f: any) => f.namespaceSelector?.matchLabels["kubernetes.io/metadata.name"] ?? f.podSelector.matchLabels["app.kubernetes.io/component"]);
    expect(from).toEqual(["proxy", "operator", "teleport-access", "teleport-agent", "teleport-dummies"]);
    expect(auth.ingress[0].ports).toEqual([{ protocol: "TCP", port: 3025 }]);
    expect(auth.egress[0].ports.map((x: any) => x.port)).toEqual([443, 6443]);
  });

  it("access services: agent -> mcp/broker only, broker -> agent webhook, agent ingress 8082 only from broker", () => {
    const mcp = find(kind, "teleport-access", "mcp");
    expect(mcp.ingress).toEqual([{ from: [{ podSelector: { matchLabels: { app: "access-agent" } } }], ports: [{ protocol: "TCP", port: 8080 }] }]);
    const broker = find(kind, "teleport-access", "broker");
    expect(broker.ingress[0].from).toEqual([{ podSelector: { matchLabels: { app: "access-agent" } } }]);
    expect(broker.egress.at(-1)).toEqual({ to: [{ podSelector: { matchLabels: { app: "access-agent" } } }], ports: [{ protocol: "TCP", port: AGENT_PORT }] });
    const agent = find(kind, "teleport-access", "agent");
    expect(agent.ingress).toEqual([{ from: [{ podSelector: { matchLabels: { app: "access-broker" } } }], ports: [{ protocol: "TCP", port: AGENT_PORT }] }]);
    // internet 443 but never the private ranges
    const internet = agent.egress.at(-1);
    expect(internet.to[0].ipBlock).toEqual({ cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] });
    expect(internet.ports).toEqual([{ protocol: "TCP", port: 443 }]);
  });

  it("agent opens the public webhook port only for http adapters (teams/gchat), never for slack socket mode", () => {
    const slack = find(cloud(), "teleport-access", "agent");
    expect(slack.ingress.some((r: any) => r.ports?.[0]?.port === AGENT_PUBLIC_PORT)).toBe(false);
    const teams = find(cloud({ platform: "aks", kubeContext: "aks-dev" }), "teleport-access", "agent");
    expect(teams.ingress.some((r: any) => !r.from && r.ports?.[0]?.port === AGENT_PUBLIC_PORT)).toBe(true);
  });

  it("harness policy exists only when the harness is enabled", () => {
    expect(renderNetworkPolicies(kind).some((r) => r.name === "harness")).toBe(true);
    expect(renderNetworkPolicies(cloud()).some((r) => r.name === "harness")).toBe(false);
  });

  it("dummies: databases and apps accept only the kube-agent; ssh nodes only the proxy", () => {
    const db = find(kind, "teleport-dummies", "databases");
    expect(db.ingress[0].from[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"]).toBe("teleport-agent");
    expect(db.ingress[0].from[0].podSelector.matchLabels).toEqual(SELECTORS.kubeAgent);
    expect(db.ingress[0].ports.map((x: any) => x.port)).toEqual([5432, 3306]);
    const apps = find(kind, "teleport-dummies", "apps");
    expect(apps.ingress[0].from[0].podSelector.matchLabels).toEqual(SELECTORS.kubeAgent);
    const ssh = find(kind, "teleport-dummies", "ssh-nodes");
    expect(ssh.ingress[0].from[0].podSelector.matchLabels).toEqual(SELECTORS.proxy);
    expect(ssh.egress[0].ports).toEqual([{ protocol: "TCP", port: 3025 }]);
  });

  it("kube-agent reaches the proxy, the API server and the dummies, nothing else; no ingress", () => {
    const ka = find(kind, "teleport-agent", "kube-agent");
    expect(ka.ingress).toBeUndefined();
    expect(ka.egress).toHaveLength(3);
    expect(ka.egress[0].to[0].podSelector.matchLabels).toEqual(SELECTORS.proxy);
    expect(find(cloud(), "teleport-agent", "kube-agent").egress).toHaveLength(2);
  });
});

describe("ImagePolicy", () => {
  it("derives the release-workflow subject from a ghcr.io registry", () => {
    const p = cloud({ images: { registry: "ghcr.io/acme/k8s-teleport", verifySignatures: true } });
    expect(signerSubjectRegexp(p)).toBe("^https://github\\.com/acme/k8s-teleport/\\.github/workflows/release-images\\.yml@refs/.*$");
    const pol = renderImagePolicy(p) as any;
    expect(pol.kind).toBe("ClusterPolicy");
    expect(pol.spec.validationFailureAction).toBe("Enforce");
    const verify = pol.spec.rules[0].verifyImages[0];
    expect(verify.imageReferences).toEqual(["ghcr.io/acme/k8s-teleport/*"]);
    expect(verify.attestors[0].entries[0].keyless.issuer).toBe("https://token.actions.githubusercontent.com");
    expect(pol.spec.rules[0].match.any[0].resources.namespaces).toEqual(["teleport", "teleport-access", "teleport-agent", "teleport-dummies"]);
    expect(pol.spec.rules.map((r: any) => r.name)).toEqual(["verify-cosign-signature", "disallow-latest", "require-tag-or-digest"]);
  });

  it("needs an explicit subject for non-ghcr registries", () => {
    expect(() => signerSubjectRegexp(cloud({ images: { registry: "registry.example.com/tp" } }))).toThrow(/signerSubjectRegexp/);
    expect(signerSubjectRegexp(cloud({ images: { registry: "registry.example.com/tp", signerSubjectRegexp: "^x$" } }))).toBe("^x$");
  });
});

describe("AccessServices renderers", () => {
  it("tbot identities are short-lived", () => {
    const c = renderTbotConfig(kind, "teleport-mcp", "teleport-mcp");
    expect(c).toContain("certificate_ttl: 2h");
    expect(c).toContain("renewal_interval: 30m");
    expect(c).toContain("join_method: kubernetes");
  });

  it("one chat Secret per enabled adapter plus the LLM credential of the auth mode in use", () => {
    const slack = renderChatSecretMounts(cloud());
    expect(slack.map((m) => m.group)).toEqual(["llm", "slack"]);
    expect(slack[0].keys).toEqual({ ANTHROPIC_API_KEY: "anthropicApiKey" });
    expect(slack[1]).toMatchObject({ secretName: "access-agent-slack", mountPath: "/var/run/secrets/chat/slack", keys: CHAT_SECRET_LAYOUT.slack });
    const sub = renderChatSecretMounts(cloud({ services: { agent: { auth: "subscription", adapters: ["teams", "gchat"], allowedEmailDomains: ["example.com"] } } }));
    expect(sub.map((m) => m.group)).toEqual(["llm", "teams", "gchat"]);
    expect(sub[0].keys).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "claudeCodeOauthToken" });
  });

  it("agent env: secrets only via _FILE, identity fails closed, two listeners", () => {
    const env = renderAgentEnv(cloud(), ["anthropicApiKey", "slackBotToken", "slackAppToken"]);
    const get = (n: string) => env.find((e) => e.name === n)?.value;
    expect(get("IDENTITY_STRATEGY")).toBe("trait-lookup");
    expect(get("ALLOWED_EMAIL_DOMAINS")).toBe("example.com");
    expect(get("SLACK_ALLOWED_TEAM_IDS")).toBe("T123");
    expect(get("PORT")).toBe("8082");
    expect(get("PUBLIC_PORT")).toBe("8083");
    expect(get("MCP_SHARED_TOKEN_FILE")).toBe("/var/run/secrets/access-services/TA_MCP_SHARED_TOKEN");
    expect(get("BROKER_API_TOKEN_FILE")).toBe("/var/run/secrets/access-services/TA_BROKER_API_TOKEN");
    expect(get("BROKER_WEBHOOK_SECRET_FILE")).toBe("/var/run/secrets/access-services/TA_BROKER_WEBHOOK_SECRET");
    expect(get("IDENTITY_SIGNING_KEY_FILE")).toBe("/var/run/secrets/access-services/TA_IDENTITY_SIGNING_KEY");
    expect(get("ANTHROPIC_API_KEY_FILE")).toBe("/var/run/secrets/chat/llm/ANTHROPIC_API_KEY");
    expect(get("SLACK_BOT_TOKEN_FILE")).toBe("/var/run/secrets/chat/slack/SLACK_BOT_TOKEN");
    // the agent runs Slack in socket mode only: no signing secret is ever mounted or pointed at
    expect(env.some((e) => String(e.name).includes("SIGNING_SECRET"))).toBe(false);
    // no secret value is ever injected as an env value
    expect(env.every((e) => !("valueFrom" in e))).toBe(true);
    expect(env.filter((e) => /TOKEN$|SECRET$|KEY$/.test(e.name as string))).toEqual([]);
  });
});

describe("DummyResources renderers", () => {
  it("imageRef prefers digests over tags", () => {
    expect(imageRef(kind, "ssh-node")).toBe("k8s-teleport/ssh-node:dev");
    const p = cloud({ images: { registry: "ghcr.io/acme/k8s-teleport", tag: "v1", digests: { "ssh-node": `sha256:${"a".repeat(64)}` } } });
    expect(imageRef(p, "ssh-node")).toBe(`ghcr.io/acme/k8s-teleport/ssh-node@sha256:${"a".repeat(64)}`);
    expect(imageRef(p, "teleport-access")).toBe("ghcr.io/acme/k8s-teleport/teleport-access:v1");
  });

  it("ssh nodes join with a per-env token and never create host users", () => {
    const c = renderSshNodeConfig(kind, "prod");
    expect(c).toContain("token_name: ssh-node-prod");
    expect(c).toContain("disable_create_host_user: true");
    expect(c).toContain('env: "prod"');
    expect(renderSshNodeConfig(kind, "dev")).toContain("token_name: ssh-node-dev");
  });

  it("postgres only admits Teleport client certificates from the network", () => {
    const hba = renderPgHba();
    expect(hba).not.toContain("trust");
    expect(hba).toContain("hostssl all all 0.0.0.0/0      cert clientcert=verify-full");
    expect(hba).toContain("host    all all all            reject");
    expect(hba).toContain("local   all all                scram-sha-256");
  });

  it("the CA fetch script uses the proxy's public export endpoint, insecure only on kind", () => {
    expect(renderCaFetchScript(kind)).toContain("--insecure --max-time 10 \"https://teleport.127.0.0.1.nip.io:3080/webapi/auth/export?type=db-client\"");
    expect(renderCaFetchScript(cloud())).not.toContain("--insecure");
    expect(renderCaFetchScript(cloud())).toContain("https://t.example.com:443/webapi/auth/export?type=db-client");
  });
});

describe("TeleportKubeAgent", () => {
  it("one release per env, sharing the ServiceAccount the join token is bound to", () => {
    expect(kubeAgentEnvs(kind)).toEqual(["local", "dev", "prod"]);
    expect(kubeAgentEnvs(cloud())).toEqual(["dev"]);
    expect(kubeAgentReleaseName(kind, "local")).toBe("teleport-kube-agent");
    expect(kubeAgentReleaseName(kind, "prod")).toBe("teleport-kube-agent-prod");
    const primary = renderKubeAgentValues(kind) as any;
    expect(primary.serviceAccount).toEqual({ create: true, name: "teleport-kube-agent" });
    expect(primary.kubeClusterName).toBe("local-kind");
    expect(primary.appResources).toEqual([{ labels: { env: ["local"] } }]);
    const prod = renderKubeAgentValues(kind, "prod") as any;
    expect(prod.serviceAccount).toEqual({ create: false, name: "teleport-kube-agent" });
    expect(prod.kubeClusterName).toBe("prod-kind");
    expect(prod.databaseResources).toEqual([{ labels: { env: ["prod"] } }]);
    expect(prod.labels.env).toBe("prod");
    expect(prod.extraLabels.pod["app.kubernetes.io/part-of"]).toBe("kube-agents");
  });

  it("chart pods are hardened with CPU limits", () => {
    const v = renderKubeAgentValues(kind) as any;
    expect(v.securityContext).toMatchObject({ readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, runAsUser: 9807 });
    expect(v.podSecurityContext.seccompProfile).toEqual({ type: "RuntimeDefault" });
    expect(v.resources.limits.cpu).toBe("1");
    expect(v.teleportClusterName).toBe("teleport.127.0.0.1.nip.io");
  });
});
