import { describe, expect, it } from "vitest";
import { buildProfile } from "../src/config/profile";
import { renderClusterValues } from "../src/components/TeleportCluster";

const kind = buildProfile({ platform: "kind", kubeContext: "kind-teleport-local", version: "18.11.1", auth: { type: "local" } }, "local");
const cloudBase = { platform: "eks" as const, kubeContext: "eks-dev", env: "dev", clusterName: "t.example.com", publicAddr: "t.example.com:443", version: "18.11.1", auth: { type: "local" as const } };

describe("renderClusterValues", () => {
  it("kind: multiplex, ClusterIP service, standalone persistence, no hooks, operator with CRDs", () => {
    const v = renderClusterValues(kind) as any;
    expect(v.proxyListenerMode).toBe("multiplex");
    expect(v.service).toEqual({ type: "ClusterIP" });
    expect(v.persistence).toMatchObject({ enabled: true, volumeSize: "2Gi" });
    expect(v.validateConfigOnDeploy).toBe(false);
    expect(v.operator).toEqual({ enabled: true, installCRDs: "always" });
    expect(v.enterprise).toBe(false);
    expect(v.authentication).toMatchObject({ type: "local", localAuth: true, secondFactors: ["otp"] });
    expect(v.publicAddr).toEqual(["teleport.127.0.0.1.nip.io:3080"]);
  });

  it("loadbalancer + cert-manager", () => {
    const v = renderClusterValues(buildProfile(cloudBase, "dev-eks")) as any;
    expect(v.service.type).toBe("LoadBalancer");
    expect(v.service.annotations["service.beta.kubernetes.io/aws-load-balancer-type"]).toBe("external");
    expect(v.highAvailability.certManager).toMatchObject({ enabled: true, issuerName: "letsencrypt", issuerKind: "ClusterIssuer" });
    expect(v.authentication.secondFactors).toEqual(["webauthn", "otp"]);
  });

  it("acme + ingress", () => {
    const v = renderClusterValues(buildProfile({ ...cloudBase, tls: { mode: "acme", email: "ops@example.com" }, exposure: { type: "ingress", className: "nginx" } }, "dev-eks")) as any;
    expect(v.acme).toBe(true);
    expect(v.acmeEmail).toBe("ops@example.com");
    expect(v.ingress).toMatchObject({ enabled: true, spec: { ingressClassName: "nginx" } });
    expect(v.service).toEqual({ type: "ClusterIP" });
  });

  it("aws chartMode renders the aws block and IRSA annotation", () => {
    const v = renderClusterValues(
      buildProfile({ ...cloudBase, chartMode: { mode: "aws", region: "eu-west-1", backendTable: "tp-backend", auditLogTable: "tp-audit", sessionRecordingBucket: "tp-sessions", serviceAccountRoleArn: "arn:aws:iam::1:role/tp" } }, "dev-eks"),
    ) as any;
    expect(v.chartMode).toBe("aws");
    expect(v.aws).toMatchObject({ region: "eu-west-1", backendTable: "tp-backend", sessionRecordingBucket: "tp-sessions" });
    expect(v.annotations.serviceAccount["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::1:role/tp");
    expect(v.persistence).toBeUndefined();
  });

  it("github auth wires the connector name", () => {
    const gh = { clientId: "id", organization: "org", teamsToRoles: [{ team: "eng", roles: ["requester"] }] };
    const p = buildProfile({ ...cloudBase, auth: { type: "github" }, github: gh }, "dev-eks", { githubClientSecret: require("@pulumi/pulumi").secret("s") });
    const v = renderClusterValues(p) as any;
    expect(v.authentication).toMatchObject({ type: "github", connectorName: "github" });
  });
});

import { renderCorefile } from "../src/components/LocalDns";
describe("renderCorefile", () => {
  it("rewrites the public host and its subdomains to the proxy service", () => {
    const c = renderCorefile("teleport.127.0.0.1.nip.io", "teleport-cluster-nodeport.teleport.svc.cluster.local");
    expect(c).toContain("name regex (.*\\.)?teleport\\.127\\.0\\.0\\.1\\.nip\\.io teleport-cluster-nodeport.teleport.svc.cluster.local");
    expect(c).toContain("answer auto");
    expect(c).toContain("kubernetes cluster.local");
  });
});
