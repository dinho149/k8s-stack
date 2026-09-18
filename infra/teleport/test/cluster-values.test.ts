import { describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { buildProfile } from "../src/config/profile";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { internalLoadBalancerAnnotations, readLocalTlsFiles, renderClusterValues } from "../src/components/TeleportCluster";

const kind = buildProfile({ platform: "kind", kubeContext: "kind-dogfood-local", version: "18.11.1", auth: { type: "local" } }, "local");
const github = { clientId: "id", organization: "org", teamsToRoles: [{ team: "eng", roles: ["requester"] }] };
const cloudSecrets = { githubClientSecret: pulumi.secret("s") };
const cloudBase = {
  platform: "eks" as const,
  kubeContext: "eks-dev",
  env: "dev",
  clusterName: "t.example.com",
  publicAddr: "t.example.com:443",
  version: "18.11.1",
  auth: { type: "github" as const, localAuth: false, secondFactors: ["webauthn" as const] },
  github,
  services: { agent: { allowedEmailDomains: ["example.com"], slackAllowedTeamIds: ["T123"] } },
};
const cloud = (extra: Record<string, unknown> = {}, stack = "dev-eks") => buildProfile({ ...cloudBase, ...extra }, stack, cloudSecrets);

describe("renderClusterValues", () => {
  it("kind: multiplex, ClusterIP service, standalone persistence, no hooks, operator with CRDs", () => {
    const v = renderClusterValues(kind) as any;
    expect(v.proxyListenerMode).toBe("multiplex");
    expect(v.service).toEqual({ type: "ClusterIP" });
    expect(v.persistence).toMatchObject({ enabled: true, volumeSize: "2Gi" });
    expect(v.validateConfigOnDeploy).toBe(false);
    expect(v.operator).toMatchObject({ enabled: true, installCRDs: "always" });
    expect(v.enterprise).toBe(false);
    expect(v.authentication).toMatchObject({ type: "local", localAuth: true, secondFactors: ["otp"] });
    expect(v.publicAddr).toEqual(["teleport.127.0.0.1.nip.io:3080"]);
    expect(v.highAvailability.replicaCount).toBe(1);
  });

  it("session hardening: strict locking, node-sync recording, session MFA, idle timeout, expired-cert disconnect", () => {
    for (const p of [kind, cloud()]) {
      const v = renderClusterValues(p) as any;
      expect(v.authentication.lockingMode).toBe("strict");
      expect(v.sessionRecording).toBe("node-sync");
      const auth = v.auth.teleportConfig.auth_service;
      // per-session MFA needs WebAuthn: on for the cloud profile (webauthn), off for kind (otp-only test users)
      expect(auth.authentication.require_session_mfa).toBe(p.auth.secondFactors.includes("webauthn"));
      expect(auth.disconnect_expired_cert).toBe(true);
      expect(auth.client_idle_timeout).toBe("15m");
    }
  });

  it("webauthn rp_id is always explicit: publicHost by default, auth.webauthnRpId when set", () => {
    expect((renderClusterValues(kind) as any).auth.teleportConfig.auth_service.authentication.webauthn.rp_id).toBe("teleport.127.0.0.1.nip.io");
    expect((renderClusterValues(cloud()) as any).auth.teleportConfig.auth_service.authentication.webauthn.rp_id).toBe("t.example.com");
    expect((renderClusterValues(cloud({ auth: { ...cloudBase.auth, webauthnRpId: "example.com" } })) as any).auth.teleportConfig.auth_service.authentication.webauthn.rp_id).toBe("example.com");
  });

  it("proxyProtocol is off unless the load balancer is declared to send it", () => {
    expect((renderClusterValues(kind) as any).proxyProtocol).toBe("off");
    expect((renderClusterValues(cloud()) as any).proxyProtocol).toBe("off");
    expect((renderClusterValues(cloud({ exposure: { type: "loadbalancer", proxyProtocol: true, sourceRanges: ["10.0.0.0/8"] } })) as any).proxyProtocol).toBe("on");
  });

  it("pods run non-root with a read-only root filesystem and dropped capabilities", () => {
    const v = renderClusterValues(kind) as any;
    expect(v.podSecurityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 65532, fsGroup: 65532, seccompProfile: { type: "RuntimeDefault" } });
    expect(v.securityContext).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] }, runAsNonRoot: true });
    expect(v.resources.limits.cpu).toBeDefined();
    expect(v.operator.resources.limits.cpu).toBeDefined();
  });

  it("loadbalancer + cert-manager: internal scheme, two replicas, no internet-facing annotation", () => {
    const v = renderClusterValues(cloud()) as any;
    expect(v.service.type).toBe("LoadBalancer");
    expect(v.service.annotations["service.beta.kubernetes.io/aws-load-balancer-type"]).toBe("external");
    expect(v.service.annotations["service.beta.kubernetes.io/aws-load-balancer-scheme"]).toBe("internal");
    expect(v.service.spec).toBeUndefined();
    expect(v.highAvailability).toMatchObject({ replicaCount: 2, certManager: { enabled: true, issuerName: "letsencrypt", issuerKind: "ClusterIssuer" } });
    expect(v.authentication).toMatchObject({ type: "github", connectorName: "github", localAuth: false, secondFactors: ["webauthn"] });
  });

  it("loadbalancer: sourceRanges become loadBalancerSourceRanges; internal=false drops the internal scheme", () => {
    const v = renderClusterValues(cloud({ exposure: { type: "loadbalancer", internal: false, sourceRanges: ["203.0.113.0/24", "198.51.100.0/24"] } })) as any;
    expect(v.service.spec.loadBalancerSourceRanges).toEqual(["203.0.113.0/24", "198.51.100.0/24"]);
    expect(v.service.annotations["service.beta.kubernetes.io/aws-load-balancer-scheme"]).toBeUndefined();
  });

  it("internal load balancer annotations per platform", () => {
    expect(internalLoadBalancerAnnotations("eks")).toEqual({ "service.beta.kubernetes.io/aws-load-balancer-scheme": "internal" });
    expect(internalLoadBalancerAnnotations("gke")).toEqual({ "networking.gke.io/load-balancer-type": "Internal" });
    expect(internalLoadBalancerAnnotations("aks")).toEqual({ "service.beta.kubernetes.io/azure-load-balancer-internal": "true" });
    expect(internalLoadBalancerAnnotations("kind")).toEqual({});
    const gke = renderClusterValues(cloud({ platform: "gke", kubeContext: "gke-dev" }, "dev-gke")) as any;
    expect(gke.service.annotations["networking.gke.io/load-balancer-type"]).toBe("Internal");
  });

  it("acme + ingress", () => {
    const v = renderClusterValues(cloud({ tls: { mode: "acme", email: "ops@example.com" }, exposure: { type: "ingress", className: "nginx" } })) as any;
    expect(v.acme).toBe(true);
    expect(v.acmeEmail).toBe("ops@example.com");
    expect(v.ingress).toMatchObject({ enabled: true, spec: { ingressClassName: "nginx" } });
    expect(v.service).toEqual({ type: "ClusterIP" });
  });

  it("aws chartMode renders the aws block, IRSA annotation and mirrors the audit log to stdout by default", () => {
    const v = renderClusterValues(cloud({ chartMode: { mode: "aws", region: "eu-west-1", backendTable: "tp-backend", auditLogTable: "tp-audit", sessionRecordingBucket: "tp-sessions", serviceAccountRoleArn: "arn:aws:iam::1:role/tp" } })) as any;
    expect(v.chartMode).toBe("aws");
    expect(v.aws).toMatchObject({ region: "eu-west-1", backendTable: "tp-backend", sessionRecordingBucket: "tp-sessions", auditLogMirrorOnStdout: true });
    expect(v.annotations.serviceAccount["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::1:role/tp");
    expect(v.persistence).toBeUndefined();
  });

  it("github auth wires the connector name", () => {
    const v = renderClusterValues(cloud()) as any;
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

describe("local-files TLS (mkcert on kind)", () => {
  it("renders nothing TLS-specific when the files are absent (chart self-signed)", () => {
    const v = renderClusterValues(kind) as any;
    expect(v.tls).toBeUndefined();
    expect(v.proxy).toBeUndefined();
  });

  it("mounts the secret, pins one proxy replica and hashes the certificate onto the proxy pods", () => {
    const v = renderClusterValues(kind, { tlsSecret: { name: "teleport-local-tls", checksum: "abc" } }) as any;
    expect(v.tls).toEqual({ existingSecretName: "teleport-local-tls" });
    // an existing secret makes the proxy "replicable": without this the chart runs max(replicaCount, 2) pods
    expect(v.proxy.highAvailability.replicaCount).toBe(1);
    expect(v.proxy.annotations.pod["checksum/tls"]).toBe("abc");
    // the proxy verifies its own chain at startup: the mounted ca.crt joins the system roots
    expect(v.proxy.extraEnv).toEqual([{ name: "SSL_CERT_DIR", value: "/etc/ssl/certs:/etc/teleport-tls" }]);
  });

  it("readLocalTlsFiles: both files -> cert/key/sha256; one missing -> undefined + one warning; other modes -> no fs access", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tls-"));
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(readLocalTlsFiles(kind, dir, warn)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/make tls/);
    fs.mkdirSync(path.join(dir, ".dogfood", "teleport", "tls"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".dogfood", "teleport", "tls", "teleport.crt"), "CERT");
    fs.writeFileSync(path.join(dir, ".dogfood", "teleport", "tls", "teleport.key"), "KEY");
    // kind default paths are relative to infra/teleport: "../../.dogfood/teleport/tls/..." resolves against projectRoot/../..
    const project = path.join(dir, "infra", "teleport");
    fs.mkdirSync(project, { recursive: true });
    expect(readLocalTlsFiles(kind, project, warn)).toBeUndefined(); // ca.crt still missing
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toMatch(/ca\.crt/);
    fs.writeFileSync(path.join(dir, ".dogfood", "teleport", "tls", "ca.crt"), "CA");
    const got = readLocalTlsFiles(kind, project, warn);
    expect(got).toMatchObject({ cert: "CERT", key: "KEY", ca: "CA" });
    expect(got?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(warnings).toHaveLength(2);
    expect(readLocalTlsFiles(cloud(), "/nonexistent", warn)).toBeUndefined();
    expect(warnings).toHaveLength(2);
  });
});
