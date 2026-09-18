/**
 * LocalDns (kind only) — makes the Teleport *public* address resolve inside the cluster.
 *
 * On kind, teleport.127.0.0.1.nip.io resolves to 127.0.0.1, which from a pod is the pod itself.
 * Agents, tbot and the access services must nevertheless use the public address (the proxy
 * redirects unknown Host headers to the app launcher, and reverse tunnels are advertised on the
 * public address). A CoreDNS rewrite points the public host (and any app sub-domain) at the
 * proxy Service. In the cloud, real DNS does this and the component is not created.
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { EnvProfile } from "../config/profile";

export interface LocalDnsArgs {
  profile: EnvProfile;
  /** in-cluster Service DNS name that answers on the public port */
  targetService: string;
}

/** kind's default Corefile with our rewrite inserted. Exported for tests. */
export function renderCorefile(publicHost: string, targetService: string): string {
  // Regex-escape every metacharacter (not only dots) so a host name can never widen the rewrite.
  const escaped = publicHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `.:53 {
    errors
    health {
       lameduck 5s
    }
    ready
    rewrite stop {
       name regex (.*\\.)?${escaped} ${targetService}
       answer auto
    }
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
       ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf {
       max_concurrent 1000
    }
    cache 30 {
       disable success cluster.local
       disable denial cluster.local
    }
    loop
    reload
    loadbalance
}
`;
}

export class LocalDns extends pulumi.ComponentResource {
  public readonly patch: k8s.core.v1.ConfigMapPatch;

  constructor(name: string, args: LocalDnsArgs, opts?: pulumi.ComponentResourceOptions) {
    super("k8s-teleport:local:LocalDns", name, {}, opts);
    this.patch = new k8s.core.v1.ConfigMapPatch(
      `${name}-coredns`,
      {
        metadata: { name: "coredns", namespace: "kube-system", annotations: { "pulumi.com/patchForce": "true" } },
        data: { Corefile: renderCorefile(args.profile.teleport.publicHost, args.targetService) },
      },
      { parent: this },
    );
    this.registerOutputs({});
  }
}
