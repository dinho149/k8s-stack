import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ASSERTION_TTL_SECONDS, AssertionError, buildPayload, mintAssertion, verifyAssertion } from "../src/identity/assertion.js";

/** Fixed vector shared with the Go verifier (services/teleport-access/internal/assertion). */
export const VECTOR = {
  key: "0123456789abcdef0123456789abcdef", // gitleaks:allow (fixed test vector, not a credential)
  principal: { teleportUser: "alice", email: "alice@example.com", platform: "slack" as const, platformUserId: "U0123ABC" },
  nowMs: 1_700_000_000_000,
  jti: "00000000-0000-4000-8000-000000000000",
  payloadJson: '{"sub":"alice","email":"alice@example.com","platform":"slack","platform_user_id":"U0123ABC","aud":"mcp","iat":1700000000,"exp":1700000045,"jti":"00000000-0000-4000-8000-000000000000"}',
  header:
    "eyJzdWIiOiJhbGljZSIsImVtYWlsIjoiYWxpY2VAZXhhbXBsZS5jb20iLCJwbGF0Zm9ybSI6InNsYWNrIiwicGxhdGZvcm1fdXNlcl9pZCI6IlUwMTIzQUJDIiwiYXVkIjoibWNwIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDAwNDUsImp0aSI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCJ9.yHylOoWMz7JIsYpljVS00XqoOZ2MRlkKIH8meHiTvAQ",
  brokerHeader:
    "eyJzdWIiOiJhbGljZSIsImVtYWlsIjoiYWxpY2VAZXhhbXBsZS5jb20iLCJwbGF0Zm9ybSI6InNsYWNrIiwicGxhdGZvcm1fdXNlcl9pZCI6IlUwMTIzQUJDIiwiYXVkIjoiYnJva2VyIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDAwNDUsImp0aSI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCJ9.ZfbFjdLMGPp8vcVthjoAklJewfR09yzkhrAOvIFhi88",
};

describe("identity assertions", () => {
  const opts = { nowMs: VECTOR.nowMs, jti: VECTOR.jti };

  it("produces the fixed vector (payload field order, base64url, HMAC over the encoded payload)", () => {
    expect(JSON.stringify(buildPayload(VECTOR.principal, "mcp", opts))).toBe(VECTOR.payloadJson);
    const header = mintAssertion(VECTOR.key, VECTOR.principal, "mcp", opts);
    expect(header).toBe(VECTOR.header);
    const [encoded, sig] = header.split(".");
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(VECTOR.payloadJson);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(sig).toBe(createHmac("sha256", VECTOR.key).update(encoded).digest("base64url"));
    expect(mintAssertion(VECTOR.key, VECTOR.principal, "broker", opts)).toBe(VECTOR.brokerHeader);
  });

  it("uses exp = iat + 45 and a fresh uuid jti by default", () => {
    const p1 = buildPayload(VECTOR.principal, "mcp");
    const p2 = buildPayload(VECTOR.principal, "mcp");
    expect(p1.exp - p1.iat).toBe(ASSERTION_TTL_SECONDS);
    expect(p1.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(p1.jti).not.toBe(p2.jti);
    expect(buildPayload({ ...VECTOR.principal, email: null }, "mcp").email).toBe("");
  });

  it("verifies its own output and rejects tampering, wrong audience, expiry and short keys", () => {
    const now = VECTOR.nowMs + 10_000;
    expect(verifyAssertion(VECTOR.key, VECTOR.header, "mcp", now).sub).toBe("alice");
    expect(() => verifyAssertion(VECTOR.key, VECTOR.header, "broker", now)).toThrow(AssertionError);
    expect(() => verifyAssertion("x".repeat(32), VECTOR.header, "mcp", now)).toThrow(/signature/);
    const [encoded, sig] = VECTOR.header.split(".");
    const forged = Buffer.from(VECTOR.payloadJson.replace('"alice"', '"admin"')).toString("base64url");
    expect(() => verifyAssertion(VECTOR.key, `${forged}.${sig}`, "mcp", now)).toThrow(/signature/);
    expect(() => verifyAssertion(VECTOR.key, encoded, "mcp", now)).toThrow(/malformed/);
    expect(() => verifyAssertion(VECTOR.key, VECTOR.header, "mcp", VECTOR.nowMs + 46_000)).toThrow(/expired/);
    expect(() => mintAssertion("short", VECTOR.principal, "mcp")).toThrow(/32 bytes/);
    expect(() => mintAssertion(VECTOR.key, { ...VECTOR.principal, teleportUser: "" }, "mcp")).toThrow(/username/);
  });

  it("enforces the Go verifier's sub / jti / iat rules", () => {
    for (const bad of ["", "a b", "tab\there", "nul\u0000", "x".repeat(256)]) expect(() => mintAssertion(VECTOR.key, { ...VECTOR.principal, teleportUser: bad }, "mcp")).toThrow(/username/);
    expect(() => mintAssertion(VECTOR.key, { ...VECTOR.principal, teleportUser: "x".repeat(255) }, "mcp")).not.toThrow();
    const now = VECTOR.nowMs;
    const forge = (patch: Record<string, unknown>) => {
      const payload = { ...JSON.parse(VECTOR.payloadJson), ...patch };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return `${encoded}.${createHmac("sha256", VECTOR.key).update(encoded).digest("base64url")}`;
    };
    expect(() => verifyAssertion(VECTOR.key, forge({ jti: "not-a-uuid" }), "mcp", now)).toThrow(/UUID/);
    expect(() => verifyAssertion(VECTOR.key, forge({ exp: 1700000000 }), "mcp", now)).toThrow(/after iat/);
    expect(() => verifyAssertion(VECTOR.key, forge({ exp: 1700000061 }), "mcp", now)).toThrow(/too long/);
    expect(() => verifyAssertion(VECTOR.key, forge({ iat: 1700000031, exp: 1700000076 }), "mcp", now)).toThrow(/future/);
    expect(() => verifyAssertion(VECTOR.key, forge({ iat: 1700000029, exp: 1700000074 }), "mcp", now)).not.toThrow();
    expect(() => verifyAssertion(VECTOR.key, forge({ sub: "ali ce" }), "mcp", now)).toThrow(/sub/);
    expect(() => verifyAssertion(VECTOR.key, VECTOR.header + "=", "mcp", now)).toThrow(/base64url/);
  });
});
