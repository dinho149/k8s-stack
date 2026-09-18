/**
 * Typed wrappers for the Teleport Kubernetes Operator CRDs we use.
 *
 * apiVersions were read from the teleport-operator 18.11.1 chart (operator-crds/):
 *   TeleportRoleV7 v1, TeleportUser v2, TeleportProvisionToken v2, TeleportBotV1 v1,
 *   TeleportGithubConnector v3, TeleportAppV3 v1, TeleportDatabaseV3 v1,
 *   TeleportAccessMonitoringRuleV1 v1, TeleportAccessList v1.
 * CRs must live in the operator's namespace (it only watches its own).
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const GROUP = "resources.teleport.dev";

export interface CRArgs {
  name: string;
  namespace: pulumi.Input<string>;
  spec: pulumi.Inputs;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

function cr(kind: string, version: string) {
  return class extends k8s.apiextensions.CustomResource {
    constructor(name: string, args: CRArgs, opts?: pulumi.CustomResourceOptions) {
      super(
        name,
        {
          apiVersion: `${GROUP}/${version}`,
          kind,
          metadata: { name: args.name, namespace: args.namespace, labels: args.labels, annotations: args.annotations },
          spec: args.spec,
        },
        opts,
      );
    }
  };
}

export const TeleportRoleV7 = cr("TeleportRoleV7", "v1");
export const TeleportUser = cr("TeleportUser", "v2");
export const TeleportProvisionToken = cr("TeleportProvisionToken", "v2");
export const TeleportBotV1 = cr("TeleportBotV1", "v1");
export const TeleportGithubConnector = cr("TeleportGithubConnector", "v3");
export const TeleportAppV3 = cr("TeleportAppV3", "v1");
export const TeleportDatabaseV3 = cr("TeleportDatabaseV3", "v1");
export const TeleportAccessMonitoringRuleV1 = cr("TeleportAccessMonitoringRuleV1", "v1");
export const TeleportAccessList = cr("TeleportAccessList", "v1");

/** Teleport role spec (v7) — only the fields this project uses. */
export interface RoleSpecV7 {
  options?: RoleOptions;
  allow?: RoleConditions;
  deny?: RoleConditions;
}
/** Role options this project sets (all verified against the TeleportRoleV7 CRD schema). */
export interface RoleOptions {
  max_session_ttl?: string;
  /** int-or-string in the CRD (never a YAML boolean): "yes" = per-session MFA, "hardware_key*" variants, "no" */
  require_session_mfa?: "yes" | "no" | "hardware_key" | "hardware_key_touch" | "hardware_key_pin" | "hardware_key_touch_and_pin";
  disconnect_expired_cert?: boolean;
  client_idle_timeout?: string;
  lock?: "strict" | "best_effort";
  pin_source_ip?: boolean;
  ssh_file_copy?: boolean;
  ssh_port_forwarding?: { local?: { enabled: boolean }; remote?: { enabled: boolean } };
  forward_agent?: boolean;
  create_host_user_mode?: "off" | "keep" | "insecure-drop";
  enhanced_recording?: string[];
  record_session?: { default?: string; ssh?: string; desktop?: boolean };
  [k: string]: unknown;
}
export interface RoleConditions {
  logins?: string[];
  node_labels?: Record<string, string[]>;
  db_labels?: Record<string, string[]>;
  db_users?: string[];
  db_names?: string[];
  kubernetes_labels?: Record<string, string[]>;
  kubernetes_groups?: string[];
  kubernetes_users?: string[];
  kubernetes_resources?: Array<{ kind: string; namespace?: string; name?: string; verbs?: string[] }>;
  app_labels?: Record<string, string[]>;
  rules?: Array<{ resources: string[]; verbs: string[]; where?: string }>;
  request?: {
    roles?: string[];
    search_as_roles?: string[];
    max_duration?: string;
    reason?: { mode: "required" | "optional" };
    suggested_reviewers?: string[];
    thresholds?: Array<{ name?: string; approve?: number; deny?: number; filter?: string }>;
  };
  review_requests?: { roles?: string[]; preview_as_roles?: string[]; where?: string };
  impersonate?: { users?: string[]; roles?: string[] };
}
