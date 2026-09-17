/**
 * DummyResources — things for Teleport to protect, so the access model can be exercised:
 *   - SSH servers: StatefulSet per env running the Teleport SSH service (kubernetes join)
 *   - PostgreSQL (TLS, trust auth) registered as postgres-dev and postgres-prod
 *   - MySQL (opt-in)
 *   - httpbin web app, and a static "fake cloud console" (or LocalStack, opt-in) as apps
 * Every resource carries env / tier / team labels; roles match on `env` only.
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as tls from "@pulumi/tls";
import type { EnvProfile } from "../config/profile";
import { TeleportAppV3, TeleportDatabaseV3 } from "../crds";
import { k8sLabels, teleportLabels } from "../lib/labels";
import { DUMMIES_NAMESPACE, TOKENS } from "../policy/catalog";
import type { TeleportCluster } from "./TeleportCluster";

export interface DummyResourcesArgs {
  profile: EnvProfile;
  cluster: TeleportCluster;
  /** ssh-node join token CR */
  sshToken: pulumi.Resource;
}

export function imageRef(p: EnvProfile, name: string): string {
  return p.images.registry ? `${p.images.registry}/${name}:${p.images.tag}` : `k8s-teleport/${name}:${p.images.tag}`;
}

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
    `    token_name: ${TOKENS.sshNode.name}`,
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
    "  labels:",
    ...Object.entries(labels).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`),
    "  commands:",
    "    - name: hostname",
    "      command: [hostname]",
    "      period: 1m0s",
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

    this.namespace = new k8s.core.v1.Namespace(`${name}-ns`, { metadata: { name: DUMMIES_NAMESPACE, labels: k8sLabels(p, "dummies") } }, child());
    const ns = this.namespace.metadata.name;
    const nsDep = [this.namespace];

    // ------------------------------------------------------------------ SSH servers
    if (Object.keys(p.dummies.sshNodes).length) {
      const sa = new k8s.core.v1.ServiceAccount(`${name}-ssh-sa`, { metadata: { name: "ssh-node", namespace: ns, labels: k8sLabels(p, "ssh-node") } }, child(nsDep));
      for (const [env, count] of Object.entries(p.dummies.sshNodes)) {
        if (count === 0) continue;
        const labels = { ...k8sLabels(p, `ssh-${env}`, "ssh-node"), "app.kubernetes.io/part-of": "ssh-nodes", env };
        const cm = new k8s.core.v1.ConfigMap(`${name}-ssh-${env}-config`, { metadata: { name: `ssh-${env}-config`, namespace: ns, labels }, data: { "teleport.yaml": renderSshNodeConfig(p, env) } }, child(nsDep));
        const svc = new k8s.core.v1.Service(`${name}-ssh-${env}-svc`, { metadata: { name: `ssh-${env}`, namespace: ns, labels }, spec: { clusterIP: "None", selector: { app: `ssh-${env}` }, ports: [{ name: "ssh", port: 3022 }] } }, child(nsDep));
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
                  containers: [
                    {
                      name: "teleport",
                      image: imageRef(p, "ssh-node"),
                      imagePullPolicy: p.images.pullPolicy,
                      args: ["start", "-c", "/etc/teleport/teleport.yaml"],
                      volumeMounts: [
                        { name: "config", mountPath: "/etc/teleport", readOnly: true },
                        { name: "data", mountPath: "/var/lib/teleport" },
                      ],
                      resources: { requests: { cpu: "20m", memory: "64Mi" }, limits: { memory: "256Mi" } },
                    },
                  ],
                  volumes: [{ name: "config", configMap: { name: cm.metadata.name } }],
                },
              },
              // The Teleport host identity lives in the data dir: persist it so a restarted pod keeps
              // its node UUID instead of registering a duplicate (which makes `tsh ssh host` ambiguous).
              volumeClaimTemplates: [{ metadata: { name: "data" }, spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "256Mi" } } } }],
            },
          },
          child([cm, svc, sa, args.sshToken, args.cluster.chart]),
        );
        for (let i = 0; i < count; i++) this.sshHosts.push(`ssh-${env}-${i}`);
      }
    }

    // ------------------------------------------------------------------ PostgreSQL
    if (p.dummies.postgres) {
      const labels = k8sLabels(p, "postgres", "database");
      const key = new tls.PrivateKey(`${name}-pg-key`, { algorithm: "ECDSA", ecdsaCurve: "P256" }, child());
      const cert = new tls.SelfSignedCert(
        `${name}-pg-cert`,
        {
          privateKeyPem: key.privateKeyPem,
          allowedUses: ["key_encipherment", "digital_signature", "server_auth"],
          subject: { commonName: `postgres.${DUMMIES_NAMESPACE}.svc.cluster.local`, organization: "k8s-teleport dummies" },
          dnsNames: ["postgres", `postgres.${DUMMIES_NAMESPACE}`, `postgres.${DUMMIES_NAMESPACE}.svc`, `postgres.${DUMMIES_NAMESPACE}.svc.cluster.local`],
          validityPeriodHours: 24 * 365 * 5,
        },
        child(),
      );
      const tlsSecret = new k8s.core.v1.Secret(`${name}-pg-tls`, { metadata: { name: "postgres-tls", namespace: ns, labels }, stringData: { "tls.crt": cert.certPem, "tls.key": key.privateKeyPem } }, child(nsDep));
      const cm = new k8s.core.v1.ConfigMap(
        `${name}-pg-config`,
        {
          metadata: { name: "postgres-config", namespace: ns, labels },
          data: {
            // Dummy only: any user over TLS is trusted. Teleport still authenticates *people*; the DB does not.
            "pg_hba.conf": ["local   all all                trust", "hostssl all all 0.0.0.0/0      trust", "hostssl all all ::/0           trust", "host    all all all            reject", ""].join("\n"),
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
      new k8s.apps.v1.Deployment(
        `${name}-pg`,
        {
          metadata: { name: "postgres", namespace: ns, labels },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: "postgres" } },
            strategy: { type: "Recreate" },
            template: {
              metadata: { labels },
              spec: {
                securityContext: { fsGroup: 999 },
                containers: [
                  {
                    name: "postgres",
                    image: "postgres:17",
                    args: ["-c", "ssl=on", "-c", "ssl_cert_file=/tls/tls.crt", "-c", "ssl_key_file=/tls/tls.key", "-c", "hba_file=/etc/postgresql/pg_hba.conf"],
                    env: [
                      { name: "POSTGRES_HOST_AUTH_METHOD", value: "trust" },
                      { name: "POSTGRES_USER", value: "postgres" },
                      { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
                    ],
                    ports: [{ name: "postgres", containerPort: 5432 }],
                    volumeMounts: [
                      { name: "tls", mountPath: "/tls", readOnly: true },
                      { name: "config", mountPath: "/etc/postgresql/pg_hba.conf", subPath: "pg_hba.conf", readOnly: true },
                      { name: "config", mountPath: "/docker-entrypoint-initdb.d/01-roles.sql", subPath: "01-roles.sql", readOnly: true },
                      { name: "data", mountPath: "/var/lib/postgresql/data" },
                    ],
                    readinessProbe: { exec: { command: ["pg_isready", "-U", "postgres"] }, initialDelaySeconds: 5, periodSeconds: 5 },
                    resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "512Mi" } },
                  },
                ],
                volumes: [
                  { name: "tls", secret: { secretName: tlsSecret.metadata.name, defaultMode: 0o640 } },
                  { name: "config", configMap: { name: cm.metadata.name } },
                  { name: "data", emptyDir: {} },
                ],
              },
            },
          },
        },
        child([tlsSecret, cm]),
      );
      new k8s.core.v1.Service(`${name}-pg-svc`, { metadata: { name: "postgres", namespace: ns, labels }, spec: { selector: { app: "postgres" }, ports: [{ name: "postgres", port: 5432, targetPort: 5432 }] } }, child(nsDep));
      // One physical database, registered twice with different env labels (dev + prod stand-ins).
      for (const env of ["dev", "prod"]) {
        const dbName = `postgres-${env}`;
        new TeleportDatabaseV3(
          `${name}-db-${dbName}`,
          {
            name: dbName,
            namespace: tpNs,
            // The operator copies CR labels onto the Teleport resource: these ARE the RBAC labels.
            labels: teleportLabels(p, "data", env === "prod" ? "platform" : "app", { engine: "postgres" }, env),
            spec: {
              protocol: "postgres",
              uri: `postgres.${DUMMIES_NAMESPACE}.svc.cluster.local:5432`,
              tls: { mode: "insecure" },
            },
          },
          child([args.cluster.chart]),
        );
        this.databases.push(dbName);
      }
    }

    // ------------------------------------------------------------------ MySQL (opt-in)
    if (p.dummies.mysql) {
      const labels = k8sLabels(p, "mysql", "database");
      new k8s.apps.v1.Deployment(
        `${name}-mysql`,
        {
          metadata: { name: "mysql", namespace: ns, labels },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: "mysql" } },
            template: {
              metadata: { labels },
              spec: {
                containers: [
                  {
                    name: "mysql",
                    image: "mysql:8",
                    args: ["--require-secure-transport=ON"],
                    env: [{ name: "MYSQL_ALLOW_EMPTY_PASSWORD", value: "yes" }, { name: "MYSQL_DATABASE", value: "appdb" }],
                    ports: [{ containerPort: 3306 }],
                    resources: { requests: { cpu: "50m", memory: "256Mi" }, limits: { memory: "768Mi" } },
                  },
                ],
              },
            },
          },
        },
        child(nsDep),
      );
      new k8s.core.v1.Service(`${name}-mysql-svc`, { metadata: { name: "mysql", namespace: ns, labels }, spec: { selector: { app: "mysql" }, ports: [{ port: 3306 }] } }, child(nsDep));
      new TeleportDatabaseV3(
        `${name}-db-mysql-dev`,
        { name: "mysql-dev", namespace: tpNs, labels: teleportLabels(p, "data", "app", { engine: "mysql" }, "dev"), spec: { protocol: "mysql", uri: `mysql.${DUMMIES_NAMESPACE}.svc.cluster.local:3306`, tls: { mode: "insecure" } } },
        child([args.cluster.chart]),
      );
      this.databases.push("mysql-dev");
    }

    // ------------------------------------------------------------------ HTTP apps
    const app = (appName: string, image: string, port: number, env: string, tier: "web" | "cloud", team: string, extra: { args?: string[]; configMap?: k8s.core.v1.ConfigMap; mountPath?: string } = {}) => {
      const labels = k8sLabels(p, appName, "app");
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
                containers: [
                  {
                    name: appName,
                    image,
                    args: extra.args,
                    ports: [{ containerPort: port }],
                    resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "128Mi" } },
                    volumeMounts: extra.configMap ? [{ name: "content", mountPath: extra.mountPath ?? "/usr/share/nginx/html", readOnly: true }] : undefined,
                  },
                ],
                volumes: extra.configMap ? [{ name: "content", configMap: { name: extra.configMap.metadata.name } }] : undefined,
              },
            },
          },
        },
        child(extra.configMap ? [...nsDep, extra.configMap] : nsDep),
      );
      new k8s.core.v1.Service(`${name}-${appName}-svc`, { metadata: { name: appName, namespace: ns, labels }, spec: { selector: { app: appName }, ports: [{ port: 80, targetPort: port }] } }, child(nsDep));
      new TeleportAppV3(
        `${name}-app-${appName}`,
        {
          name: appName,
          namespace: tpNs,
          labels: teleportLabels(p, tier, team, {}, env),
          spec: {
            uri: `http://${appName}.${DUMMIES_NAMESPACE}.svc.cluster.local`,
            public_addr: `${appName}.${p.teleport.publicHost}`,
            insecure_skip_verify: true,
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
      app("cloud-console", "nginx:1.27-alpine", 80, "prod", "cloud", "platform", { configMap: cm });
    } else if (p.dummies.cloudStandin === "localstack") {
      app("localstack", "localstack/localstack:latest", 4566, "prod", "cloud", "platform");
    }

    this.registerOutputs({ databases: this.databases, apps: this.apps, sshHosts: this.sshHosts });
  }
}

const FAKE_CONSOLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Fake Cloud Console</title>
<style>body{font-family:system-ui,sans-serif;margin:3rem;background:#0f172a;color:#e2e8f0}h1{color:#38bdf8}.card{background:#1e293b;padding:1.5rem;border-radius:12px;max-width:40rem}code{color:#a5f3fc}</style></head>
<body><div class="card"><h1>Fake Cloud Console</h1><p>This stand-in represents a production cloud environment protected by Teleport Application Access.</p>
<p>You reached it through the Teleport proxy, so your identity, role and session are recorded in the audit log.</p>
<p>Labels: <code>env=prod tier=cloud team=platform</code> &mdash; requires the <code>prod-app</code> role.</p></div></body></html>`;
