import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/schema.js";

const base = { MCP_SHARED_TOKEN: "t" };
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
