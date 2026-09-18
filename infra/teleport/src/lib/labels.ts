import type { EnvProfile } from "../config/profile";

/** Labels every Kubernetes object and Teleport resource carries. */
export const TIERS = ["compute", "data", "platform", "web", "cloud", "access"] as const;
export type Tier = (typeof TIERS)[number];

export interface TeleportLabels {
  env: string;
  tier: Tier;
  team: string;
  "managed-by": "pulumi";
  [k: string]: string;
}

export function teleportLabels(profile: EnvProfile, tier: Tier, team: string, extra: Record<string, string> = {}, env = profile.env): TeleportLabels {
  return { env, tier, team, "managed-by": "pulumi", ...extra };
}

/** Kubernetes recommended labels for our own workloads. */
export function k8sLabels(profile: EnvProfile, app: string, component?: string): Record<string, string> {
  return {
    app,
    "app.kubernetes.io/name": app,
    "app.kubernetes.io/part-of": "k8s-teleport",
    "app.kubernetes.io/managed-by": "pulumi",
    ...(component ? { "app.kubernetes.io/component": component } : {}),
    env: profile.env,
    stack: profile.stack,
  };
}

/** Pod Security Standards levels (https://kubernetes.io/docs/concepts/security/pod-security-standards/). */
export type PssLevel = "privileged" | "baseline" | "restricted";

/**
 * Namespace labels: the recommended labels plus Pod Security Admission labels. `enforce` rejects
 * pods that violate the level; `audit` and `warn` are always `restricted` so that anything we
 * could tighten further shows up in the audit log and in kubectl warnings.
 */
export function namespaceLabels(profile: EnvProfile, app: string, enforce: PssLevel, component?: string): Record<string, string> {
  return {
    ...k8sLabels(profile, app, component),
    "pod-security.kubernetes.io/enforce": enforce,
    "pod-security.kubernetes.io/enforce-version": "latest",
    "pod-security.kubernetes.io/audit": "restricted",
    "pod-security.kubernetes.io/warn": "restricted",
  };
}
