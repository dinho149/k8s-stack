/**
 * Verifies broker -> agent webhook calls: HMAC-SHA256 over "<timestamp>.<body>", 5 minute window, event-id dedupe.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface BrokerEvent {
  type: "request.pending_review" | "request.resolved";
  request: import("./client.js").BrokerRequest;
  requester_email?: string;
  notify?: { channels: Array<{ adapter: string; target: string }>; mention_approvers?: boolean };
  approver_emails?: string[];
  resolution?: { state: "approved" | "denied" | "expired"; by: string; mode: "auto" | "chat" | "external"; reason: string };
}

export class WebhookVerifier {
  private seen = new Map<string, number>();
  constructor(private readonly secret: string, private readonly windowMs = 5 * 60 * 1000) {
    setInterval(() => {
      const cutoff = Date.now() - this.windowMs * 2;
      for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k);
    }, 60_000).unref();
  }

  static sign(secret: string, timestamp: string, body: string): string {
    return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  }

  /** Returns an error string, or null when the request is authentic and fresh. */
  verify(headers: Record<string, string | string[] | undefined>, rawBody: string): string | null {
    if (!this.secret) return "webhook secret not configured";
    const h = (k: string) => {
      const v = headers[k] ?? headers[k.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const id = h("X-Broker-Event-Id");
    const ts = h("X-Broker-Timestamp");
    const sig = h("X-Broker-Signature");
    if (!id || !ts || !sig) return "missing webhook headers";
    const t = Number(ts) * (ts.length <= 10 ? 1000 : 1);
    if (!Number.isFinite(t) || Math.abs(Date.now() - t) > this.windowMs) return "timestamp outside window";
    const expected = WebhookVerifier.sign(this.secret, ts, rawBody);
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return "bad signature";
    if (this.seen.has(id)) return "duplicate event";
    this.seen.set(id, Date.now());
    return null;
  }
}
