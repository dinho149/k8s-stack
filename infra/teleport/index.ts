/**
 * Pulumi entrypoint. Everything is driven by the typed EnvProfile built from the stack config.
 *
 *   loadProfile()  ->  k8s Provider (explicit context)  ->  TeleportCluster
 *                  ->  AccessPolicy (roles, users, bots, tokens, GitHub SSO)
 *                  ->  DummyResources + TeleportKubeAgent
 *                  ->  AccessServices (MCP server, access broker, chat agent)
 *                  ->  EnterpriseAccess (only when edition=enterprise)
 */
import * as fs from "node:fs";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { loadProfile } from "./src/config/profile";
import { TeleportCluster } from "./src/components/TeleportCluster";
import { AccessPolicy } from "./src/components/AccessPolicy";
import { DummyResources } from "./src/components/DummyResources";
import { TeleportKubeAgent } from "./src/components/TeleportKubeAgent";
import { LocalDns } from "./src/components/LocalDns";
import { AccessServices } from "./src/components/AccessServices";
import { EnterpriseAccess } from "./src/components/EnterpriseAccess";

const profile = loadProfile();

const provider = new k8s.Provider("k8s", {
  context: profile.kubeContext,
  kubeconfig: profile.kubeconfig ? fs.readFileSync(profile.kubeconfig, "utf8") : undefined,
  enableServerSideApply: true,
});

const cluster = new TeleportCluster("teleport", { profile }, { provider });

const access = new AccessPolicy("access", { profile, cluster }, { provider, dependsOn: [cluster.chart] });

// kind only: make the public address resolve to the proxy from inside the cluster.
const localDns = profile.platform === "kind" ? new LocalDns("local-dns", { profile, targetService: `${cluster.proxyServiceName}.${profile.teleport.namespace}.svc.cluster.local` }, { provider, dependsOn: [cluster.chart] }) : undefined;
const agentDeps: pulumi.Resource[] = localDns ? [localDns.patch] : [];

const kubeAgent = new TeleportKubeAgent("kube-agent", { profile, cluster, token: access.tokens["kube-agent"] }, { provider, dependsOn: agentDeps });

const dummies = profile.dummies.enabled
  ? new DummyResources("dummies", { profile, cluster, sshToken: access.tokens["ssh-node"] }, { provider, dependsOn: agentDeps })
  : undefined;

const services = new AccessServices("access-services", { profile, cluster, access, dependsOn: agentDeps }, { provider });

// Enterprise: native Access Monitoring Rules + official chat plugins instead of the broker.
const enterprise = profile.edition === "enterprise" ? new EnterpriseAccess("enterprise-access", { profile, cluster }, { provider, dependsOn: [access] }) : undefined;
void enterprise;

export const stack = profile.stack;
export const platform = profile.platform;
export const edition = profile.edition;
export const kubeContext = profile.kubeContext;
export const clusterName = cluster.clusterName;
export const proxyAddr = cluster.proxyAddr;
export const webUrl = pulumi.interpolate`https://${cluster.proxyAddr}`;
export const githubCallbackUrl = pulumi.interpolate`https://${cluster.proxyAddr}/v1/webapi/github/callback`;
export const roleNames = access.roleNames;
export const kubeClusterName = `${profile.env}-${profile.platform}`;
export const dummySshHosts = dummies?.sshHosts ?? [];
export const dummyDatabases = dummies?.databases ?? [];
export const dummyApps = dummies?.apps ?? [];
void kubeAgent;
export const accessNamespace = services.namespace.metadata.name;
export const mcpSharedToken = pulumi.secret(services.mcpSharedToken);
export const brokerApiToken = pulumi.secret(services.brokerApiToken);
export const loginHint = pulumi.interpolate`./bin/tsh --insecure --proxy ${cluster.proxyAddr} login --auth ${profile.auth.type === "github" ? "github" : "local --user admin"}`;
