/**
 * HTTP surfaces.
 *
 *   internal (PORT)        /healthz, /readyz, POST /v1/broker/events — reachable from the broker only
 *   public   (PUBLIC_PORT) adapter webhooks (Teams /api/messages, Google Chat /gchat/events) + a minimal /healthz
 *
 * With PUBLIC_PORT unset a single "all" instance serves everything on PORT (local/CLI use). With it set,
 * index.ts builds one instance per surface so the broker webhook and readiness endpoint are never reachable
 * on the internet-facing port, and the chat webhooks are not reachable on the internal one.
 */
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { ChatAdapter } from "../adapters/types.js";
import type { WebhookVerifier, BrokerEvent } from "../broker/webhook.js";
import type { Logger } from "../observability/logger.js";

export type HttpSurface = "all" | "internal" | "public";

export interface ServerDeps {
  log: Logger;
  adapters: ChatAdapter[];
  webhook: WebhookVerifier;
  onBrokerEvent: (ev: BrokerEvent) => Promise<void>;
  ready: () => Promise<boolean>;
}

export const BODY_LIMIT = 256 * 1024;
export const RATE_LIMIT_MAX = 120;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export function buildServer(deps: ServerDeps, surface: HttpSurface = "all"): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT });
  // Per-client rate limit on every surface: chat webhooks are internet-facing on the public listener and the
  // broker webhook / readiness probe must not be an amplification vector. Health checks stay exempt.
  void app.register(rateLimit, { max: RATE_LIMIT_MAX, timeWindow: RATE_LIMIT_WINDOW_MS, allowList: (req) => req.url === "/healthz" });
  // keep raw bodies for signature verification; only JSON objects are accepted as event bodies
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      const raw = body as string;
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object");
      done(null, { __raw: raw, ...(parsed as Record<string, unknown>) });
    } catch (e) {
      // a bad body is the client's fault: 400, not 500
      done(Object.assign(e as Error, { statusCode: 400 }), undefined);
    }
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, { __raw: body as string, __form: Object.fromEntries(new URLSearchParams(body as string)) }));

  // liveness on every surface (the public one answers with nothing but "ok")
  app.get("/healthz", async () => ({ status: "ok" }));

  if (surface !== "public") {
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
  }

  if (surface !== "internal") {
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
  }
  return app;
}
