import { describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { buildProfile } from "../src/config/profile";

const base = { platform: "kind" as const, kubeContext: "kind-teleport-local", version: "18.11.1", auth: { type: "local" as const } };

describe("buildProfile", () => {
  it("applies kind defaults and derives in-cluster addresses", () => {
    const p = buildProfile(base, "local");
    expect(p.clusterName).toBe("teleport.127.0.0.1.nip.io");
    expect(p.exposure).toEqual({ type: "nodeport", nodePort: 30080 });
    expect(p.teleport.inClusterAuthAddr).toBe("teleport-cluster-auth.teleport.svc.cluster.local:3025");
    expect(p.teleport.inClusterProxyAddr).toBe("teleport.127.0.0.1.nip.io:3080");
    expect(p.teleport.insecure).toBe(true);
    expect(p.labels).toEqual({ env: "local", "managed-by": "pulumi", stack: "local" });
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
    expect(() => buildProfile({ ...base, platform: "eks", kubeContext: "eks-dev", env: "dev", clusterName: "t.example.com", publicAddr: "t.example.com:443", insecureLocal: true }, "dev-eks")).toThrow(/insecureLocal/);
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
    const p = buildProfile({ ...base, auth: { type: "github" }, github: gh }, "local", { githubClientSecret: pulumi.secret("s") });
    expect(p.github?.display).toBe("GitHub");
  });

  it("cloud platforms default to loadbalancer + cert-manager and reject nodeport", () => {
    const cloud = { platform: "eks" as const, kubeContext: "eks-dev", env: "dev", clusterName: "t.example.com", publicAddr: "t.example.com:443", version: "18.11.1", auth: { type: "local" as const } };
    const p = buildProfile(cloud, "dev-eks");
    expect(p.exposure.type).toBe("loadbalancer");
    expect(p.tls.mode).toBe("cert-manager");
    expect(() => buildProfile({ ...cloud, exposure: { type: "nodeport" } }, "dev-eks")).toThrow(/nodeport/);
  });
});
