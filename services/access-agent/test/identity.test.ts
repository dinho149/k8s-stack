import { describe, expect, it } from "vitest";
import { IdentityResolver } from "../src/identity/resolver.js";
import { ConfigSchema } from "../src/config/schema.js";

const base = ConfigSchema.parse({ ANTHROPIC_API_KEY: "k", MCP_SHARED_TOKEN: "t" });
const slackUser = (email: string | null, verified = true) => ({ platform: "slack" as const, platformUserId: "U1", displayName: "x", email, emailVerified: verified });

describe("IdentityResolver", () => {
  it("email-local-part by default", async () => {
    const r = new IdentityResolver(base);
    expect((await r.resolve(slackUser("Alice@Example.com"))).teleportUser).toBe("alice");
  });
  it("email-as-username keeps the full address", async () => {
    const r = new IdentityResolver({ ...base, IDENTITY_STRATEGY: "email-as-username" });
    expect((await r.resolve(slackUser("alice@example.com"))).teleportUser).toBe("alice@example.com");
  });
  it("fails closed without a verified email or outside allowed domains", async () => {
    const r = new IdentityResolver({ ...base, ALLOWED_EMAIL_DOMAINS: "example.com" });
    await expect(r.resolve(slackUser(null))).rejects.toThrow(/verified email/);
    await expect(r.resolve(slackUser("a@b.com", false))).rejects.toThrow(/verified email/);
    await expect(r.resolve(slackUser("a@evil.com"))).rejects.toThrow(/not allowed/);
  });
  it("cli users are trusted as-is", async () => {
    const r = new IdentityResolver(base);
    expect(await r.resolve({ platform: "cli", platformUserId: "bob", displayName: "bob", email: null, emailVerified: true })).toEqual({ teleportUser: "bob", email: null });
  });
});
