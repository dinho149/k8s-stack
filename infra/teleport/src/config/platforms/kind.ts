import type { DeepPartial } from "../../lib/merge";
import type { StackConfigInput } from "../schema";

/** Defaults for a local kind cluster. Stack config (Pulumi.local.yaml) overrides these. */
export const kindDefaults: DeepPartial<StackConfigInput> = {
  env: "local",
  clusterName: "teleport.127.0.0.1.nip.io",
  publicAddr: "teleport.127.0.0.1.nip.io:3080",
  edition: "community",
  exposure: { type: "nodeport", nodePort: 30380 }, // 30080 belongs to the Dogfood gateway (Envoy)
  // Browser-trusted certificate from mkcert (make tls / make up); self-signed when the files are absent.
  tls: { mode: "local-files", certFile: "../../.dogfood/teleport/tls/teleport.crt", keyFile: "../../.dogfood/teleport/tls/teleport.key", caFile: "../../.dogfood/teleport/tls/ca.crt" },
  auth: { type: "github", secondFactors: ["otp"], localAuth: true },
  chartMode: { mode: "standalone", volumeSize: "2Gi" },
  images: { registry: "", tag: "dev", pullPolicy: "IfNotPresent" },
  insecureLocal: true,
  dummies: { enabled: true, sshNodes: { dev: 2, prod: 1 }, postgres: true, mysql: false, httpbin: true, cloudStandin: "static" },
  services: { mcp: { enabled: true }, broker: { enabled: true, force: false }, agent: { enabled: false, adapters: ["cli"], auth: "api-key", persistSessions: false }, harness: { enabled: true },
    // Dogfood's local guest sign-in is subject `local-developer` (-> alice); `username` lets TELEPORT_LOCAL_SUBJECT=bob switch the demo identity.
    portal: { enabled: true, identities: { "local-developer": "alice" }, identityFallback: "username" } },
};
