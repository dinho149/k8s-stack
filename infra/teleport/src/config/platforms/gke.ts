import type { DeepPartial } from "../../lib/merge";
import type { StackConfigInput } from "../schema";

/** Defaults for an existing GKE cluster. Switch chartMode to `gcp` for Firestore/GCS backends. */
export const gkeDefaults: DeepPartial<StackConfigInput> = {
  edition: "community",
  exposure: { type: "loadbalancer", annotations: { "cloud.google.com/l4-rbs": "enabled" } },
  tls: { mode: "cert-manager", issuerName: "letsencrypt", issuerKind: "ClusterIssuer" },
  auth: { type: "github", secondFactors: ["webauthn"], localAuth: false },
  chartMode: { mode: "standalone", storageClass: "standard-rwo", volumeSize: "20Gi" },
  images: { registry: "ghcr.io/CHANGE-ME/k8s-teleport", tag: "latest", pullPolicy: "IfNotPresent" },
  insecureLocal: false,
  dummies: { enabled: false, sshNodes: { dev: 1, prod: 1 }, postgres: true, mysql: false, httpbin: true, cloudStandin: "static" },
  services: { mcp: { enabled: true }, broker: { enabled: true, force: false }, agent: { enabled: true, adapters: ["gchat"], auth: "api-key", persistSessions: false } },
};
