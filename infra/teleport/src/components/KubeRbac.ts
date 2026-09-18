/**
 * KubeRbac — Kubernetes RBAC for the groups the catalog hands out through `kubernetes_groups`.
 * No catalog role uses `system:masters`; cluster-admin is a normal, auditable binding instead:
 *   k8s-teleport:cluster-admin -> ClusterRole cluster-admin      (k8s-admin)
 *   k8s-teleport:prod-viewer   -> ClusterRole view               (prod-k8s)
 *   k8s-teleport:dev           -> ClusterRole edit in the dummies namespace (dev-k8s)
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { EnvProfile } from "../config/profile";
import { DUMMIES_NAMESPACE, KUBE_GROUPS } from "../policy/catalog";

export interface KubeRbacArgs {
  profile: EnvProfile;
}

const RBAC_GROUP = "rbac.authorization.k8s.io";

export class KubeRbac extends pulumi.ComponentResource {
  public readonly clusterAdmin: k8s.rbac.v1.ClusterRoleBinding;
  public readonly prodViewer: k8s.rbac.v1.ClusterRoleBinding;
  public devEditors?: k8s.rbac.v1.RoleBinding;
  private readonly labels: Record<string, string>;

  constructor(name: string, args: KubeRbacArgs, opts?: pulumi.ComponentResourceOptions) {
    super("k8s-teleport:access:KubeRbac", name, {}, opts);
    this.labels = { ...args.profile.labels };
    const bind = (group: string, clusterRole: string) =>
      new k8s.rbac.v1.ClusterRoleBinding(
        `${name}-${group}`,
        {
          metadata: { name: group, labels: this.labels },
          roleRef: { apiGroup: RBAC_GROUP, kind: "ClusterRole", name: clusterRole },
          subjects: [{ apiGroup: RBAC_GROUP, kind: "Group", name: group }],
        },
        { parent: this },
      );
    this.clusterAdmin = bind(KUBE_GROUPS.clusterAdmin, "cluster-admin");
    this.prodViewer = bind(KUBE_GROUPS.prodViewer, "view");
    this.registerOutputs({});
  }

  /**
   * Bind `k8s-teleport:dev` to ClusterRole `edit` inside the dummies namespace. Called once that
   * namespace exists (DummyResources creates it after AccessPolicy), so the binding is never applied
   * to a namespace that is not there yet.
   */
  bindDevEditors(namespace: pulumi.Input<string> = DUMMIES_NAMESPACE, dependsOn: pulumi.Resource[] = []): k8s.rbac.v1.RoleBinding {
    this.devEditors ??= new k8s.rbac.v1.RoleBinding(
      `kube-rbac-${KUBE_GROUPS.dev}`,
      {
        metadata: { name: KUBE_GROUPS.dev, namespace, labels: this.labels },
        roleRef: { apiGroup: RBAC_GROUP, kind: "ClusterRole", name: "edit" },
        subjects: [{ apiGroup: RBAC_GROUP, kind: "Group", name: KUBE_GROUPS.dev }],
      },
      { parent: this, dependsOn },
    );
    return this.devEditors;
  }
}
