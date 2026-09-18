import type { DeepPartial } from "../../lib/merge";
import type { StackConfigInput } from "../schema";

/** Defaults for an existing Amazon EKS cluster. Switch chartMode to `aws` for DynamoDB/S3 backends. */
export const eksDefaults: DeepPartial<StackConfigInput> = {
  edition: "community",
  exposure: {
    type: "loadbalancer",
    annotations: {
      "service.beta.kubernetes.io/aws-load-balancer-type": "external",
      "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type": "ip",
    },
  },
  tls: { mode: "cert-manager", issuerName: "letsencrypt", issuerKind: "ClusterIssuer" },
  auth: { type: "github", secondFactors: ["webauthn"], localAuth: false },
  chartMode: { mode: "standalone", storageClass: "gp3", volumeSize: "20Gi" },
  images: { registry: "ghcr.io/CHANGE-ME/k8s-teleport", tag: "latest", pullPolicy: "IfNotPresent" },
  insecureLocal: false,
  dummies: { enabled: false, sshNodes: { dev: 1, prod: 1 }, postgres: true, mysql: false, httpbin: true, cloudStandin: "static" },
  services: { mcp: { enabled: true }, broker: { enabled: true, force: false }, agent: { enabled: true, adapters: ["slack"], auth: "api-key", persistSessions: false } },
};
