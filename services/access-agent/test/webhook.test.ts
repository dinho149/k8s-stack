import { describe, expect, it } from "vitest";
import { WebhookVerifier } from "../src/broker/webhook.js";

describe("WebhookVerifier", () => {
  const secret = "s3cret";
  const body = JSON.stringify({ type: "request.resolved", request: { id: "r1" } });
  const headers = (over: Record<string, string> = {}) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return { "x-broker-event-id": "e1", "x-broker-timestamp": ts, "x-broker-signature": WebhookVerifier.sign(secret, ts, body), ...over };
  };

  it("accepts a fresh, correctly signed event once", () => {
    const v = new WebhookVerifier(secret);
    expect(v.verify(headers(), body)).toBeNull();
    expect(v.verify(headers(), body)).toBe("duplicate event");
  });

  it("rejects bad signatures, stale timestamps and missing headers", () => {
    const v = new WebhookVerifier(secret);
    expect(v.verify(headers({ "x-broker-signature": "sha256=00" }), body)).toBe("bad signature");
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(v.verify({ "x-broker-event-id": "e2", "x-broker-timestamp": old, "x-broker-signature": WebhookVerifier.sign(secret, old, body) }, body)).toBe("timestamp outside window");
    expect(v.verify({}, body)).toBe("missing webhook headers");
    expect(new WebhookVerifier("").verify(headers(), body)).toBe("webhook secret not configured");
  });
});
