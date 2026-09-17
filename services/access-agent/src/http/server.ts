/**
 * HTTP surface: health, broker webhook, and any adapter routes (Slack HTTP mode, Teams, Google Chat).
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { ChatAdapter } from "../adapters/types.js";
import type { WebhookVerifier, BrokerEvent } from "../broker/webhook.js";
import type { Logger } from "../observability/logger.js";

export interface ServerDeps {
  log: Logger;
  adapters: ChatAdapter[];
  webhook: WebhookVerifier;
  onBrokerEvent: (ev: BrokerEvent) => Promise<void>;
  ready: () => Promise<boolean>;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  // keep raw bodies for signature verification
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      const raw = body as string;
      done(null, { __raw: raw, ...(raw ? JSON.parse(raw) : {}) });
    } catch (e) {
      done(e as Error, undefined);
    }
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, { __raw: body as string, __form: Object.fromEntries(new URLSearchParams(body as string)) }));

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    const ok = await deps.ready().catch(() => false);
    reply.code(ok ? 200 : 503);
    return { status: ok ? "ready" : "not-ready" };
  });

  app.post("/v1/broker/events", async (req, reply) => {
    const body = req.body as { __raw: string } & BrokerEvent;
    const err = deps.webhook.verify(req.headers as Record<string, string | string[] | undefined>, body.__raw);
    if (err) {
      deps.log.warn({ err }, "rejected broker webhook");
      reply.code(401);
      return { error: err };
    }
    const { __raw, ...ev } = body;
    void __raw;
    await deps.onBrokerEvent(ev as BrokerEvent);
    return { ok: true };
  });

  for (const a of deps.adapters) {
    for (const r of a.httpRoutes?.() ?? []) {
      app.route({
        method: r.method,
        url: r.path,
        handler: async (req, reply) => {
          const body = req.body as { __raw?: string; __form?: Record<string, string> } | undefined;
          const res = await r.handler({ headers: req.headers as Record<string, string | string[] | undefined>, body: body?.__form ?? body, rawBody: body?.__raw ?? "", query: req.query as Record<string, unknown> });
          reply.code(res.status);
          if (res.headers) reply.headers(res.headers);
          return res.body ?? "";
        },
      });
    }
  }
  return app;
}
