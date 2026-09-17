/**
 * TeleportCluster — the teleport-cluster Helm chart (auth + proxy + operator) plus the
 * pieces the chart cannot express for us: the namespace, the license secret, and on kind a
 * NodePort Service so the proxy is reachable on the host without a LoadBalancer.
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { EnvProfile } from "../config/profile";
import { installChart } from "../lib/helm";
import { k8sLabels } from "../lib/labels";

export interface TeleportClusterArgs {
  profile: EnvProfile;
}

/** Pure function: chart values for a profile. Unit-tested in test/cluster-values.test.ts. */
export function renderClusterValues(p: EnvProfile): Record<string, unknown> {
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
    operator: { enabled: true, installCRDs: "always" },
    authentication: {
      type: p.auth.type,
      connectorName: p.auth.type === "github" ? (p.auth.connectorName ?? "github") : (p.auth.connectorName ?? ""),
      localAuth: p.auth.localAuth,
      secondFactors: p.auth.secondFactors,
      ...(p.auth.webauthnRpId ? { webauthn: { rpId: p.auth.webauthnRpId } } : {}),
    },
    log: { level: "INFO", format: "json" },
    highAvailability: { replicaCount: 1 },
    extraLabels: { deployment: { stack: p.stack }, pod: { stack: p.stack } },
  };

  // --- exposure
  switch (p.exposure.type) {
    case "nodeport":
      // The chart's own Service stays ClusterIP; TeleportCluster adds a NodePort Service.
      values.service = { type: "ClusterIP" };
      break;
    case "loadbalancer":
      values.service = {
        type: "LoadBalancer",
        annotations: p.exposure.annotations,
        ...(p.exposure.loadBalancerIP ? { spec: { loadBalancerIP: p.exposure.loadBalancerIP } } : {}),
      };
      break;
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
        replicaCount: 1,
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

    this.namespace = new k8s.core.v1.Namespace(
      `${name}-ns`,
      { metadata: { name: p.teleport.namespace, labels: k8sLabels(p, "teleport", "control-plane") } },
      child,
    );

    const deps: pulumi.Resource[] = [this.namespace];
    if (p.edition === "enterprise" && p.secrets.licensePem) {
      deps.push(
        new k8s.core.v1.Secret(
          `${name}-license`,
          { metadata: { name: "license", namespace: this.namespace.metadata.name }, stringData: { "license.pem": p.secrets.licensePem } },
          child,
        ),
      );
    }

    this.chart = installChart(
      `${name}-chart`,
      {
        chart: "teleport-cluster",
        version: p.teleport.version,
        namespace: this.namespace.metadata.name,
        releaseName: p.teleport.releaseName,
        values: renderClusterValues(p),
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
              { name: "tls", port: 443, targetPort: 3080, nodePort: p.exposure.nodePort, protocol: "TCP" },
              { name: "public", port: Number(p.publicAddr.split(":")[1] ?? 443), targetPort: 3080, protocol: "TCP" },
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
