/**
 * DummyResources — things for Teleport to protect, so the access model can be exercised:
 *   - SSH servers: StatefulSet per env running the Teleport SSH service (kubernetes join, one
 *     ServiceAccount + join token per env, non-root)
 *   - PostgreSQL per env (postgres-dev, postgres-prod): TLS with a per-instance certificate, client
 *     certificate authentication against the Teleport database CA (no passwords on the wire)
 *   - MySQL (opt-in), same model
 *   - httpbin web app, and a static "fake cloud console" (or LocalStack, opt-in) as apps
 * Every resource carries env / tier / team labels; roles match on `env` only.
 *
 * Database authentication: Teleport connects to self-hosted databases with a client certificate
 * signed by its `db_client` CA (CN = database user). An init container fetches that CA from the proxy's
 * public `/webapi/auth/export?type=db-client` endpoint at pod start, and pg_hba / --ssl-ca point at it.
 * Nothing else can authenticate: the NetworkPolicies only admit the kube-agent, and even the kube-agent
 * has no password to present.
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";
import type { EnvProfile } from "../config/profile";
import { TeleportAppV3, TeleportDatabaseV3 } from "../crds";
import { k8sLabels, namespaceLabels, teleportLabels } from "../lib/labels";
import { hardenedContainerSecurityContext, hardenedPodSecurityContext, namespaceGuardrails, NONROOT_UID, projectedJoinTokenVolume, resources, scratchVolumes } from "../lib/security";
import { DUMMIES_NAMESPACE, sshNodeToken } from "../policy/catalog";
import type { TeleportCluster } from "./TeleportCluster";

export interface DummyResourcesArgs {
  profile: EnvProfile;
  cluster: TeleportCluster;
  /** ssh-node join token CRs keyed by env (from AccessPolicy.sshNodeTokens) */
  sshTokens: Record<string, pulumi.Resource>;
}

/** Image reference for one of our images: by digest when `images.digests[name]` is set, else by tag. */
export function imageRef(p: EnvProfile, name: string): string {
  const base = p.images.registry ? `${p.images.registry}/${name}` : `k8s-teleport/${name}`;
  const digest = p.images.digests[name];
  return digest ? `${base}@${digest}` : `${base}:${p.images.tag}`;
}

/** uid of the `dev` login user baked into deploy/images/ssh-node (useradd default). */
const SSH_NODE_UID = 1000;
const POSTGRES_UID = 999;
const MYSQL_UID = 999;
const NGINX_UNPRIVILEGED_UID = 101;
const CURL_IMAGE = "curlimages/curl:8.14.1";
/** where the fetched Teleport db_client CA lives inside the database pods */
const TELEPORT_DB_CA_DIR = "/tls-ca";

/** teleport.yaml for a dummy SSH node. */
export function renderSshNodeConfig(p: EnvProfile, env: string): string {
  const labels = teleportLabels(p, "compute", env === "prod" ? "platform" : "app", { role: "dummy-ssh" }, env);
  return [
    "version: v3",
    "teleport:",
    `  auth_server: ${p.teleport.inClusterAuthAddr}`,
    "  data_dir: /var/lib/teleport",
    "  join_params:",
    "    method: kubernetes",
    `    token_name: ${sshNodeToken(env).name}`,
    "  log:",
    "    output: stderr",
    "    severity: INFO",
    "    format:",
    "      output: json",
    "auth_service:",
    "  enabled: false",
    "proxy_service:",
    "  enabled: false",
    "ssh_service:",
    "  enabled: true",
    // The node runs as the `dev` user, so sessions can only ever run as `dev`; never create host users.
    "  disable_create_host_user: true",
    "  labels:",
    ...Object.entries(labels).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`),
    "  commands:",
    "    - name: hostname",
    "      command: [hostname]",
    "      period: 1m0s",
    "",
  ].join("\n");
}

/** pg_hba.conf: only TLS + Teleport client certificates from the network; scram on the local socket. */
export function renderPgHba(): string {
  return [
    "# local socket (init scripts, pg_isready): password auth",
    "local   all all                scram-sha-256",
    "# network: TLS with a client certificate signed by the Teleport db_client CA (CN = database user)",
    "hostssl all all 0.0.0.0/0      cert clientcert=verify-full",
    "hostssl all all ::/0           cert clientcert=verify-full",
    "host    all all all            reject",
    "",
  ].join("\n");
}

/** Shell for the init container that fetches the Teleport db_client CA from the proxy. */
export function renderCaFetchScript(p: EnvProfile): string {
  const url = `https://${p.teleport.inClusterProxyAddr}/webapi/auth/export?type=db-client`;
  const insecure = p.teleport.insecure ? " --insecure" : "";
  return [
    "set -eu",
    `out="${TELEPORT_DB_CA_DIR}/ca.crt"`,
    "for i in $(seq 1 120); do",
    `  if curl -fsS${insecure} --max-time 10 "${url}" -o "$out.tmp" && grep -q 'BEGIN CERTIFICATE' "$out.tmp"; then mv "$out.tmp" "$out"; chmod 0444 "$out"; echo "fetched Teleport db_client CA"; exit 0; fi`,
    '  echo "waiting for the Teleport proxy ($i)"; sleep 5',
    "done",
    'echo "could not fetch the Teleport db_client CA" >&2; exit 1',
    "",
  ].join("\n");
}

export class DummyResources extends pulumi.ComponentResource {
  public readonly namespace: k8s.core.v1.Namespace;
  public readonly databases: string[] = [];
  public readonly apps: string[] = [];
  public readonly sshHosts: string[] = [];

  constructor(name: string, args: DummyResourcesArgs, opts?: pulumi.ComponentResourceOptions) {
    super("k8s-teleport:dummies:DummyResources", name, {}, opts);
    const p = args.profile;
    const tpNs = args.cluster.namespace.metadata.name;
    const child = (deps: pulumi.Resource[] = []): pulumi.CustomResourceOptions => ({ parent: this, dependsOn: deps });

    // LocalStack needs root and a writable filesystem: it only fits `baseline`. Everything else is `restricted`.
    const pss = p.dummies.cloudStandin === "localstack" ? "baseline" : "restricted";
    this.namespace = new k8s.core.v1.Namespace(`${name}-ns`, { metadata: { name: DUMMIES_NAMESPACE, labels: namespaceLabels(p, "dummies", pss) } }, child());
    const ns = this.namespace.metadata.name;
    const nsDep = [this.namespace];
    namespaceGuardrails(name, { namespace: ns, quota: { pods: 20, cpu: "4", memory: "6Gi", cpuLimit: "12", memoryLimit: "12Gi" } }, child(nsDep));

    const caFetchInit = (): k8s.types.input.core.v1.Container => ({
      name: "fetch-teleport-db-ca",
      image: CURL_IMAGE,
      command: ["sh", "-c", renderCaFetchScript(p)],
      volumeMounts: [{ name: "teleport-db-ca", mountPath: TELEPORT_DB_CA_DIR }],
      securityContext: hardenedContainerSecurityContext(),
      resources: resources({ cpu: "10m", memory: "16Mi" }, { cpu: "100m", memory: "64Mi" }),
    });

    /** Self-signed server certificate whose SAN is the instance's Service DNS name (verify-full in the DB CR). */
    const serverCert = (svc: string) => {
      const fqdn = `${svc}.${DUMMIES_NAMESPACE}.svc.cluster.local`;
      const key = new tls.PrivateKey(`${name}-${svc}-key`, { algorithm: "ECDSA", ecdsaCurve: "P256" }, child());
      const cert = new tls.SelfSignedCert(
        `${name}-${svc}-cert`,
        {
          privateKeyPem: key.privateKeyPem,
          allowedUses: ["key_encipherment", "digital_signature", "server_auth"],
          subject: { commonName: fqdn, organization: "k8s-teleport dummies" },
          dnsNames: [svc, `${svc}.${DUMMIES_NAMESPACE}`, `${svc}.${DUMMIES_NAMESPACE}.svc`, fqdn],
          validityPeriodHours: 24 * 365,
          earlyRenewalHours: 24 * 30,
        },
        child(),
      );
      const secret = new k8s.core.v1.Secret(`${name}-${svc}-tls`, { metadata: { name: `${svc}-tls`, namespace: ns }, stringData: { "tls.crt": cert.certPem, "tls.key": key.privateKeyPem } }, child(nsDep));
      return { fqdn, cert, secret };
    };

    // ------------------------------------------------------------------ SSH servers
    if (Object.keys(p.dummies.sshNodes).length) {
      for (const [env, count] of Object.entries(p.dummies.sshNodes)) {
        if (count === 0) continue;
        const token = sshNodeToken(env);
        const labels = { ...k8sLabels(p, `ssh-${env}`, "ssh-node"), "app.kubernetes.io/part-of": "ssh-nodes", env };
        const sa = new k8s.core.v1.ServiceAccount(`${name}-ssh-${env}-sa`, { metadata: { name: token.serviceAccount.split(":")[1], namespace: ns, labels }, automountServiceAccountToken: false }, child(nsDep));
        const cm = new k8s.core.v1.ConfigMap(`${name}-ssh-${env}-config`, { metadata: { name: `ssh-${env}-config`, namespace: ns, labels }, data: { "teleport.yaml": renderSshNodeConfig(p, env) } }, child(nsDep));
        const svc = new k8s.core.v1.Service(`${name}-ssh-${env}-svc`, { metadata: { name: `ssh-${env}`, namespace: ns, labels }, spec: { clusterIP: "None", selector: { app: `ssh-${env}` }, ports: [{ name: "ssh", port: 3022 }] } }, child(nsDep));
        const scratch = scratchVolumes("ssh", ["/tmp", "/home/dev"]);
        const tokenDep = args.sshTokens[env];
        new k8s.apps.v1.StatefulSet(
          `${name}-ssh-${env}`,
          {
            metadata: { name: `ssh-${env}`, namespace: ns, labels },
            spec: {
              serviceName: svc.metadata.name,
              replicas: count,
              selector: { matchLabels: { app: `ssh-${env}` } },
              template: {
                metadata: { labels },
                spec: {
                  serviceAccountName: sa.metadata.name,
                  automountServiceAccountToken: false,
                  // Runs as the `dev` login user: a non-root Teleport SSH service can only start sessions as itself.
                  securityContext: hardenedPodSecurityContext(SSH_NODE_UID),
                  containers: [
                    {
                      name: "teleport",
                      image: imageRef(p, "ssh-node"),
                      imagePullPolicy: p.images.pullPolicy,
                      args: ["start", "-c", "/etc/teleport/teleport.yaml"],
                      env: [{ name: "KUBERNETES_TOKEN_PATH", value: "/var/run/secrets/tokens/join-sa-token" }],
                      ports: [{ name: "ssh", containerPort: 3022 }],
                      volumeMounts: [
                        { name: "config", mountPath: "/etc/teleport", readOnly: true },
                        { name: "join-sa-token", mountPath: "/var/run/secrets/tokens", readOnly: true },
                        { name: "data", mountPath: "/var/lib/teleport" },
                        ...scratch.mounts,
                      ],
                      securityContext: hardenedContainerSecurityContext(),
                      resources: resources({ cpu: "20m", memory: "64Mi" }, { cpu: "500m", memory: "256Mi" }),
                    },
                  ],
                  volumes: [{ name: "config", configMap: { name: cm.metadata.name } }, projectedJoinTokenVolume(), ...scratch.volumes],
                },
              },
              // The Teleport host identity lives in the data dir: persist it so a restarted pod keeps
              // its node UUID instead of registering a duplicate (which makes `tsh ssh host` ambiguous).
              volumeClaimTemplates: [{ metadata: { name: "data" }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "256Mi" } } } }],
            },
          },
          child([cm, svc, sa, ...(tokenDep ? [tokenDep] : []), args.cluster.chart]),
        );
        for (let i = 0; i < count; i++) this.sshHosts.push(`ssh-${env}-${i}`);
      }
    }

    // ------------------------------------------------------------------ PostgreSQL (one instance per env)
    if (p.dummies.postgres) {
      for (const env of ["dev", "prod"]) {
        const svcName = `postgres-${env}`;
        const labels = { ...k8sLabels(p, svcName, "database"), env };
        const { fqdn, cert, secret: tlsSecret } = serverCert(svcName);
        const password = new random.RandomPassword(`${name}-${svcName}-password`, { length: 32, special: false }, child()).result;
        const authSecret = new k8s.core.v1.Secret(`${name}-${svcName}-auth`, { metadata: { name: `${svcName}-auth`, namespace: ns, labels }, stringData: { POSTGRES_PASSWORD: password } }, child(nsDep));
        const cm = new k8s.core.v1.ConfigMap(
          `${name}-${svcName}-config`,
          {
            metadata: { name: `${svcName}-config`, namespace: ns, labels },
            data: {
              "pg_hba.conf": renderPgHba(),
              "01-roles.sql": [
                "CREATE ROLE app LOGIN;",
                "CREATE ROLE readonly LOGIN;",
                "CREATE DATABASE appdb OWNER app;",
                "\\connect appdb",
                "CREATE TABLE IF NOT EXISTS orders(id serial primary key, item text, qty int);",
                "INSERT INTO orders(item, qty) VALUES ('widget', 3), ('gadget', 7);",
                "GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;",
                "GRANT ALL ON ALL TABLES IN SCHEMA public TO app;",
                "",
              ].join("\n"),
            },
          },
          child(nsDep),
        );
        const scratch = scratchVolumes("pg", ["/var/run/postgresql", "/tmp"]);
        new k8s.apps.v1.StatefulSet(
          `${name}-${svcName}`,
          {
            metadata: { name: svcName, namespace: ns, labels },
            spec: {
              serviceName: svcName,
              replicas: 1,
              selector: { matchLabels: { app: svcName } },
              template: {
                metadata: { labels },
                spec: {
                  automountServiceAccountToken: false,
                  securityContext: hardenedPodSecurityContext(POSTGRES_UID),
                  initContainers: [caFetchInit()],
                  containers: [
                    {
                      name: "postgres",
                      image: "postgres:17",
                      args: ["-c", "ssl=on", "-c", "ssl_cert_file=/tls/tls.crt", "-c", "ssl_key_file=/tls/tls.key", "-c", `ssl_ca_file=${TELEPORT_DB_CA_DIR}/ca.crt`, "-c", "hba_file=/etc/postgresql/pg_hba.conf"],
                      env: [
                        { name: "POSTGRES_HOST_AUTH_METHOD", value: "scram-sha-256" },
                        { name: "POSTGRES_INITDB_ARGS", value: "--auth-host=scram-sha-256 --auth-local=scram-sha-256" },
                        { name: "POSTGRES_USER", value: "postgres" },
                        { name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: authSecret.metadata.name, key: "POSTGRES_PASSWORD" } } },
                        { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
                      ],
                      ports: [{ name: "postgres", containerPort: 5432 }],
                      volumeMounts: [
                        { name: "tls", mountPath: "/tls", readOnly: true },
                        { name: "teleport-db-ca", mountPath: TELEPORT_DB_CA_DIR, readOnly: true },
                        { name: "config", mountPath: "/etc/postgresql/pg_hba.conf", subPath: "pg_hba.conf", readOnly: true },
                        { name: "config", mountPath: "/docker-entrypoint-initdb.d/01-roles.sql", subPath: "01-roles.sql", readOnly: true },
                        { name: "data", mountPath: "/var/lib/postgresql/data" },
                        ...scratch.mounts,
                      ],
                      readinessProbe: { exec: { command: ["pg_isready", "-U", "postgres"] }, initialDelaySeconds: 5, periodSeconds: 5 },
                      securityContext: hardenedContainerSecurityContext(),
                      resources: resources({ cpu: "50m", memory: "128Mi" }, { cpu: "1", memory: "512Mi" }),
                    },
                  ],
                  volumes: [
                    { name: "tls", secret: { secretName: tlsSecret.metadata.name, defaultMode: 0o640 } },
                    { name: "teleport-db-ca", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
                    { name: "config", configMap: { name: cm.metadata.name } },
                    { name: "data", emptyDir: { sizeLimit: "1Gi" } },
                    ...scratch.volumes,
                  ],
                },
              },
            },
          },
          child([tlsSecret, cm, authSecret]),
        );
        new k8s.core.v1.Service(`${name}-${svcName}-svc`, { metadata: { name: svcName, namespace: ns, labels }, spec: { type: "ClusterIP", selector: { app: svcName }, ports: [{ name: "postgres", port: 5432, targetPort: 5432 }] } }, child(nsDep));
        new TeleportDatabaseV3(
          `${name}-db-${svcName}`,
          {
            name: svcName,
            namespace: tpNs,
            // The operator copies CR labels onto the Teleport resource: these ARE the RBAC labels.
            labels: teleportLabels(p, "data", env === "prod" ? "platform" : "app", { engine: "postgres" }, env),
            spec: {
              protocol: "postgres",
              uri: `${fqdn}:5432`,
              tls: { mode: "verify-full", ca_cert: cert.certPem, server_name: fqdn },
            },
          },
          child([args.cluster.chart]),
        );
        this.databases.push(svcName);
      }
    }

    // ------------------------------------------------------------------ MySQL (opt-in)
    if (p.dummies.mysql) {
      const svcName = "mysql-dev";
      const labels = { ...k8sLabels(p, svcName, "database"), env: "dev" };
      const { fqdn, cert, secret: tlsSecret } = serverCert(svcName);
      const rootPassword = new random.RandomPassword(`${name}-${svcName}-root-password`, { length: 32, special: false }, child()).result;
      const authSecret = new k8s.core.v1.Secret(`${name}-${svcName}-auth`, { metadata: { name: `${svcName}-auth`, namespace: ns, labels }, stringData: { MYSQL_ROOT_PASSWORD: rootPassword } }, child(nsDep));
      const cm = new k8s.core.v1.ConfigMap(
        `${name}-${svcName}-init`,
        {
          metadata: { name: `${svcName}-init`, namespace: ns, labels },
          // Teleport presents a client certificate with CN = database user; no password exists for `app`.
          data: { "01-users.sql": ["CREATE USER 'app'@'%' REQUIRE SUBJECT '/CN=app';", "GRANT ALL ON appdb.* TO 'app'@'%';", ""].join("\n") },
        },
        child(nsDep),
      );
      const scratch = scratchVolumes("mysql", ["/var/run/mysqld", "/tmp"]);
      new k8s.apps.v1.StatefulSet(
        `${name}-${svcName}`,
        {
          metadata: { name: svcName, namespace: ns, labels },
          spec: {
            serviceName: svcName,
            replicas: 1,
            selector: { matchLabels: { app: svcName } },
            template: {
              metadata: { labels },
              spec: {
                automountServiceAccountToken: false,
                securityContext: hardenedPodSecurityContext(MYSQL_UID),
                initContainers: [caFetchInit()],
                containers: [
                  {
                    name: "mysql",
                    image: "mysql:8.4",
                    args: ["--require-secure-transport=ON", "--ssl-cert=/tls/tls.crt", "--ssl-key=/tls/tls.key", `--ssl-ca=${TELEPORT_DB_CA_DIR}/ca.crt`],
                    env: [
                      { name: "MYSQL_ROOT_PASSWORD", valueFrom: { secretKeyRef: { name: authSecret.metadata.name, key: "MYSQL_ROOT_PASSWORD" } } },
                      { name: "MYSQL_DATABASE", value: "appdb" },
                    ],
                    ports: [{ name: "mysql", containerPort: 3306 }],
                    volumeMounts: [
                      { name: "tls", mountPath: "/tls", readOnly: true },
                      { name: "teleport-db-ca", mountPath: TELEPORT_DB_CA_DIR, readOnly: true },
                      { name: "init", mountPath: "/docker-entrypoint-initdb.d", readOnly: true },
                      { name: "data", mountPath: "/var/lib/mysql" },
                      ...scratch.mounts,
                    ],
                    securityContext: hardenedContainerSecurityContext(),
                    resources: resources({ cpu: "50m", memory: "256Mi" }, { cpu: "1", memory: "768Mi" }),
                  },
                ],
                volumes: [
                  { name: "tls", secret: { secretName: tlsSecret.metadata.name, defaultMode: 0o640 } },
                  { name: "teleport-db-ca", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
                  { name: "init", configMap: { name: cm.metadata.name } },
                  { name: "data", emptyDir: { sizeLimit: "2Gi" } },
                  ...scratch.volumes,
                ],
              },
            },
          },
        },
        child([tlsSecret, cm, authSecret]),
      );
      new k8s.core.v1.Service(`${name}-${svcName}-svc`, { metadata: { name: svcName, namespace: ns, labels }, spec: { type: "ClusterIP", selector: { app: svcName }, ports: [{ name: "mysql", port: 3306, targetPort: 3306 }] } }, child(nsDep));
      new TeleportDatabaseV3(
        `${name}-db-${svcName}`,
        { name: svcName, namespace: tpNs, labels: teleportLabels(p, "data", "app", { engine: "mysql" }, "dev"), spec: { protocol: "mysql", uri: `${fqdn}:3306`, tls: { mode: "verify-full", ca_cert: cert.certPem, server_name: fqdn } } },
        child([args.cluster.chart]),
      );
      this.databases.push(svcName);
    }

    // ------------------------------------------------------------------ HTTP apps
    const app = (
      appName: string,
      image: string,
      port: number,
      env: string,
      tier: "web" | "cloud",
      team: string,
      extra: { args?: string[]; configMap?: k8s.core.v1.ConfigMap; mountPath?: string; uid?: number; writable?: string[]; hardened?: boolean } = {},
    ) => {
      const labels = { ...k8sLabels(p, appName, "app"), env };
      const hardened = extra.hardened ?? true;
      const scratch = scratchVolumes(appName, extra.writable ?? []);
      new k8s.apps.v1.Deployment(
        `${name}-${appName}`,
        {
          metadata: { name: appName, namespace: ns, labels },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: appName } },
            template: {
              metadata: { labels },
              spec: {
                automountServiceAccountToken: false,
                ...(hardened ? { securityContext: hardenedPodSecurityContext(extra.uid ?? NONROOT_UID) } : {}),
                containers: [
                  {
                    name: appName,
                    image,
                    args: extra.args,
                    ports: [{ containerPort: port }],
                    resources: resources({ cpu: "10m", memory: "32Mi" }, { cpu: "500m", memory: hardened ? "128Mi" : "2Gi" }),
                    ...(hardened ? { securityContext: hardenedContainerSecurityContext() } : {}),
                    volumeMounts: [...(extra.configMap ? [{ name: "content", mountPath: extra.mountPath ?? "/usr/share/nginx/html", readOnly: true }] : []), ...scratch.mounts],
                  },
                ],
                volumes: [...(extra.configMap ? [{ name: "content", configMap: { name: extra.configMap.metadata.name } }] : []), ...scratch.volumes],
              },
            },
          },
        },
        child(extra.configMap ? [...nsDep, extra.configMap] : nsDep),
      );
      new k8s.core.v1.Service(`${name}-${appName}-svc`, { metadata: { name: appName, namespace: ns, labels }, spec: { type: "ClusterIP", selector: { app: appName }, ports: [{ port: 80, targetPort: port }] } }, child(nsDep));
      new TeleportAppV3(
        `${name}-app-${appName}`,
        {
          name: appName,
          namespace: tpNs,
          labels: teleportLabels(p, tier, team, {}, env),
          spec: {
            uri: `http://${appName}.${DUMMIES_NAMESPACE}.svc.cluster.local`,
            public_addr: `${appName}.${p.teleport.publicHost}`,
            insecure_skip_verify: p.teleport.insecure,
          },
        },
        child([args.cluster.chart]),
      );
      this.apps.push(appName);
    };

    if (p.dummies.httpbin) app("httpbin", "ghcr.io/mccutchen/go-httpbin:2.18.3", 8080, "dev", "web", "app");

    if (p.dummies.cloudStandin === "static") {
      const cm = new k8s.core.v1.ConfigMap(
        `${name}-cloud-console-html`,
        { metadata: { name: "cloud-console-html", namespace: ns, labels: k8sLabels(p, "cloud-console") }, data: { "index.html": FAKE_CONSOLE_HTML } },
        child(nsDep),
      );
      // the unprivileged nginx image listens on 8080 and keeps its pid/cache under /tmp
      app("cloud-console", "nginxinc/nginx-unprivileged:1.27-alpine", 8080, "prod", "cloud", "platform", { configMap: cm, uid: NGINX_UNPRIVILEGED_UID, writable: ["/tmp", "/var/cache/nginx"] });
    } else if (p.dummies.cloudStandin === "localstack") {
      // LocalStack needs root; it cannot run under the hardened contexts (namespace level drops to baseline above).
      app("localstack", "localstack/localstack:4.7", 4566, "prod", "cloud", "platform", { hardened: false });
    }

    this.registerOutputs({ databases: this.databases, apps: this.apps, sshHosts: this.sshHosts });
  }
}

const FAKE_CONSOLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Fake Cloud Console</title>
<style>body{font-family:system-ui,sans-serif;margin:3rem;background:#0f172a;color:#e2e8f0}h1{color:#38bdf8}.card{background:#1e293b;padding:1.5rem;border-radius:12px;max-width:40rem}code{color:#a5f3fc}</style></head>
<body><div class="card"><h1>Fake Cloud Console</h1><p>This stand-in represents a production cloud environment protected by Teleport Application Access.</p>
<p>You reached it through the Teleport proxy, so your identity, role and session are recorded in the audit log.</p>
<p>Labels: <code>env=prod tier=cloud team=platform</code> &mdash; requires the <code>prod-app</code> role.</p></div></body></html>`;
