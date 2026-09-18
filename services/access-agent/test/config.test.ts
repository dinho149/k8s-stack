import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, resolveSecretFiles } from "../src/config/schema.js";

const KEY = "0123456789abcdef0123456789abcdef";
const base = { MCP_SHARED_TOKEN: "t", IDENTITY_SIGNING_KEY: KEY };
const slack = { ...base, ANTHROPIC_API_KEY: "k", ADAPTERS: "slack", SLACK_BOT_TOKEN: "xoxb", SLACK_APP_TOKEN: "xapp", SLACK_ALLOWED_TEAM_IDS: "T1", ALLOWED_EMAIL_DOMAINS: "example.com" };

describe("auth mode config", () => {
  it("api-key mode requires ANTHROPIC_API_KEY", () => {
    expect(() => loadConfig({ ...base })).toThrow(/ANTHROPIC_API_KEY/);
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: "k" }).CLAUDE_AUTH_MODE).toBe("api-key");
  });
  it("subscription mode requires a token or explicit local login", () => {
    expect(() => loadConfig({ ...base, CLAUDE_AUTH_MODE: "subscription" })).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(loadConfig({ ...base, CLAUDE_AUTH_MODE: "subscription", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x" }).CLAUDE_AUTH_MODE).toBe("subscription");
    expect(loadConfig({ ...base, CLAUDE_AUTH_MODE: "subscription", CLAUDE_ALLOW_LOCAL_LOGIN: "true" }).CLAUDE_ALLOW_LOCAL_LOGIN).toBe(true);
  });
  it("a stray token never switches an api-key deployment to the subscription", () => {
    const c = loadConfig({ ...base, ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x" });
    expect(c.CLAUDE_AUTH_MODE).toBe("api-key");
  });
});

describe("identity signing key", () => {
  it("is required and at least 32 bytes", () => {
    expect(() => loadConfig({ MCP_SHARED_TOKEN: "t", ANTHROPIC_API_KEY: "k" })).toThrow(/IDENTITY_SIGNING_KEY/);
    expect(() => loadConfig({ MCP_SHARED_TOKEN: "t", ANTHROPIC_API_KEY: "k", IDENTITY_SIGNING_KEY: "tooshort" })).toThrow(/32 bytes/);
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: "k" }).IDENTITY_SIGNING_KEY).toBe(KEY);
  });
});

describe("chat identity fails closed", () => {
  it("defaults to trait-lookup", () => {
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: "k" }).IDENTITY_STRATEGY).toBe("trait-lookup");
  });
  it("requires ALLOWED_EMAIL_DOMAINS for every chat adapter", () => {
    expect(() => loadConfig({ ...slack, ALLOWED_EMAIL_DOMAINS: "" })).toThrow(/ALLOWED_EMAIL_DOMAINS/);
    expect(() => loadConfig({ ...slack, ALLOWED_EMAIL_DOMAINS: " , " })).toThrow(/ALLOWED_EMAIL_DOMAINS/);
    expect(() => loadConfig({ ...base, ANTHROPIC_API_KEY: "k", ADAPTERS: "teams", TEAMS_APP_ID: "a", TEAMS_APP_PASSWORD: "p", TEAMS_TENANT_ID: "t" })).toThrow(/ALLOWED_EMAIL_DOMAINS/);
    expect(() => loadConfig({ ...base, ANTHROPIC_API_KEY: "k", ADAPTERS: "gchat", GCHAT_PROJECT_NUMBER: "1", GCHAT_SERVICE_ACCOUNT_JSON: "{}" })).toThrow(/ALLOWED_EMAIL_DOMAINS/);
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: "k", ADAPTERS: "cli" }).ALLOWED_EMAIL_DOMAINS).toBe(""); // cli only: no chat identity
    expect(loadConfig(slack).ALLOWED_EMAIL_DOMAINS).toBe("example.com");
  });
  it("forbids username-guessing strategies with chat adapters", () => {
    expect(() => loadConfig({ ...slack, IDENTITY_STRATEGY: "email-local-part" })).toThrow(/IDENTITY_STRATEGY=email-local-part/);
    expect(() => loadConfig({ ...slack, IDENTITY_STRATEGY: "email-as-username" })).toThrow(/IDENTITY_STRATEGY=email-as-username/);
    expect(loadConfig({ ...slack, IDENTITY_STRATEGY: "github-login" }).IDENTITY_STRATEGY).toBe("github-login");
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: "k", ADAPTERS: "cli", IDENTITY_STRATEGY: "email-local-part" }).IDENTITY_STRATEGY).toBe("email-local-part");
  });
  it("slack needs bot + app tokens (socket mode) and an allowed workspace list", () => {
    expect(() => loadConfig({ ...slack, SLACK_ALLOWED_TEAM_IDS: "" })).toThrow(/SLACK_ALLOWED_TEAM_IDS/);
    expect(() => loadConfig({ ...slack, SLACK_APP_TOKEN: undefined })).toThrow(/SLACK_APP_TOKEN/);
    expect(() => loadConfig({ ...slack, SLACK_BOT_TOKEN: undefined })).toThrow(/SLACK_BOT_TOKEN/);
    expect(() => loadConfig({ ...slack, SLACK_MODE: "http" })).not.toThrow(); // ignored: socket mode only
    expect(loadConfig(slack).SLACK_ALLOWED_TEAM_IDS).toBe("T1");
  });
  it("rejects unknown adapters", () => {
    expect(() => loadConfig({ ...base, ANTHROPIC_API_KEY: "k", ADAPTERS: "irc" })).toThrow(/unknown adapter irc/);
  });
});

describe("<NAME>_FILE secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-secrets-"));
  const write = (name: string, content: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, { mode: 0o400 });
    return p;
  };

  it("reads trimmed file contents for every secret variable", () => {
    const env = {
      MCP_SHARED_TOKEN_FILE: write("mcp", "mcp-token\n"),
      IDENTITY_SIGNING_KEY_FILE: write("key", `  ${KEY}\n`),
      ANTHROPIC_API_KEY_FILE: write("anthropic", "sk-ant\n"),
      BROKER_API_TOKEN_FILE: write("broker", "broker-token"),
      BROKER_WEBHOOK_SECRET_FILE: write("hook", "hook-secret\n\n"),
      CLAUDE_CODE_OAUTH_TOKEN_FILE: write("oauth", "sk-ant-oat"),
      SLACK_BOT_TOKEN_FILE: write("sbt", "xoxb"),
      SLACK_APP_TOKEN_FILE: write("sat", "xapp"),
      TEAMS_APP_PASSWORD_FILE: write("tap", "pw"),
      GCHAT_SERVICE_ACCOUNT_JSON_FILE: write("gsa", '{"type":"service_account"}\n'),
    };
    const resolved = resolveSecretFiles(env);
    expect(resolved).toMatchObject({ MCP_SHARED_TOKEN: "mcp-token", IDENTITY_SIGNING_KEY: KEY, ANTHROPIC_API_KEY: "sk-ant", BROKER_API_TOKEN: "broker-token", BROKER_WEBHOOK_SECRET: "hook-secret", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat", SLACK_BOT_TOKEN: "xoxb", SLACK_APP_TOKEN: "xapp", TEAMS_APP_PASSWORD: "pw", GCHAT_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}' });
    expect(resolved.MCP_SHARED_TOKEN_FILE).toBeUndefined();
    const cfg = loadConfig(env);
    expect(cfg.MCP_SHARED_TOKEN).toBe("mcp-token");
    expect(cfg.IDENTITY_SIGNING_KEY).toBe(KEY);
  });
  it("the file wins over an inline value and missing/empty files are configuration errors", () => {
    expect(resolveSecretFiles({ MCP_SHARED_TOKEN: "inline", MCP_SHARED_TOKEN_FILE: write("mcp2", "from-file") }).MCP_SHARED_TOKEN).toBe("from-file");
    expect(() => loadConfig({ ...base, ANTHROPIC_API_KEY: "k", MCP_SHARED_TOKEN_FILE: path.join(dir, "nope") })).toThrow(/cannot read MCP_SHARED_TOKEN_FILE/);
    expect(() => loadConfig({ ...base, ANTHROPIC_API_KEY: "k", MCP_SHARED_TOKEN_FILE: write("empty", "  \n") })).toThrow(/MCP_SHARED_TOKEN_FILE .* is empty/);
  });
});
