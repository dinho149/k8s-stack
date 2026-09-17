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
  options?: Record<string, unknown>;
  allow?: RoleConditions;
  deny?: RoleConditions;
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
    suggested_reviewers?: string[];
    thresholds?: Array<{ name?: string; approve?: number; deny?: number; filter?: string }>;
  };
  review_requests?: { roles?: string[]; preview_as_roles?: string[]; where?: string };
  impersonate?: { users?: string[]; roles?: string[] };
}
