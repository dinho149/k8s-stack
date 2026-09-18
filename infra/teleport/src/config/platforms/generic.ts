import type { DeepPartial } from "../../lib/merge";
import type { StackConfigInput } from "../schema";

/** Defaults for any other Kubernetes cluster reachable through a kubeconfig context. */
export const genericDefaults: DeepPartial<StackConfigInput> = {
  edition: "community",
  exposure: { type: "loadbalancer", annotations: {} },
  tls: { mode: "acme", email: "CHANGE-ME@example.com" },
  auth: { type: "github", secondFactors: ["webauthn"], localAuth: false },
  chartMode: { mode: "standalone", volumeSize: "10Gi" },
  images: { registry: "ghcr.io/CHANGE-ME/k8s-teleport", tag: "latest", pullPolicy: "IfNotPresent" },
  insecureLocal: false,
  dummies: { enabled: false, sshNodes: {}, postgres: false, mysql: false, httpbin: false, cloudStandin: "none" },
  services: { mcp: { enabled: true }, broker: { enabled: true, force: false }, agent: { enabled: false, adapters: ["cli"], auth: "api-key", persistSessions: false } },
};
