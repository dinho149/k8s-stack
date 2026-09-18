/**
 * installChart — the single place we talk to Helm from Pulumi.
 *
 * Uses kubernetes.helm.v4.Chart (renders with the Helm SDK, registers every manifest as a
 * Pulumi child resource, awaits readiness, installs CRDs). Helm hooks are not executed, which
 * is fine for the Teleport charts once `validateConfigOnDeploy` is disabled. If a chart ever
 * needs hooks, swap the implementation below for helm.v3.Release — callers do not change.
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export const TELEPORT_HELM_REPO = "https://charts.releases.teleport.dev";

export interface ChartArgs {
  chart: string;
  version: string;
  namespace: pulumi.Input<string>;
  releaseName: string;
  values: pulumi.Inputs;
  repo?: string;
  skipCrds?: boolean;
}

export function installChart(name: string, args: ChartArgs, opts: pulumi.ComponentResourceOptions): k8s.helm.v4.Chart {
  return new k8s.helm.v4.Chart(
    name,
    {
      chart: args.chart,
      version: args.version,
      namespace: args.namespace,
      name: args.releaseName,
      repositoryOpts: { repo: args.repo ?? TELEPORT_HELM_REPO },
      values: args.values,
      skipCrds: args.skipCrds ?? false,
    },
    opts,
  );
}
