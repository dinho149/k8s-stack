/**
 * Render the Teleport CRs (and Helm values) of a stack offline using Pulumi mocks, so they can be
 * linted with kubeconform / reviewed without a cluster.
 *   npm run render -- --stack local --out ../../tests/policy/rendered
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as pulumi from "@pulumi/pulumi";
import YAML from "yaml";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const stack = arg("--stack", "local");
const out = path.resolve(arg("--out", "../../tests/policy/rendered"));
fs.mkdirSync(out, { recursive: true });

// Load stack config from Pulumi.<stack>.yaml into the mock runtime.
const file = path.resolve(__dirname, "..", `Pulumi.${stack}.yaml`);
const cfg = (YAML.parse(fs.readFileSync(file, "utf8")).config ?? {}) as Record<string, unknown>;
const flat: Record<string, string> = {};
for (const [k, v] of Object.entries(cfg)) flat[k] = typeof v === "string" ? v : JSON.stringify(v);
if (stack !== "local") flat["teleport:kubeContext"] = flat["teleport:kubeContext"] ?? "render";

const manifests: Array<Record<string, unknown>> = [];
pulumi.runtime.setMocks(
  {
    newResource: (args) => {
      if (args.type.startsWith("kubernetes:resources.teleport.dev")) {
        manifests.push({ apiVersion: args.inputs.apiVersion, kind: args.inputs.kind, metadata: args.inputs.metadata, spec: args.inputs.spec });
      }
      if (args.type === "kubernetes:helm.sh/v4:Chart") {
        fs.writeFileSync(path.join(out, `helm-values-${args.name}.yaml`), YAML.stringify(args.inputs.values));
      }
      return { id: `${args.name}-id`, state: { ...args.inputs, metadata: { ...(args.inputs.metadata ?? {}), name: args.inputs.metadata?.name ?? args.name } } };
    },
    call: (args) => args.inputs,
  },
  "teleport",
  stack,
  false,
);
pulumi.runtime.setAllConfig(flat);

(async () => {
  await import("../index.js");
  await new Promise((r) => setTimeout(r, 500)); // let outputs settle
  for (const m of manifests) {
    const md = m.metadata as { name: string };
    fs.writeFileSync(path.join(out, `${(m.kind as string).toLowerCase()}-${md.name}.yaml`), YAML.stringify(m));
  }
  console.log(`rendered ${manifests.length} Teleport CRs for stack ${stack} into ${out}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
