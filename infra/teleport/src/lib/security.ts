/**
 * security.ts — the one place that spells out how a hardened pod looks.
 *
 * Every container this project creates (tbot sidecars, MCP server, broker, chat agent, harness,
 * dummy SSH nodes, databases, demo apps) uses these contexts so that the `restricted`
 * Pod Security Standard can be enforced on the namespaces we own. Containers that must write
 * somewhere get an explicit emptyDir for that path instead of a writable root filesystem.
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/** distroless / chainguard `nonroot` uid; also used for our own images. */
export const NONROOT_UID = 65532;

export function hardenedPodSecurityContext(uid = NONROOT_UID): k8s.types.input.core.v1.PodSecurityContext {
  return {
    runAsNonRoot: true,
    runAsUser: uid,
    runAsGroup: uid,
    fsGroup: uid,
    fsGroupChangePolicy: "OnRootMismatch",
    seccompProfile: { type: "RuntimeDefault" },
  };
}

export function hardenedContainerSecurityContext(): k8s.types.input.core.v1.SecurityContext {
  return {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
    runAsNonRoot: true,
  };
}

/** Requests + limits in one place; CPU limits are mandatory (ResourceQuota requires them). */
export function resources(req: { cpu: string; memory: string }, lim: { cpu: string; memory: string }): k8s.types.input.core.v1.ResourceRequirements {
  return { requests: req, limits: lim };
}

/** Writable scratch volumes for a container with a read-only root filesystem. */
export function scratchVolumes(prefix: string, paths: string[], sizeLimit = "64Mi"): { volumes: k8s.types.input.core.v1.Volume[]; mounts: k8s.types.input.core.v1.VolumeMount[] } {
  const volumes: k8s.types.input.core.v1.Volume[] = [];
  const mounts: k8s.types.input.core.v1.VolumeMount[] = [];
  paths.forEach((p, i) => {
    const name = `${prefix}-scratch-${i}`;
    volumes.push({ name, emptyDir: { sizeLimit } });
    mounts.push({ name, mountPath: p });
  });
  return { volumes, mounts };
}

/**
 * Projected ServiceAccount token (short-lived, bound to the pod) for workloads that join Teleport
 * with the kubernetes method. Used instead of `automountServiceAccountToken`, which is off everywhere.
 */
export function projectedJoinTokenVolume(name = "join-sa-token", expirationSeconds = 600, audience?: string): k8s.types.input.core.v1.Volume {
  return { name, projected: { sources: [{ serviceAccountToken: { path: "join-sa-token", expirationSeconds, ...(audience ? { audience } : {}) } }] } };
}

/**
 * A projected volume that mimics the default `/var/run/secrets/kubernetes.io/serviceaccount` mount
 * (token + CA + namespace) with a short TTL, for the few pods that must call the Kubernetes API.
 */
export function projectedInClusterCredentialsVolume(name = "kube-api-credentials", expirationSeconds = 3600): k8s.types.input.core.v1.Volume {
  return {
    name,
    projected: {
      sources: [
        { serviceAccountToken: { path: "token", expirationSeconds } },
        { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
        { downwardAPI: { items: [{ path: "namespace", fieldRef: { fieldPath: "metadata.namespace" } }] } },
      ],
    },
  };
}
export const IN_CLUSTER_CREDENTIALS_PATH = "/var/run/secrets/kubernetes.io/serviceaccount";

export interface NamespaceGuardrailArgs {
  namespace: pulumi.Input<string>;
  /** hard caps for the whole namespace */
  quota: { pods: number; cpu: string; memory: string; cpuLimit: string; memoryLimit: string };
  /** LimitRange defaults applied to containers that do not declare resources (Helm chart pods) */
  containerDefaults?: { cpu: string; memory: string };
}

/** LimitRange + ResourceQuota for a namespace we own. */
export function namespaceGuardrails(name: string, args: NamespaceGuardrailArgs, opts: pulumi.CustomResourceOptions): pulumi.Resource[] {
  const def = args.containerDefaults ?? { cpu: "500m", memory: "512Mi" };
  const limitRange = new k8s.core.v1.LimitRange(
    `${name}-limits`,
    {
      metadata: { name: "defaults", namespace: args.namespace },
      spec: {
        limits: [
          { type: "Container", default: def, defaultRequest: { cpu: "10m", memory: "32Mi" }, max: { cpu: "4", memory: "4Gi" } },
          { type: "PersistentVolumeClaim", max: { storage: "10Gi" } },
        ],
      },
    },
    opts,
  );
  const quota = new k8s.core.v1.ResourceQuota(
    `${name}-quota`,
    {
      metadata: { name: "namespace-quota", namespace: args.namespace },
      spec: {
        hard: {
          pods: String(args.quota.pods),
          "requests.cpu": args.quota.cpu,
          "requests.memory": args.quota.memory,
          "limits.cpu": args.quota.cpuLimit,
          "limits.memory": args.quota.memoryLimit,
          // Nothing we deploy needs a LoadBalancer or NodePort in these namespaces.
          "services.loadbalancers": "0",
          "services.nodeports": "0",
        },
      },
    },
    opts,
  );
  return [limitRange, quota];
}
