/**
 * ImagePolicy — runtime supply-chain enforcement for cloud stacks (`images.verifySignatures: true`).
 *
 * A Kyverno ClusterPolicy admits into the four Teleport namespaces only pods whose images from our
 * registry carry a cosign keyless signature issued by GitHub Actions for the release workflow, and
 * rejects `:latest` / tagless images everywhere in those namespaces.
 *
 * Kyverno must already be installed in the cluster (https://kyverno.io/docs/installation/), the
 * CRD `clusterpolicies.kyverno.io` is not managed here. Never enabled on kind.
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { EnvProfile } from "../config/profile";
import { ACCESS_NAMESPACE, AGENT_NAMESPACE, DUMMIES_NAMESPACE } from "../policy/catalog";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const RELEASE_WORKFLOW = ".github/workflows/release-images.yml";

/** `ghcr.io/<org>/<repo>[/...]` -> `https://github.com/<org>/<repo>/.github/workflows/release-images.yml@refs/.*` */
export function signerSubjectRegexp(p: EnvProfile): string {
  if (p.images.signerSubjectRegexp) return p.images.signerSubjectRegexp;
  const m = /^ghcr\.io\/([^/]+)\/([^/]+)/.exec(p.images.registry);
  if (!m) throw new Error(`images.verifySignatures needs images.signerSubjectRegexp when the registry (${p.images.registry || "(local)"}) is not ghcr.io/<org>/<repo>`);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^https://github\\.com/${esc(m[1])}/${esc(m[2])}/${esc(RELEASE_WORKFLOW)}@refs/.*$`;
}

/** Pure: the ClusterPolicy body (unit-tested). */
export function renderImagePolicy(p: EnvProfile): Record<string, unknown> {
  const namespaces = [p.teleport.namespace, ACCESS_NAMESPACE, AGENT_NAMESPACE, DUMMIES_NAMESPACE];
  const match = { any: [{ resources: { kinds: ["Pod"], namespaces } }] };
  return {
    apiVersion: "kyverno.io/v1",
    kind: "ClusterPolicy",
    metadata: { name: "k8s-teleport-images", labels: { "app.kubernetes.io/part-of": "k8s-teleport", "app.kubernetes.io/managed-by": "pulumi" } },
    spec: {
      validationFailureAction: "Enforce",
      background: false,
      failurePolicy: "Fail",
      webhookTimeoutSeconds: 30,
      rules: [
        {
          name: "verify-cosign-signature",
          match,
          verifyImages: [
            {
              imageReferences: [`${p.images.registry}/*`],
              required: true,
              mutateDigest: true,
              verifyDigest: true,
              attestors: [{ entries: [{ keyless: { issuer: GITHUB_OIDC_ISSUER, subjectRegExp: signerSubjectRegexp(p), rekor: { url: "https://rekor.sigstore.dev" } } }] }],
            },
          ],
        },
        {
          name: "disallow-latest",
          match,
          validate: {
            message: "images must not use the :latest tag",
            pattern: { spec: { "=(initContainers)": [{ image: "!*:latest" }], "=(ephemeralContainers)": [{ image: "!*:latest" }], containers: [{ image: "!*:latest" }] } },
          },
        },
        {
          name: "require-tag-or-digest",
          match,
          validate: {
            message: "images must be pinned to a tag or a digest",
            pattern: { spec: { "=(initContainers)": [{ image: "*:* | *@sha256:*" }], "=(ephemeralContainers)": [{ image: "*:* | *@sha256:*" }], containers: [{ image: "*:* | *@sha256:*" }] } },
          },
        },
      ],
    },
  };
}

export interface ImagePolicyArgs {
  profile: EnvProfile;
}

export class ImagePolicy extends pulumi.ComponentResource {
  public readonly policy: k8s.apiextensions.CustomResource;

  constructor(name: string, args: ImagePolicyArgs, opts?: pulumi.ComponentResourceOptions) {
    super("k8s-teleport:supplychain:ImagePolicy", name, {}, opts);
    this.policy = new k8s.apiextensions.CustomResource(`${name}-cluster-policy`, renderImagePolicy(args.profile) as k8s.apiextensions.CustomResourceArgs, { parent: this });
    this.registerOutputs({});
  }
}
