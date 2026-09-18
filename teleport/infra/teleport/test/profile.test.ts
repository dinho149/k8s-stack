import { afterEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { buildProfile } from "../src/config/profile";

const base = { platform: "kind" as const, kubeContext: "kind-teleport-local", version: "18.11.1", auth: { type: "local" as const } };

const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
const github = { clientId: "id", organization: "org", teamsToRoles: [{ team: "teleport-users", roles: ["requester"] }, { team: "teleport-admins", roles: ["requester", "approver", "auditor"] }] };
const ghSecret = { githubClientSecret: pulumi.secret("s") };

/** A dev cloud stack that satisfies every invariant; each test below breaks exactly one thing. */
const cloudOk = {
  platform: "eks" as const,
  kubeContext: "eks-dev",
  env: "dev",
  clusterName: "t.example.com",
  publicAddr: "t.example.com:443",
  version: "18.11.1",
  auth: { type: "github" as const, localAuth: false, secondFactors: ["webauthn" as const] },
  github,
  services: { agent: { enabled: true, adapters: ["slack" as const], allowedEmailDomains: ["example.com"], slackAllowedTeamIds: ["T123"] } },
};
/** A prod stack that satisfies every invariant. */
const prodOk = {
  ...cloudOk,
  env: "prod",
  kubeContext: "eks-prod",
  chartMode: { mode: "aws" as const, region: "eu-west-1", backendTable: "b", auditLogTable: "a", sessionRecordingBucket: "s" },
  dummies: { enabled: false },
  images: { registry: "ghcr.io/x/y", tag: "v1", pullPolicy: "IfNotPresent" as const, digests: { "teleport-access": ZERO_DIGEST, "access-agent": ZERO_DIGEST } },
};
const cloud = (over: Record<string, unknown> = {}, stack = "dev-eks") => () => buildProfile({ ...cloudOk, ...over }, stack, ghSecret);
const prod = (over: Record<string, unknown> = {}) => () => buildProfile({ ...prodOk, ...over }, "prod-eks", ghSecret);

describe("buildProfile", () => {
  it("applies kind defaults and derives in-cluster addresses", () => {
    const p = buildProfile(base, "local");
    expect(p.clusterName).toBe("teleport.127.0.0.1.nip.io");
    expect(p.exposure).toEqual({ type: "nodeport", nodePort: 30080 });
    expect(p.teleport.inClusterAuthAddr).toBe("teleport-cluster-auth.teleport.svc.cluster.local:3025");
    expect(p.teleport.inClusterProxyAddr).toBe("teleport.127.0.0.1.nip.io:3080");
    expect(p.teleport.insecure).toBe(true);
    expect(p.labels).toEqual({ env: "local", "managed-by": "pulumi", stack: "local" });
    expect(p.services.harness.enabled).toBe(true);
    expect(p.tls).toEqual({ mode: "local-files", certFile: "../.state/tls/teleport.crt", keyFile: "../.state/tls/teleport.key", caFile: "../.state/tls/ca.crt" });
  });

  it("lets stack config override platform defaults", () => {
    const p = buildProfile({ ...base, clusterName: "tp.example.test", dummies: { sshNodes: { dev: 1 } } }, "local");
    expect(p.clusterName).toBe("tp.example.test");
    expect(p.dummies.sshNodes).toEqual({ dev: 1 });
    expect(p.dummies.postgres).toBe(true); // untouched default survives the merge
  });

  it("refuses the default kind context", () => {
    expect(() => buildProfile({ ...base, kubeContext: "kind-kind" }, "local")).toThrow(/kind-kind/);
  });

  it("refuses insecureLocal off kind", () => {
    expect(cloud({ insecureLocal: true })).toThrow(/insecureLocal/);
  });

  it("requires a license for enterprise", () => {
    expect(() => buildProfile({ ...base, edition: "enterprise" }, "local")).toThrow(/licensePem/);
    const p = buildProfile({ ...base, edition: "enterprise" }, "local", { licensePem: pulumi.secret("x") });
    expect(p.edition).toBe("enterprise");
  });

  it("requires github config + secret when auth.type=github", () => {
    expect(() => buildProfile({ ...base, auth: { type: "github" } }, "local")).toThrow(/teleport:github/);
    const gh = { clientId: "id", organization: "org", teamsToRoles: [{ team: "eng", roles: ["requester"] }] };
    expect(() => buildProfile({ ...base, auth: { type: "github" }, github: gh }, "local")).toThrow(/githubClientSecret/);
    const p = buildProfile({ ...base, auth: { type: "github" }, github: gh }, "local", ghSecret);
    expect(p.github?.display).toBe("GitHub");
  });

  it("cloud platforms default to loadbalancer + cert-manager and reject nodeport", () => {
    const p = cloud()();
    expect(p.exposure.type).toBe("loadbalancer");
    expect(p.tls.mode).toBe("cert-manager");
    expect(cloud({ exposure: { type: "nodeport" } })).toThrow(/nodeport/);
    expect(cloud({ tls: { mode: "local-files" } })).toThrow(/local-files .* platform=kind/);
  });

  it("local users may hold editor/auditor locally but every role must exist", () => {
    const p = buildProfile({ ...base, users: [{ name: "admin", roles: ["editor", "auditor"] }, { name: "bob", roles: ["requester", "approver"] }] }, "local");
    expect(p.users.map((u) => u.name)).toEqual(["admin", "bob"]);
    expect(() => buildProfile({ ...base, users: [{ name: "x", roles: ["dba"] }] }, "local")).toThrow(/unknown role "dba"/);
    expect(() => buildProfile({ ...base, users: [{ name: "x", roles: ["svc-teleport-mcp"] }] }, "local")).toThrow(/unknown role/);
    expect(() => buildProfile({ ...base, auth: { type: "github" }, github: { ...github, teamsToRoles: [{ team: "t", roles: ["cluster-admin"] }] } }, "local", ghSecret)).toThrow(/unknown role "cluster-admin"/);
  });
});

describe("invariants off the local stack", () => {
  const envBackup = process.env.TELEPORT_ALLOW_KIND_CONTEXT;
  afterEach(() => {
    if (envBackup === undefined) delete process.env.TELEPORT_ALLOW_KIND_CONTEXT;
    else process.env.TELEPORT_ALLOW_KIND_CONTEXT = envBackup;
  });

  it("a compliant dev and prod stack build", () => {
    expect(cloud()().env).toBe("dev");
    expect(prod()().chartMode.mode).toBe("aws");
  });

  it("no standing editor/access for local users or SSO teams", () => {
    expect(cloud({ users: [{ name: "admin", roles: ["editor", "auditor"] }] })).toThrow(/standing admin role\(s\) editor/);
    expect(cloud({ users: [{ name: "ops", roles: ["access"] }] })).toThrow(/standing admin role\(s\) access/);
    expect(cloud({ github: { ...github, teamsToRoles: [{ team: "admins", roles: ["requester", "editor"] }] } })).toThrow(/teamsToRoles\[admins\] maps to standing admin role\(s\) editor/);
    expect(cloud({ users: [{ name: "auditor", roles: ["auditor", "requester"] }] })).not.toThrow();
  });

  it("local auth, local logins and otp are refused", () => {
    expect(cloud({ auth: { type: "local", localAuth: false, secondFactors: ["webauthn"] } })).toThrow(/auth.type=local is only allowed on env=local/);
    expect(cloud({ auth: { type: "github", localAuth: true, secondFactors: ["webauthn"] } })).toThrow(/auth.localAuth must be false/);
    expect(cloud({ auth: { type: "github", localAuth: false, secondFactors: ["webauthn", "otp"] } })).toThrow(/secondFactors must not include otp/);
  });

  it("prod refuses the standalone backend and dummy resources", () => {
    expect(prod({ chartMode: { mode: "standalone" } })).toThrow(/env=prod requires a managed backend/);
    expect(prod({ dummies: { enabled: true } })).toThrow(/env=prod must not deploy dummy resources/);
  });

  it("a kind- context off kind is refused unless TELEPORT_ALLOW_KIND_CONTEXT=1", () => {
    delete process.env.TELEPORT_ALLOW_KIND_CONTEXT;
    expect(cloud({ kubeContext: "kind-teleport-local" })).toThrow(/must not target the kind context/);
    process.env.TELEPORT_ALLOW_KIND_CONTEXT = "1";
    expect(cloud({ kubeContext: "kind-teleport-local" })).not.toThrow();
    // the escape hatch also tolerates the missing GitHub client secret of a CI preview (connector is skipped), nothing else
    expect(() => buildProfile({ ...cloudOk, kubeContext: "kind-teleport-local" }, "dev-eks", {})).not.toThrow();
    expect(() => buildProfile({ ...cloudOk, kubeContext: "kind-teleport-local", auth: { type: "github", localAuth: true, secondFactors: ["webauthn"] } }, "dev-eks", {})).toThrow(/localAuth/);
  });

  it("the harness bot is kind-only", () => {
    expect(cloud({ services: { ...cloudOk.services, harness: { enabled: true } } })).toThrow(/services.harness .* may only be enabled on platform=kind/);
  });

  it("the chat agent fails closed: email domains off kind, Slack workspace ids with the slack adapter", () => {
    expect(cloud({ services: { agent: { enabled: true, adapters: ["slack"], allowedEmailDomains: [], slackAllowedTeamIds: ["T1"] } } })).toThrow(/allowedEmailDomains must be non-empty/);
    expect(cloud({ services: { agent: { enabled: true, adapters: ["slack"], allowedEmailDomains: ["example.com"], slackAllowedTeamIds: [] } } })).toThrow(/slackAllowedTeamIds must be non-empty/);
    expect(cloud({ services: { agent: { enabled: true, adapters: ["teams"], allowedEmailDomains: ["example.com"], slackAllowedTeamIds: [] } } })).not.toThrow();
    // on kind a slack adapter without workspace ids is still refused
    expect(() => buildProfile({ ...base, services: { agent: { enabled: true, adapters: ["slack"] } } }, "local")).toThrow(/slackAllowedTeamIds/);
  });

  it("an internet-facing load balancer needs source ranges", () => {
    expect(cloud({ exposure: { type: "loadbalancer", internal: false, sourceRanges: [] } })).toThrow(/requires non-empty sourceRanges/);
    expect(cloud({ exposure: { type: "loadbalancer", internal: false, sourceRanges: ["203.0.113.0/24"] } })).not.toThrow();
    expect(cloud({ exposure: { type: "loadbalancer", internal: true, sourceRanges: [] } })).not.toThrow();
  });

  it("prod pins every deployed image by digest and never pulls Always", () => {
    expect(prod({ images: { ...prodOk.images, digests: { "teleport-access": ZERO_DIGEST } } })).toThrow(/images.digests\["access-agent"\]/);
    expect(prod({ images: { ...prodOk.images, digests: {} } })).toThrow(/images.digests\["teleport-access"\]/);
    expect(prod({ images: { ...prodOk.images, pullPolicy: "Always" } })).toThrow(/pullPolicy IfNotPresent/);
    expect(prod({ images: { ...prodOk.images, digests: { ...prodOk.images.digests, "access-agent": "sha256:nope" } } })).toThrow(/sha256/);
  });
});
