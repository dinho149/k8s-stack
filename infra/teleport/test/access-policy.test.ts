import { describe, expect, it } from "vitest";
import { CATALOG, FIXED_ROLES } from "../src/policy/catalog";
import { renderAllRoles, renderApproverRole, renderBrokerPolicy, renderCatalogRole, renderRequesterRole } from "../src/policy/render";

describe("role catalog rendering", () => {
  it("scopes every catalog role by the env label only", () => {
    for (const r of CATALOG) {
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

  it("requester can request exactly the catalog and nothing else, community-safe", () => {
    const { spec } = renderRequesterRole("community");
    expect(spec.allow!.request!.roles).toEqual(CATALOG.map((r) => r.name));
    expect(spec.allow!.request!.thresholds).toBeUndefined();
    expect(spec.allow!.request!.search_as_roles).toBeUndefined();
    expect(spec.allow!.node_labels).toBeUndefined();
    expect(spec.allow!.rules).toBeUndefined();
  });

  it("enterprise adds thresholds, search_as_roles and review_requests", () => {
    expect(renderRequesterRole("enterprise").spec.allow!.request!.thresholds).toHaveLength(1);
    expect(renderApproverRole("enterprise").spec.allow!.review_requests!.roles).toEqual(CATALOG.map((r) => r.name));
    expect(renderApproverRole("community").spec.allow!.review_requests).toBeUndefined();
  });

  it("community approver holds the access_request update rule", () => {
    const rules = renderApproverRole("community").spec.allow!.rules!;
    expect(rules.find((r) => r.resources.includes("access_request"))!.verbs).toEqual(expect.arrayContaining(["list", "read", "update"]));
  });

  it("bot roles are least privilege", () => {
    const roles = Object.fromEntries(renderAllRoles("community").map((r) => [r.name, r]));
    const rule = (name: string, res: string) => roles[name].spec.allow!.rules!.find((r) => r.resources.includes(res))?.verbs ?? [];
    expect(rule(FIXED_ROLES.botMcp, "access_request")).toEqual(["list", "read", "create"]);
    expect(rule(FIXED_ROLES.botMcp, "access_request")).not.toContain("update");
    expect(rule(FIXED_ROLES.botBroker, "access_request")).toEqual(["list", "read", "update"]);
    expect(rule(FIXED_ROLES.botBroker, "access_request")).not.toContain("create");
    expect(roles[FIXED_ROLES.botMcp].spec.allow!.impersonate).toBeUndefined();
    expect(roles[FIXED_ROLES.botAgent].spec.allow!.rules).toHaveLength(1);
  });

  it("broker policy mirrors the tiers", () => {
    const yaml = renderBrokerPolicy();
    expect(yaml).toContain("kind: ApprovalPolicy");
    for (const r of CATALOG.filter((x) => x.tier === "low")) expect(yaml).toMatch(new RegExp(`auto-approve-low-risk[\\s\\S]*"${r.name}"`));
    for (const r of CATALOG.filter((x) => x.tier === "high")) expect(yaml).toMatch(new RegExp(`high-risk-needs-approval[\\s\\S]*"${r.name}"`));
    expect(yaml).toContain('"editor"');
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
  it("wildcard labels without logins/db users/kube groups", () => {
    const roles = Object.fromEntries(renderAllRoles("community").map((r) => [r.name, r]));
    for (const name of [FIXED_ROLES.botMcp, FIXED_ROLES.botBroker, FIXED_ROLES.botHarness]) {
      const a = roles[name].spec.allow!;
      expect(a.node_labels).toEqual({ "*": ["*"] });
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
    const p = buildProfile({ ...base, services: { agent: { enabled: true, adapters: ["slack"], auth: "subscription" } } }, "local");
    expect(renderAgentAuthEnv(p)).toContainEqual({ name: "CLAUDE_AUTH_MODE", value: "subscription" });
    expect(p.services.agent.persistSessions).toBe(false);
  });
});
