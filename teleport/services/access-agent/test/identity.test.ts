import { describe, expect, it } from "vitest";
import { IdentityResolver } from "../src/identity/resolver.js";
import { ConfigSchema } from "../src/config/schema.js";
import type { BrokerClient } from "../src/broker/client.js";

const KEY = "0123456789abcdef0123456789abcdef"; // gitleaks:allow (fixed test vector, not a credential)
const base = ConfigSchema.parse({ ANTHROPIC_API_KEY: "k", MCP_SHARED_TOKEN: "t", IDENTITY_SIGNING_KEY: KEY, ALLOWED_EMAIL_DOMAINS: "example.com" });
const slackUser = (email: string | null, verified = true) => ({ platform: "slack" as const, platformUserId: "U1", displayName: "x", email, emailVerified: verified });

describe("IdentityResolver", () => {
  it("trait-lookup by default: asks the broker which Teleport user carries the email trait", async () => {
    const broker = { userByEmail: async (e: string) => (e === "alice@example.com" ? "alice-tp" : null) } as unknown as BrokerClient;
    const r = new IdentityResolver(base, broker);
    expect(await r.resolve(slackUser("Alice@Example.com"))).toEqual({ teleportUser: "alice-tp", email: "alice@example.com", platform: "slack", platformUserId: "U1" });
    await expect(r.resolve(slackUser("nobody@example.com"))).rejects.toThrow(/no Teleport user carries/);
    await expect(new IdentityResolver(base).resolve(slackUser("alice@example.com"))).rejects.toThrow(/not configured/);
  });
  it("email-local-part / email-as-username only when explicitly configured (cli-only deployments)", async () => {
    expect((await new IdentityResolver({ ...base, IDENTITY_STRATEGY: "email-local-part" }).resolve(slackUser("Alice@Example.com"))).teleportUser).toBe("alice");
    expect((await new IdentityResolver({ ...base, IDENTITY_STRATEGY: "email-as-username" }).resolve(slackUser("alice@example.com"))).teleportUser).toBe("alice@example.com");
  });
  it("fails closed without a verified email, outside allowed domains, or with no allow-list at all", async () => {
    const r = new IdentityResolver(base);
    await expect(r.resolve(slackUser(null))).rejects.toThrow(/verified email/);
    await expect(r.resolve(slackUser("a@b.com", false))).rejects.toThrow(/verified email/);
    await expect(r.resolve(slackUser("a@evil.com"))).rejects.toThrow(/not allowed/);
    await expect(r.resolve(slackUser("a@example.com.evil.com"))).rejects.toThrow(/not allowed/);
    const noDomains = new IdentityResolver({ ...base, ALLOWED_EMAIL_DOMAINS: "", IDENTITY_STRATEGY: "email-local-part" });
    await expect(noDomains.resolve(slackUser("bob@attacker.example"))).rejects.toThrow(/not allowed/);
  });
  it("cli users are trusted as-is and carry the cli platform", async () => {
    const r = new IdentityResolver(base);
    expect(await r.resolve({ platform: "cli", platformUserId: "bob", displayName: "bob", email: null, emailVerified: true })).toEqual({ teleportUser: "bob", email: null, platform: "cli", platformUserId: "bob" });
  });
});
