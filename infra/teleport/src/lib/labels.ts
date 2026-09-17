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
