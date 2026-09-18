import { describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { BOTS, CATALOG, FIXED_ROLES, KUBE_GROUPS, NEVER_AUTO_ROLES, TOKENS, sshNodeToken } from "../src/policy/catalog";
import { HARDENED_OPTIONS, assignableRoleNames, renderAllRoles, renderApproverRole, renderBrokerPolicy, renderCatalogRole, renderHarnessRole, renderRequesterRole } from "../src/policy/render";

const catalogNames = CATALOG.map((r) => r.name);
const byName = (harness = false) => Object.fromEntries(renderAllRoles("community", { harness }).map((r) => [r.name, r]));
const json = (v: unknown) => JSON.stringify(v);

describe("role catalog rendering", () => {
  it("scopes every label-based catalog role by the env label only", () => {
    for (const r of CATALOG.filter((x) => !x.scope.rules)) {
      const { spec } = renderCatalogRole(r);
      const sel = spec.allow!.node_labels ?? spec.allow!.db_labels ?? spec.allow!.kubernetes_labels ?? spec.allow!.app_labels;
      expect(sel).toEqual({ env: r.envs });
      expect(spec.allow!.rules).toBeUndefined();
      expect(spec.options).toMatchObject({ max_session_ttl: r.maxSessionTtl });
    }
  });

  it("low-risk roles never touch prod", () => {
    for (const r of CATALOG.filter((x) => x.tier === "low")) expect(r.envs).not.toContain("prod");
  });

  it("every catalog role carries the hardened session options and a non-empty deny", () => {
    for (const r of CATALOG) {
      const { spec } = renderCatalogRole(r);
      expect(spec.options).toMatchObject(HARDENED_OPTIONS);
      expect(spec.options).toMatchObject({ require_session_mfa: "yes", disconnect_expired_cert: true, lock: "strict", client_idle_timeout: "15m", ssh_file_copy: false });
      // pin_source_ip is Enterprise-only: the Community auth server rejects roles that set it
      expect(spec.options).not.toHaveProperty("pin_source_ip");
      expect(renderCatalogRole(r, "enterprise").spec.options).toMatchObject({ pin_source_ip: true });
      expect(spec.deny).toBeDefined();
      expect(Object.keys(spec.deny!).length).toBeGreaterThan(0);
    }
  });

  it("resource-granting catalog roles deny every write; break-glass-editor may write but never approve", () => {
    for (const r of CATALOG.filter((x) => !x.scope.rules)) {
      expect(renderCatalogRole(r).spec.deny!.rules).toEqual([{ resources: ["*"], verbs: ["create", "update", "delete"] }]);
    }
    const bg = renderCatalogRole(CATALOG.find((r) => r.name === "break-glass-editor")!).spec;
    expect(bg.allow!.rules).toEqual([{ resources: ["role", "user", "token", "auth_connector", "lock"], verbs: ["list", "read", "create", "update", "delete"] }]);
    expect(bg.allow!.logins).toBeUndefined();
    expect(bg.allow!.node_labels).toBeUndefined();
    expect(bg.deny!.rules).toEqual([{ resources: ["access_request"], verbs: ["update"] }]);
    expect(bg.options!.max_session_ttl).toBe("1h");
    expect(CATALOG.find((r) => r.name === "break-glass-editor")!.tier).toBe("high");
  });

  it("no role anywhere grants system:masters, wildcard db users or wildcard kube resources", () => {
    for (const r of renderAllRoles("community", { harness: true })) {
      expect(json(r.spec)).not.toContain("system:masters");
      expect(r.spec.allow?.db_users ?? []).not.toContain("*");
    }
    for (const r of CATALOG) if (r.scope.kube) expect(r.scope.kube.resources.length).toBeGreaterThan(0);
    const admin = byName()["k8s-admin"].spec.allow!;
    expect(admin.kubernetes_groups).toEqual([KUBE_GROUPS.clusterAdmin]);
  });

  it("dba is split per env: dev-dba / prod-dba, no dba", () => {
    const names = Object.keys(byName());
    expect(names).toContain("dev-dba");
    expect(names).toContain("prod-dba");
    expect(names).not.toContain("dba");
    expect(byName()["dev-dba"].spec.allow!.db_labels).toEqual({ env: ["local", "dev"] });
    expect(byName()["prod-dba"].spec.allow!.db_labels).toEqual({ env: ["prod"] });
    expect(byName()["prod-dba"].spec.allow!.db_users).toEqual(["postgres", "readonly"]);
  });

  it("requester can request exactly the catalog (incl. break-glass-editor), needs a reason, short max_duration, community-safe", () => {
    const { spec } = renderRequesterRole("community");
    expect(spec.allow!.request!.roles).toEqual(catalogNames);
    expect(spec.allow!.request!.roles).toContain("break-glass-editor");
    expect(spec.allow!.request!.reason).toEqual({ mode: "required" });
    expect(spec.allow!.request!.max_duration).toBe("4h");
    expect(spec.allow!.request!.suggested_reviewers).toBeUndefined();
    expect(spec.allow!.request!.thresholds).toBeUndefined();
    expect(spec.allow!.request!.search_as_roles).toBeUndefined();
    expect(spec.allow!.node_labels).toBeUndefined();
    expect(spec.allow!.rules).toBeUndefined();
    expect(spec.options).toMatchObject({ require_session_mfa: "yes", lock: "strict" });
  });

  it("requester denies cluster security config and never overlaps what break-glass-editor grants", () => {
    // Teleport applies deny rules across every role a user holds, so a requester deny on role/user/token
    // writes would silently neuter break-glass-editor for everyone (all humans hold requester).
    const deny = renderRequesterRole("community").spec.deny!.rules!;
    expect(deny.find((r) => r.resources.includes("cluster_auth_preference"))!.verbs).toEqual(["*"]);
    const bg = CATALOG.find((r) => r.name === "break-glass-editor")!.scope.rules!.flatMap((r) => r.resources);
    for (const rule of deny) for (const res of rule.resources) expect(bg).not.toContain(res);
  });

  it("enterprise adds thresholds, search_as_roles and review_requests", () => {
    expect(renderRequesterRole("enterprise").spec.allow!.request!.thresholds).toHaveLength(1);
    expect(renderApproverRole("enterprise").spec.allow!.review_requests!.roles).toEqual(catalogNames);
    expect(renderApproverRole("community").spec.allow!.review_requests).toBeUndefined();
  });

  it("community approver may list/read/update requests, never delete, short MFA sessions", () => {
    const { spec } = renderApproverRole("community");
    const ar = spec.allow!.rules!.find((r) => r.resources.includes("access_request"))!;
    expect(ar.verbs).toEqual(["list", "read", "update"]);
    expect(spec.options).toEqual({ max_session_ttl: "1h", require_session_mfa: "yes", lock: "strict" });
  });

  it("bot roles are least privilege", () => {
    const roles = byName(true);
    const rule = (name: string, res: string) => roles[name].spec.allow!.rules!.find((r) => r.resources.includes(res))?.verbs ?? [];
    expect(rule(FIXED_ROLES.botMcp, "access_request")).toEqual(["list", "read", "create"]);
    expect(rule(FIXED_ROLES.botMcp, "access_request")).not.toContain("update");
    expect(rule(FIXED_ROLES.botBroker, "access_request")).toEqual(["list", "read", "update"]);
    expect(rule(FIXED_ROLES.botBroker, "access_request")).not.toContain("create");
    expect(roles[FIXED_ROLES.botMcp].spec.allow!.impersonate).toBeUndefined();
    expect(roles[FIXED_ROLES.botAgent].spec.allow!.rules).toHaveLength(1);
  });

  it("no bot may open prod apps or use an app wildcard", () => {
    for (const r of renderAllRoles("community", { harness: true }).filter((x) => x.name.startsWith("svc-"))) {
      const app = r.spec.allow?.app_labels;
      if (app) {
        expect(app["*"]).toBeUndefined();
        expect(app.env).toEqual(["local", "dev"]);
        expect(r.spec.deny?.app_labels).toEqual({ env: ["prod"] });
      }
    }
  });

  it("no rendered role impersonates a catalog role", () => {
    for (const r of renderAllRoles("community", { harness: true })) {
      for (const role of r.spec.allow?.impersonate?.roles ?? []) expect(catalogNames).not.toContain(role);
    }
  });

  it("harness role is defanged and only rendered on request", () => {
    expect(Object.keys(byName(false))).not.toContain(FIXED_ROLES.botHarness);
    expect(Object.keys(byName(true))).toContain(FIXED_ROLES.botHarness);
    const h = renderHarnessRole().spec.allow!;
    const verbs = (res: string) => h.rules!.find((r) => r.resources.includes(res))?.verbs;
    expect(verbs("access_request")).toEqual(["list", "read", "create", "update", "delete"]);
    expect(verbs("user")).toEqual(["list", "read", "update"]);
    expect(verbs("token")).toBeUndefined();
    expect(verbs("auth_connector")).toBeUndefined();
    expect(h.impersonate).toEqual({ users: ["alice", "bob"], roles: [FIXED_ROLES.requester, FIXED_ROLES.approver] });
  });

  it("broker policy mirrors the tiers and allow-lists the catalog", () => {
    const yaml = renderBrokerPolicy();
    expect(yaml).toContain("kind: ApprovalPolicy");
    expect(yaml).toMatch(/^defaults:\n {2}action: require_approval/m);
    const allowed = /^allowed_roles: \[(.*)\]$/m.exec(yaml)![1].split(", ").map((s) => JSON.parse(s));
    expect(allowed).toEqual(catalogNames);
    const auto = /auto-approve-low-risk\n\s+match: \{ roles: \[(.*?)\]/.exec(yaml)![1].split(", ").map((s) => JSON.parse(s));
    expect(auto).toEqual(CATALOG.filter((r) => r.tier === "low").map((r) => r.name));
    for (const r of CATALOG.filter((x) => x.tier === "high")) expect(yaml).toMatch(new RegExp(`high-risk-needs-approval[\\s\\S]*"${r.name}"`));
    for (const n of NEVER_AUTO_ROLES) expect(yaml).toContain(JSON.stringify(n));
    expect(NEVER_AUTO_ROLES).toEqual(expect.arrayContaining(["editor", "access", "auditor", "approver", "^admin-.*$"]));
  });

  it("assignable role names exclude bot roles and include the presets", () => {
    const names = assignableRoleNames();
    for (const b of Object.values(BOTS)) expect(names).not.toContain(b.role);
    for (const n of ["requester", "approver", "editor", "auditor", "access", "break-glass-editor"]) expect(names).toContain(n);
  });

  it("join tokens: kube-agent without Discovery, ssh-node per env", () => {
    expect(TOKENS.kubeAgent.roles).not.toContain("Discovery");
    expect(sshNodeToken("prod")).toEqual({ name: "ssh-node-prod", roles: ["Node"], serviceAccount: "teleport-dummies:ssh-node-prod" });
  });
});

import { renderAccessMonitoringRules } from "../src/components/EnterpriseAccess";
describe("enterprise access monitoring rules", () => {
  it("auto-approves only low-tier roles and notifies for high-tier", () => {
    const rules = renderAccessMonitoringRules("#chan");
    const auto = rules.find((r) => r.name === "auto-approve-low-risk")!;
    expect((auto.spec.condition as string)).toContain('"dev-ssh"');
    expect((auto.spec.condition as string)).toContain('!access_request.spec.roles.contains_any');
    expect(auto.spec.automatic_review).toEqual({ integration: "builtin", decision: "APPROVED" });
    const notify = rules.find((r) => r.name === "notify-high-risk")!;
    expect((notify.spec.condition as string)).toContain('"prod-ssh"');
    expect((notify.spec.notification as any).recipients).toEqual(["#chan"]);
  });
});

describe("service roles can see inventory but not connect", () => {
  it("wildcard node/db/kube labels without logins/db users/kube groups; apps only in low-risk envs", () => {
    const roles = byName(true);
    for (const name of [FIXED_ROLES.botMcp, FIXED_ROLES.botBroker, FIXED_ROLES.botHarness]) {
      const a = roles[name].spec.allow!;
      expect(a.node_labels).toEqual({ "*": ["*"] });
      expect(a.app_labels).toEqual({ env: ["local", "dev"] });
      expect(a.logins).toBeUndefined();
      expect(a.db_users).toBeUndefined();
      expect(a.kubernetes_groups).toBeUndefined();
    }
    expect(roles[FIXED_ROLES.botAgent].spec.allow!.node_labels).toBeUndefined();
  });
});

import { buildProfile } from "../src/config/profile";
import { renderAgentAuthEnv } from "../src/components/AccessServices";
describe("agent auth env", () => {
  const base = { platform: "kind" as const, kubeContext: "kind-teleport-local", version: "18.11.1", auth: { type: "local" as const } };
  it("defaults to api-key and never allows the local login in-cluster", () => {
    const env = renderAgentAuthEnv(buildProfile(base, "local"));
    expect(env).toContainEqual({ name: "CLAUDE_AUTH_MODE", value: "api-key" });
    expect(env).toContainEqual({ name: "CLAUDE_ALLOW_LOCAL_LOGIN", value: "false" });
  });
  it("switches to subscription from stack config", () => {
    const p = buildProfile({ ...base, services: { agent: { enabled: true, adapters: ["slack"], auth: "subscription", slackAllowedTeamIds: ["T123"] } } }, "local");
    expect(renderAgentAuthEnv(p)).toContainEqual({ name: "CLAUDE_AUTH_MODE", value: "subscription" });
    expect(p.services.agent.persistSessions).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// AccessPolicy component under Pulumi mocks: which CRs actually get created per profile.
import { AccessPolicy, enabledBots } from "../src/components/AccessPolicy";

interface Created { type: string; name: string; inputs: any }
async function createAccessPolicy(profileInput: Parameters<typeof buildProfile>[0], stack: string): Promise<Created[]> {
  const created: Created[] = [];
  pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        created.push({ type: args.type, name: args.name, inputs: args.inputs });
        return { id: `${args.name}-id`, state: { ...args.inputs, metadata: { ...(args.inputs.metadata ?? {}), name: args.inputs.metadata?.name ?? args.name } } };
      },
      call: (args) => args.inputs,
    },
    "teleport",
    stack,
    false,
  );
  const profile = buildProfile(profileInput, stack);
  const cluster = { namespace: { metadata: { name: pulumi.output("teleport") } }, chart: new pulumi.ComponentResource("test:mock:Chart", "chart") } as any;
  new AccessPolicy("access", { profile, cluster });
  await new Promise((r) => setTimeout(r, 200));
  return created;
}
const crName = (c: Created) => c.inputs.metadata?.name as string;
const kindOf = (c: Created) => c.inputs.kind as string | undefined;

describe("AccessPolicy resources", () => {
  const kindBase = { platform: "kind" as const, kubeContext: "kind-teleport-local", version: "18.11.1", auth: { type: "local" as const } };

  it("enabledBots follows services.harness.enabled", () => {
    expect(enabledBots({ services: { harness: { enabled: true } } } as any)).toContain("harness");
    expect(enabledBots({ services: { harness: { enabled: false } } } as any)).not.toContain("harness");
  });

  it("kind: harness bot/token/role present, ssh-node token per env, kube RBAC bindings without system:masters", async () => {
    const created = await createAccessPolicy(kindBase, "local");
    const names = (kind: string) => created.filter((c) => kindOf(c) === kind).map(crName);
    expect(names("TeleportBotV1")).toContain(BOTS.harness.name);
    expect(names("TeleportProvisionToken")).toEqual(expect.arrayContaining([BOTS.harness.name, "kube-agent", "ssh-node-dev", "ssh-node-prod"]));
    expect(names("TeleportProvisionToken")).not.toContain("ssh-node");
    expect(names("TeleportRoleV7")).toContain(FIXED_ROLES.botHarness);
    const bots = created.filter((c) => kindOf(c) === "TeleportBotV1");
    for (const b of bots) expect(b.inputs.spec.max_session_ttl).toBe("7200s"); // protobuf Duration form
    const crbs = created.filter((c) => c.type === "kubernetes:rbac.authorization.k8s.io/v1:ClusterRoleBinding");
    expect(crbs.map((c) => c.inputs.metadata.name).sort()).toEqual([KUBE_GROUPS.clusterAdmin, KUBE_GROUPS.prodViewer]);
    for (const c of crbs) expect(c.inputs.metadata.labels).toMatchObject({ env: "local", stack: "local", "managed-by": "pulumi" });
    expect(crbs.find((c) => c.inputs.metadata.name === KUBE_GROUPS.clusterAdmin)!.inputs.roleRef.name).toBe("cluster-admin");
    expect(crbs.find((c) => c.inputs.metadata.name === KUBE_GROUPS.prodViewer)!.inputs.roleRef.name).toBe("view");
    // the dev RoleBinding is bound later, once the dummies namespace exists
    expect(created.filter((c) => c.type === "kubernetes:rbac.authorization.k8s.io/v1:RoleBinding")).toHaveLength(0);
    expect(JSON.stringify(created)).not.toContain("system:masters");
  });

  it("harness disabled: no harness bot, token or role; no ssh-node tokens without dummies", async () => {
    const created = await createAccessPolicy({ ...kindBase, dummies: { enabled: false }, services: { harness: { enabled: false } } }, "local");
    const names = created.map(crName);
    expect(names).not.toContain(BOTS.harness.name);
    expect(names).not.toContain(FIXED_ROLES.botHarness);
    expect(names.filter((n) => n?.startsWith("ssh-node"))).toHaveLength(0);
    expect(names).toContain(BOTS.mcp.name);
  });
});

describe("per-session MFA is gated on a WebAuthn factor", () => {
  it("is required everywhere by default and on every human role", () => {
    for (const r of renderAllRoles("community")) {
      if (r.name.startsWith("svc-")) continue;
      expect(r.spec.options?.require_session_mfa).toBe("yes");
    }
  });
  it("is dropped (never set to a TOTP-incompatible value) when the stack has no WebAuthn factor", () => {
    for (const r of renderAllRoles("community", { sessionMfa: false })) {
      expect(r.spec.options ?? {}).not.toHaveProperty("require_session_mfa");
      if (!r.name.startsWith("svc-") && r.name !== "requester" && r.name !== "approver") expect(r.spec.options).toMatchObject({ lock: "strict", disconnect_expired_cert: true });
    }
  });
});
