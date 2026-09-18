/**
 * Runtime configuration for the access agent (environment variables, validated with zod).
 *
 * Fails closed: anything that would let a chat identity be guessed rather than verified is a
 * configuration error, not a warning.
 */
import * as fs from "node:fs";
import { z } from "zod";
import { MIN_SIGNING_KEY_BYTES } from "../identity/assertion.js";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

/** Every secret env var also accepts a `<NAME>_FILE` variant pointing at a file whose trimmed contents are the value. */
export const SECRET_ENV_VARS = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "TEAMS_APP_PASSWORD",
  "GCHAT_SERVICE_ACCOUNT_JSON",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "MCP_SHARED_TOKEN",
  "BROKER_API_TOKEN",
  "BROKER_WEBHOOK_SECRET",
  "IDENTITY_SIGNING_KEY",
] as const;

/** Identity strategies that derive a Teleport username from the email string alone. Never allowed for chat. */
export const GUESSING_STRATEGIES = ["email-local-part", "email-as-username"] as const;

export const ConfigSchema = z.object({
  /** api-key: Anthropic API + tool runner. subscription: headless Claude Code CLI on a Claude Pro/Max token. */
  CLAUDE_AUTH_MODE: z.enum(["api-key", "subscription"]).default("api-key"),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5"),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  /** From `claude setup-token` (one year, subscription-billed). Only used when CLAUDE_AUTH_MODE=subscription. */
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  /** Let the claude CLI fall back to the operator's own login (keychain) — CLI adapter only. */
  CLAUDE_ALLOW_LOCAL_LOGIN: bool,
  CLAUDE_CODE_PATH: z.string().default("claude"),
  CLAUDE_STATE_DIR: z.string().default("/var/lib/access-agent/claude"),
  CLAUDE_TURN_TIMEOUT_MS: z.coerce.number().int().default(300_000),

  MCP_URL: z.string().url().default("http://teleport-mcp.teleport-access.svc.cluster.local:8080/mcp"),
  MCP_SHARED_TOKEN: z.string().min(1),

  BROKER_URL: z.string().url().default("http://access-broker.teleport-access.svc.cluster.local:8081"),
  BROKER_API_TOKEN: z.string().default(""),
  BROKER_WEBHOOK_SECRET: z.string().default(""),

  /** HMAC key for per-request identity assertions to the MCP server and the broker (raw UTF-8 bytes). */
  IDENTITY_SIGNING_KEY: z.string().min(MIN_SIGNING_KEY_BYTES, `IDENTITY_SIGNING_KEY must be at least ${MIN_SIGNING_KEY_BYTES} bytes`),

  IDENTITY_STRATEGY: z.enum(["email-as-username", "email-local-part", "github-login", "trait-lookup"]).default("trait-lookup"),
  IDENTITY_MAP_FILE: z.string().optional(), // json: { "alice@example.com": "alice" }
  ALLOWED_EMAIL_DOMAINS: z.string().default(""), // comma separated; required for every chat adapter
  APPROVER_EMAILS: z.string().default(""),
  APPROVER_TELEPORT_ROLES: z.string().default("approver"),

  ADAPTERS: z.string().default("cli"), // comma separated: cli,slack,teams,gchat
  /** Internal listener: broker webhook + health/readiness. Reachable from the broker only (NetworkPolicy). */
  PORT: z.coerce.number().int().positive().max(65535).default(8082),
  /**
   * When set, chat webhooks (Teams /api/messages, Google Chat /gchat/events) are served on a SECOND listener
   * on this port and nothing else is; the internal routes are then not reachable on it and vice versa.
   */
  PUBLIC_PORT: z.coerce.number().int().positive().max(65535).optional(),
  PUBLIC_URL: z.string().optional(),

  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  /** Slack workspace ids the assistant serves; users from any other workspace (Slack Connect, guests) are refused. */
  SLACK_ALLOWED_TEAM_IDS: z.string().default(""),

  TEAMS_APP_ID: z.string().optional(),
  TEAMS_APP_PASSWORD: z.string().optional(),
  TEAMS_TENANT_ID: z.string().optional(),

  GCHAT_PROJECT_NUMBER: z.string().optional(),
  GCHAT_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GCHAT_MODE: z.enum(["http", "pubsub"]).default("http"),
  GCHAT_PUBSUB_SUBSCRIPTION: z.string().optional(),

  SESSION_BACKEND: z.enum(["memory", "file"]).default("memory"),
  SESSION_FILE: z.string().default("/var/lib/access-agent/sessions.json"),
  SESSION_MAX_TURNS: z.coerce.number().int().default(40),

  LOG_LEVEL: z.string().default("info"),
  LOG_PRETTY: bool,
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

/**
 * Resolves `<NAME>_FILE` indirections: when set, the file's trimmed contents become `<NAME>`.
 * Secrets are mounted as 0400 files in-cluster so they never sit in the pod spec or `/proc/<pid>/environ`.
 */
export function resolveSecretFiles(env: NodeJS.ProcessEnv, readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of SECRET_ENV_VARS) {
    const file = env[`${name}_FILE`];
    if (!file) continue;
    let value: string;
    try {
      value = readFile(file).trim();
    } catch (e) {
      throw new ConfigError(`invalid access-agent configuration: cannot read ${name}_FILE (${file}): ${(e as Error).message}`);
    }
    if (!value) throw new ConfigError(`invalid access-agent configuration: ${name}_FILE (${file}) is empty`);
    out[name] = value;
    delete out[`${name}_FILE`];
  }
  return out;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  const env = resolveSecretFiles(rawEnv);
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new ConfigError(`invalid access-agent configuration:\n${issues}`);
  }
  const c = parsed.data;
  const adapters = csv(c.ADAPTERS);
  const need = (cond: boolean, what: string) => {
    if (!cond) throw new ConfigError(`invalid access-agent configuration: ${what}`);
  };
  for (const a of adapters) need(["cli", "slack", "teams", "gchat"].includes(a), `unknown adapter ${a}`);
  if (c.PUBLIC_PORT !== undefined) need(c.PUBLIC_PORT !== c.PORT, "PUBLIC_PORT must differ from PORT (the public listener must not expose the internal routes)");
  if (c.CLAUDE_AUTH_MODE === "api-key") need(!!c.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY is required when CLAUDE_AUTH_MODE=api-key");
  else need(!!c.CLAUDE_CODE_OAUTH_TOKEN || c.CLAUDE_ALLOW_LOCAL_LOGIN, "CLAUDE_AUTH_MODE=subscription needs CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or CLAUDE_ALLOW_LOCAL_LOGIN=true");

  const chatAdapters = adapters.filter((a) => a !== "cli");
  if (chatAdapters.length) {
    need(csv(c.ALLOWED_EMAIL_DOMAINS).length > 0, `ALLOWED_EMAIL_DOMAINS must list at least one domain when a chat adapter is enabled (${chatAdapters.join(",")})`);
    need(!(GUESSING_STRATEGIES as readonly string[]).includes(c.IDENTITY_STRATEGY), `IDENTITY_STRATEGY=${c.IDENTITY_STRATEGY} derives Teleport usernames from email text and is not allowed with chat adapters; use trait-lookup or github-login with IDENTITY_MAP_FILE`);
  }
  if (adapters.includes("slack")) {
    need(!!c.SLACK_BOT_TOKEN, "SLACK_BOT_TOKEN is required for the slack adapter");
    need(!!c.SLACK_APP_TOKEN, "SLACK_APP_TOKEN is required for the slack adapter (Socket Mode)");
    need(csv(c.SLACK_ALLOWED_TEAM_IDS).length > 0, "SLACK_ALLOWED_TEAM_IDS must list at least one workspace id for the slack adapter");
  }
  if (adapters.includes("teams")) need(!!c.TEAMS_APP_ID && !!c.TEAMS_APP_PASSWORD && !!c.TEAMS_TENANT_ID, "TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_TENANT_ID are required for the teams adapter");
  if (adapters.includes("gchat")) need(!!c.GCHAT_PROJECT_NUMBER && !!c.GCHAT_SERVICE_ACCOUNT_JSON, "GCHAT_PROJECT_NUMBER and GCHAT_SERVICE_ACCOUNT_JSON are required for the gchat adapter");
  return c;
}

export function csv(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
