/**
 * Runtime configuration for the access agent (environment variables, validated with zod).
 */
import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

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

  IDENTITY_STRATEGY: z.enum(["email-as-username", "email-local-part", "github-login", "trait-lookup"]).default("email-local-part"),
  IDENTITY_MAP_FILE: z.string().optional(), // yaml/json: { "alice@example.com": "alice" }
  ALLOWED_EMAIL_DOMAINS: z.string().default(""), // comma separated; empty => any
  APPROVER_EMAILS: z.string().default(""),
  APPROVER_TELEPORT_ROLES: z.string().default("approver"),

  ADAPTERS: z.string().default("cli"), // comma separated: cli,slack,teams,gchat
  PORT: z.coerce.number().int().default(8082),
  PUBLIC_URL: z.string().optional(),

  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_MODE: z.enum(["socket", "http"]).default("socket"),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`invalid access-agent configuration:\n${issues}`);
  }
  const c = parsed.data;
  const adapters = csv(c.ADAPTERS);
  const need = (cond: boolean, what: string) => {
    if (!cond) throw new Error(`invalid access-agent configuration: ${what}`);
  };
  if (c.CLAUDE_AUTH_MODE === "api-key") need(!!c.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY is required when CLAUDE_AUTH_MODE=api-key");
  else need(!!c.CLAUDE_CODE_OAUTH_TOKEN || c.CLAUDE_ALLOW_LOCAL_LOGIN, "CLAUDE_AUTH_MODE=subscription needs CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or CLAUDE_ALLOW_LOCAL_LOGIN=true");
  if (adapters.includes("slack")) {
    need(!!c.SLACK_BOT_TOKEN, "SLACK_BOT_TOKEN is required for the slack adapter");
    if (c.SLACK_MODE === "socket") need(!!c.SLACK_APP_TOKEN, "SLACK_APP_TOKEN is required for Slack socket mode");
    else need(!!c.SLACK_SIGNING_SECRET, "SLACK_SIGNING_SECRET is required for Slack http mode");
  }
  if (adapters.includes("teams")) need(!!c.TEAMS_APP_ID && !!c.TEAMS_APP_PASSWORD && !!c.TEAMS_TENANT_ID, "TEAMS_APP_ID, TEAMS_APP_PASSWORD and TEAMS_TENANT_ID are required for the teams adapter");
  if (adapters.includes("gchat")) need(!!c.GCHAT_PROJECT_NUMBER && !!c.GCHAT_SERVICE_ACCOUNT_JSON, "GCHAT_PROJECT_NUMBER and GCHAT_SERVICE_ACCOUNT_JSON are required for the gchat adapter");
  return c;
}

export function csv(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
