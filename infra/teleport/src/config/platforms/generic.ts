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
  services: { mcp: { enabled: true }, broker: { enabled: true, force: false }, agent: { enabled: false, adapters: ["cli"], auth: "api-key", persistSessions: false },
    // Teleport usernames are GitHub logins (the Backstage GitHub sign-in yields the same login). Set services.portal.backstage
    // ({ namespace, podLabels: { app: "dogfood-backstage" } }) in the stack config to open the portal API to the Backstage backend.
    portal: { enabled: true, identities: {}, identityFallback: "username" } },
};
