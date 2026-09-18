/**
 * TeleportCluster — the teleport-cluster Helm chart (auth + proxy + operator) plus the
 * pieces the chart cannot express for us: the namespace, the license secret, and on kind a
 * NodePort Service so the proxy is reachable on the host without a LoadBalancer.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { EnvProfile } from "../config/profile";
import { installChart } from "../lib/helm";
import { k8sLabels, namespaceLabels } from "../lib/labels";
import { hardenedContainerSecurityContext, hardenedPodSecurityContext, NONROOT_UID } from "../lib/security";

export interface TeleportClusterArgs {
  profile: EnvProfile;
}

/** Ports the proxy and auth pods listen on (multiplex mode). Used by NetworkPolicies. */
export const PROXY_PORT = 3080;
export const AUTH_PORT = 3025;
/** Fixed nodePort of the in-cluster `public` port on kind, so no random node port is ever opened. */
export const PUBLIC_NODE_PORT = 30081;

/** Cloud-provider annotation that makes a LoadBalancer internal (not internet-facing). */
export function internalLoadBalancerAnnotations(platform: EnvProfile["platform"]): Record<string, string> {
  switch (platform) {
    case "eks":
      return { "service.beta.kubernetes.io/aws-load-balancer-scheme": "internal" };
    case "gke":
      return { "networking.gke.io/load-balancer-type": "Internal" };
    case "aks":
      return { "service.beta.kubernetes.io/azure-load-balancer-internal": "true" };
    default:
      return {};
  }
}

/** Name of the kubernetes.io/tls Secret that carries the mkcert certificate on kind (tls.mode=local-files). */
export const LOCAL_TLS_SECRET = "teleport-local-tls";

export interface LocalTlsFiles {
  cert: string;
  key: string;
  /** The issuing mkcert root: the proxy refuses a leaf whose chain it cannot verify locally. */
  ca: string;
  /** sha256 of certificate + CA PEM: annotates the proxy pods so a regenerated certificate rolls them. */
  checksum: string;
}

/** Where the chart mounts tls.existingSecretName; ca.crt lands there too. */
export const LOCAL_TLS_MOUNT = "/etc/teleport-tls";
/** Go reads every directory in SSL_CERT_DIR: the system bundle stays, the mkcert root is added. */
export const LOCAL_TLS_SSL_CERT_DIR = `/etc/ssl/certs:${LOCAL_TLS_MOUNT}`;

/**
 * Reads the PEM files of tls.mode=local-files (written by deploy/scripts/local-tls.sh). Returns undefined
 * for every other mode, and — with one warning — when either file is missing, so CI and machines without
 * mkcert keep deploying with the chart's self-signed certificate.
 */
export function readLocalTlsFiles(
  p: EnvProfile,
  projectRoot: string = path.resolve(__dirname, "..", ".."),
  warn: (msg: string) => void = (m) => pulumi.log.warn(m),
): LocalTlsFiles | undefined {
  if (p.tls.mode !== "local-files") return undefined;
  const files = [p.tls.certFile, p.tls.keyFile, p.tls.caFile].map((f) => path.resolve(projectRoot, f));
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    warn(`tls.mode=local-files: ${missing.join(", ")} not found — the proxy keeps its self-signed certificate (browser warning). Run: make tls`);
    return undefined;
  }
  const [cert, key, ca] = files.map((f) => fs.readFileSync(f, "utf8"));
  return { cert, key, ca, checksum: crypto.createHash("sha256").update(cert).update(ca).digest("hex") };
}

export interface ClusterValuesOptions {
  /** Set by the component when tls.mode=local-files and the PEM files exist. */
  tlsSecret?: { name: string; checksum: string };
}

/** Pure function: chart values for a profile. Unit-tested in test/cluster-values.test.ts. */
export function renderClusterValues(p: EnvProfile, opts: ClusterValuesOptions = {}): Record<string, unknown> {
  const replicaCount = p.platform === "kind" ? 1 : 2;
  const rpId = p.auth.webauthnRpId ?? p.teleport.publicHost;
  const values: Record<string, unknown> = {
    clusterName: p.clusterName,
    publicAddr: [p.publicAddr],
    proxyListenerMode: "multiplex",
    chartMode: p.chartMode.mode,
    enterprise: p.edition === "enterprise",
    licenseSecretName: "license",
    // Config-validation Jobs are Helm hooks; Pulumi's Chart resource does not run hooks.
    validateConfigOnDeploy: false,
    podSecurityPolicy: { enabled: false },
    operator: { enabled: true, installCRDs: "always", resources: { requests: { cpu: "20m", memory: "64Mi" }, limits: { cpu: "500m", memory: "256Mi" } } },
    authentication: {
      type: p.auth.type,
      connectorName: p.auth.type === "github" ? (p.auth.connectorName ?? "github") : (p.auth.connectorName ?? ""),
      localAuth: p.auth.localAuth,
      secondFactors: p.auth.secondFactors,
      // Integrity over availability: when the auth service cannot verify locks, sessions are refused.
      lockingMode: "strict",
    },
    // Recorded on the node and streamed synchronously to the auth service: a compromised node cannot
    // withhold or tamper with its own recording after the fact.
    sessionRecording: "node-sync",
    // Only accept PROXY protocol headers when a load balancer is configured to send them; any other
    // setting lets an in-cluster client spoof the source IP in the audit log.
    proxyProtocol: p.exposure.type === "loadbalancer" && p.exposure.proxyProtocol ? "on" : "off",
    auth: {
      // Merged into the auth pods' teleport.yaml (mustMergeOverwrite): these have no dedicated chart value.
      teleportConfig: {
        auth_service: {
          authentication: {
            // Explicit RP ID: the chart otherwise uses clusterName, which breaks WebAuthn when users reach
            // the cluster under publicAddr. Changing it invalidates registered WebAuthn devices.
            webauthn: { rp_id: rpId },
            // Every SSH/Kubernetes/database/app session needs a fresh MFA check, cluster-wide.
            // per-session MFA requires a WebAuthn/SSO factor: OTP-only stacks (kind) would lock every session out
            require_session_mfa: p.auth.secondFactors.includes("webauthn"),
          },
          disconnect_expired_cert: true,
          client_idle_timeout: "15m",
        },
      },
    },
    log: { level: "INFO", format: "json" },
    highAvailability: { replicaCount },
    // Non-root, read-only root filesystem: the only writable path Teleport needs is /var/lib/teleport,
    // which the chart mounts as a PVC (auth, standalone) or emptyDir (proxy, cloud backends).
    podSecurityContext: hardenedPodSecurityContext(NONROOT_UID),
    securityContext: hardenedContainerSecurityContext(),
    resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "2", memory: "2Gi" } },
    extraLabels: { deployment: { stack: p.stack }, pod: { stack: p.stack } },
  };

  // --- exposure
  switch (p.exposure.type) {
    case "nodeport":
      // The chart's own Service stays ClusterIP; TeleportCluster adds a NodePort Service.
      values.service = { type: "ClusterIP" };
      break;
    case "loadbalancer": {
      const spec: Record<string, unknown> = {};
      if (p.exposure.loadBalancerIP) spec.loadBalancerIP = p.exposure.loadBalancerIP;
      if (p.exposure.sourceRanges.length) spec.loadBalancerSourceRanges = p.exposure.sourceRanges;
      values.service = {
        type: "LoadBalancer",
        annotations: { ...(p.exposure.internal ? internalLoadBalancerAnnotations(p.platform) : {}), ...p.exposure.annotations },
        ...(Object.keys(spec).length ? { spec } : {}),
      };
      break;
    }
    case "ingress":
      values.service = { type: "ClusterIP" };
      values.ingress = {
        enabled: true,
        spec: { ingressClassName: p.exposure.className },
        annotations: p.exposure.annotations,
      };
      break;
  }

  // --- tls
  switch (p.tls.mode) {
    case "self-signed":
      break; // chart default: Teleport generates its own certificate
    case "acme":
      values.acme = true;
      values.acmeEmail = p.tls.email;
      break;
    case "cert-manager":
      values.highAvailability = {
        replicaCount,
        certManager: {
          enabled: true,
          issuerName: p.tls.issuerName,
          issuerKind: p.tls.issuerKind,
          issuerGroup: p.tls.issuerGroup,
        },
      };
      break;
    case "existing-secret":
      values.tls = { existingSecretName: p.tls.secretName };
      break;
    case "local-files":
      if (opts.tlsSecret) {
        values.tls = { existingSecretName: opts.tlsSecret.name };
        values.proxy = {
          // An existing TLS secret makes the proxy Deployment "replicable": the chart then defaults to
          // max(replicaCount, 2) pods unless the proxy override pins it.
          highAvailability: { replicaCount },
          // The chart only hashes its ConfigMap; hash the certificate too so a regenerated one restarts
          // the proxy instead of waiting for https_keypairs_reload_interval (12h).
          annotations: { pod: { "checksum/tls": opts.tlsSecret.checksum } },
          // The proxy verifies its own chain at startup ("unable to verify HTTPS certificate chain"):
          // trust the mkcert root from the mounted secret in addition to the system bundle.
          extraEnv: [{ name: "SSL_CERT_DIR", value: LOCAL_TLS_SSL_CERT_DIR }],
        };
      }
      break; // files missing: chart self-signed (readLocalTlsFiles already warned)
  }

  // --- backend
  switch (p.chartMode.mode) {
    case "standalone":
      values.persistence = {
        enabled: true,
        volumeSize: p.chartMode.volumeSize,
        ...(p.chartMode.storageClass ? { storageClassName: p.chartMode.storageClass } : {}),
      };
      break;
    case "aws":
      values.aws = {
        region: p.chartMode.region,
        backendTable: p.chartMode.backendTable,
        auditLogTable: p.chartMode.auditLogTable,
        auditLogMirrorOnStdout: p.chartMode.auditLogMirrorOnStdout,
        sessionRecordingBucket: p.chartMode.sessionRecordingBucket,
      };
      if (p.chartMode.serviceAccountRoleArn) {
        values.annotations = { serviceAccount: { "eks.amazonaws.com/role-arn": p.chartMode.serviceAccountRoleArn } };
      }
      break;
    case "gcp":
      values.gcp = {
        projectId: p.chartMode.projectId,
        backendTable: p.chartMode.backendTable,
        auditLogTable: p.chartMode.auditLogTable,
        sessionRecordingBucket: p.chartMode.sessionRecordingBucket,
        ...(p.chartMode.credentialSecretName ? { credentialSecretName: p.chartMode.credentialSecretName } : {}),
      };
      if (p.chartMode.workloadIdentityServiceAccount) {
        values.annotations = { serviceAccount: { "iam.gke.io/gcp-service-account": p.chartMode.workloadIdentityServiceAccount } };
      }
      break;
    case "azure":
      values.azure = {
        databaseHost: p.chartMode.databaseHost,
        databaseUser: p.chartMode.databaseUser,
        sessionRecordingStorageAccount: p.chartMode.sessionRecordingStorageAccount,
        auditLogStorageAccount: p.chartMode.auditLogStorageAccount,
        clientID: p.chartMode.clientID,
      };
      break;
  }
  return values;
}

export class TeleportCluster extends pulumi.ComponentResource {
  public readonly namespace: k8s.core.v1.Namespace;
  public readonly chart: k8s.helm.v4.Chart;
  public readonly clusterName: pulumi.Output<string>;
  public readonly proxyAddr: pulumi.Output<string>;
  public readonly inClusterProxyAddr: pulumi.Output<string>;
  public readonly inClusterAuthAddr: pulumi.Output<string>;
  /** Service name that answers on the public port inside the cluster (used by LocalDns on kind). */
  public readonly proxyServiceName: string;
  /** Selector labels of the proxy pods (from the chart's helpers). */
  public static proxySelector(releaseName: string): Record<string, string> {
    return { "app.kubernetes.io/name": "teleport-cluster", "app.kubernetes.io/instance": releaseName, "app.kubernetes.io/component": "proxy" };
  }

  constructor(name: string, args: TeleportClusterArgs, opts?: pulumi.ComponentResourceOptions) {
    super("k8s-teleport:cluster:TeleportCluster", name, {}, opts);
    const p = args.profile;
    const child: pulumi.CustomResourceOptions = { parent: this };

    // `baseline` rather than `restricted`: the chart's auth/proxy pods now run with the hardened
    // contexts above, so `restricted` should pass — flip the level once verified on your cluster
    // (kubectl warnings from the `warn: restricted` label show what would be rejected).
    this.namespace = new k8s.core.v1.Namespace(
      `${name}-ns`,
      { metadata: { name: p.teleport.namespace, labels: namespaceLabels(p, "teleport", "baseline", "control-plane") } },
      // The namespace holds the cluster state PVC (standalone) and every Teleport CR: never delete it by accident.
      { ...child, protect: true },
    );

    const deps: pulumi.Resource[] = [this.namespace];
    if (p.edition === "enterprise" && p.secrets.licensePem) {
      deps.push(
        new k8s.core.v1.Secret(
          `${name}-license`,
          { metadata: { name: "license", namespace: this.namespace.metadata.name }, stringData: { "license.pem": p.secrets.licensePem } },
          { ...child, protect: true },
        ),
      );
    }

    // kind: the mkcert certificate (make tls) becomes a kubernetes.io/tls Secret the chart mounts on the proxy.
    // Not protected: deploy/scripts/local-tls.sh regenerates it and the chart falls back to self-signed without it.
    const localTls = readLocalTlsFiles(p);
    let tlsSecret: ClusterValuesOptions["tlsSecret"];
    if (localTls) {
      deps.push(
        new k8s.core.v1.Secret(
          `${name}-local-tls`,
          {
            metadata: { name: LOCAL_TLS_SECRET, namespace: this.namespace.metadata.name, labels: k8sLabels(p, "teleport", "local-tls") },
            type: "kubernetes.io/tls",
            stringData: { "tls.crt": localTls.cert, "tls.key": localTls.key, "ca.crt": localTls.ca },
          },
          child,
        ),
      );
      tlsSecret = { name: LOCAL_TLS_SECRET, checksum: localTls.checksum };
    }

    this.chart = installChart(
      `${name}-chart`,
      {
        chart: "teleport-cluster",
        version: p.teleport.version,
        namespace: this.namespace.metadata.name,
        releaseName: p.teleport.releaseName,
        values: renderClusterValues(p, { tlsSecret }),
      },
      { parent: this, dependsOn: deps },
    );

    if (p.exposure.type === "nodeport") {
      new k8s.core.v1.Service(
        `${name}-nodeport`,
        {
          metadata: { name: `${p.teleport.releaseName}-nodeport`, namespace: this.namespace.metadata.name, labels: k8sLabels(p, "teleport", "proxy-nodeport") },
          spec: {
            type: "NodePort",
            selector: TeleportCluster.proxySelector(p.teleport.releaseName),
            ports: [
              // host:3080 -> nodePort -> proxy; and in-cluster <svc>:3080 for the CoreDNS rewrite of the public address
              { name: "tls", port: 443, targetPort: PROXY_PORT, nodePort: p.exposure.nodePort, protocol: "TCP" },
              // Explicit nodePort: without it Kubernetes would open a random node port for this entry too.
              { name: "public", port: Number(p.publicAddr.split(":")[1] ?? 443), targetPort: PROXY_PORT, nodePort: PUBLIC_NODE_PORT, protocol: "TCP" },
            ],
          },
        },
        { ...child, dependsOn: [this.chart] },
      );
    }

    this.proxyServiceName = p.exposure.type === "nodeport" ? `${p.teleport.releaseName}-nodeport` : p.teleport.releaseName;
    this.clusterName = pulumi.output(p.clusterName);
    this.proxyAddr = pulumi.output(p.publicAddr);
    this.inClusterProxyAddr = pulumi.output(p.teleport.inClusterProxyAddr);
    this.inClusterAuthAddr = pulumi.output(p.teleport.inClusterAuthAddr);
    this.registerOutputs({ clusterName: this.clusterName, proxyAddr: this.proxyAddr });
  }
}
