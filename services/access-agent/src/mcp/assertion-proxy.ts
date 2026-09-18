/**
 * Loopback MCP proxy for the Claude Code backend.
 *
 * `claude -p --mcp-config` can only send static headers, but identity assertions must be fresh on
 * every request (45 s lifetime). So each turn gets a tiny HTTP server on 127.0.0.1 that the child
 * talks to with a single-use bearer token; the proxy swaps that for the real shared token plus a
 * freshly minted assertion for the turn's principal and streams the upstream response back
 * (including SSE). The child never sees the shared token or the signing key, and the principal is
 * fixed at proxy start, so nothing the model does can change who the MCP server acts for.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { ASSERTION_HEADER, mintAssertion } from "../identity/assertion.js";
import type { Logger } from "../observability/logger.js";
import type { Principal } from "./client.js";

export interface AssertionProxyOptions {
  upstream: string;
  sharedToken: string;
  signingKey: string;
  principal: Principal;
  log: Logger;
}

export interface AssertionProxy {
  /** URL the child process should use as the MCP server. */
  url: string;
  /** Single-use bearer token the child must present. */
  token: string;
  close(): Promise<void>;
}

/** Hop-by-hop or identity-bearing headers that are never forwarded from the child. */
const STRIP_REQUEST_HEADERS = new Set(["authorization", "host", "connection", "keep-alive", "proxy-authorization", "te", "trailer", "upgrade", "x-teleport-user", "x-teleport-user-email", ASSERTION_HEADER.toLowerCase()]);
const STRIP_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding"]);

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const h = header.trim();
  // linear-time parse: "Bearer" + at least one space + token (no regex with nested quantifiers)
  if (h.length < 8 || h.slice(0, 7).toLowerCase() !== "bearer ") return false;
  const presented = h.slice(7).trim();
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startAssertionProxy(opts: AssertionProxyOptions): Promise<AssertionProxy> {
  const upstream = new URL(opts.upstream);
  const token = randomBytes(32).toString("base64url");
  const agent = upstream.protocol === "https:" ? https : http;

  const server = http.createServer((req, res) => {
    if (!bearerMatches(req.headers.authorization, token)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !STRIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
    headers.host = upstream.host;
    headers.authorization = `Bearer ${opts.sharedToken}`;
    headers[ASSERTION_HEADER.toLowerCase()] = mintAssertion(opts.signingKey, opts.principal, "mcp");

    const up = agent.request(upstream, { method: req.method, headers }, (upRes) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (v !== undefined && !STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) out[k] = v;
      res.writeHead(upRes.statusCode ?? 502, out);
      upRes.pipe(res);
      upRes.on("error", () => res.destroy());
    });
    up.on("error", (e) => {
      opts.log.warn({ err: e }, "mcp proxy upstream error");
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream unavailable" }));
    });
    req.on("close", () => {
      if (!up.destroyed && !up.writableEnded) up.destroy();
    });
    res.on("close", () => {
      if (!up.destroyed) up.destroy();
    });
    req.pipe(up);
  });
  server.keepAliveTimeout = 5_000;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}${upstream.pathname}`,
        token,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
