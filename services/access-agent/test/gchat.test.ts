import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { GoogleChatAdapter, ReplayCache, eventTimeFresh } from "../src/adapters/gchat/index.js";
import type { ButtonClick, IncomingMessage } from "../src/adapters/types.js";
import { ConfigSchema } from "../src/config/schema.js";

const cfg = ConfigSchema.parse({ ANTHROPIC_API_KEY: "k", MCP_SHARED_TOKEN: "t", IDENTITY_SIGNING_KEY: "g".repeat(32), GCHAT_PROJECT_NUMBER: "123", GCHAT_SERVICE_ACCOUNT_JSON: "{}", GCHAT_MODE: "http" });
const T0 = Date.parse("2026-09-17T10:00:00Z");
const human = { name: "users/1", displayName: "Alice", email: "alice@example.com", type: "HUMAN" };
const dm = { name: "spaces/dm1", type: "DM" };

function adapter(opts: { verifyToken?: (t: string) => Promise<{ jti?: string }>; now?: () => number; mode?: "http" | "pubsub" } = {}) {
  const a = new GoogleChatAdapter({ ...cfg, GCHAT_MODE: opts.mode ?? "http" }, pino({ level: "silent" }), { verifyToken: opts.verifyToken ?? (async (t) => ({ jti: `jti-${t}` })), now: opts.now ?? (() => T0) });
  const messages: IncomingMessage[] = [];
  const clicks: ButtonClick[] = [];
  a.onMessage(async (m, reply) => {
    messages.push(m);
    await reply.text("hi " + m.user.email);
  });
  a.onButtonClick(async (c) => {
    clicks.push(c);
    await c.respond("clicked");
  });
  return { a, messages, clicks };
}
const post = (a: GoogleChatAdapter, token: string, body: unknown) => a.httpRoutes()[0].handler({ headers: { authorization: `Bearer ${token}` }, body, rawBody: JSON.stringify(body), query: {} });
const message = (over: Record<string, unknown> = {}) => ({ type: "MESSAGE", eventTime: new Date(T0).toISOString(), space: dm, user: human, message: { name: "spaces/dm1/messages/1", sender: human, text: "what can I access?" }, ...over });

describe("Google Chat adapter", () => {
  it("mounts /gchat/events only in http mode", () => {
    expect(adapter({ mode: "pubsub" }).a.httpRoutes()).toEqual([]);
    expect(adapter().a.httpRoutes().map((r) => r.path)).toEqual(["/gchat/events"]);
  });

  it("accepts a fresh signed event once and rejects the replayed token", async () => {
    const { a, messages } = adapter();
    const first = await post(a, "tok1", message());
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ text: "hi alice@example.com" });
    expect(messages[0].user).toMatchObject({ email: "alice@example.com", emailVerified: true, platform: "gchat" });
    const replay = await post(a, "tok1", message({ message: { name: "spaces/dm1/messages/2", sender: human, text: "again" } }));
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: "replay" });
    expect(messages).toHaveLength(1);
    expect((await post(a, "tok2", message())).status).toBe(200);
  });

  it("dedupes on a token hash when the JWT has no jti, and forgets after 10 minutes", async () => {
    let now = T0;
    const { a } = adapter({ verifyToken: async () => ({}), now: () => now });
    expect((await post(a, "same", message())).status).toBe(200);
    expect((await post(a, "same", message())).status).toBe(401);
    now = T0 + 11 * 60_000;
    expect((await post(a, "same", message({ eventTime: new Date(now).toISOString() }))).status).toBe(200);
  });

  it("rejects bad tokens, missing tokens and events outside the ±5 minute window", async () => {
    const { a, messages } = adapter({ verifyToken: async (t) => { if (t === "bad") throw new Error("invalid"); return { jti: t }; } });
    expect((await post(a, "bad", message())).status).toBe(401);
    expect((await a.httpRoutes()[0].handler({ headers: {}, body: message(), rawBody: "", query: {} })).status).toBe(401);
    expect((await post(a, "t1", message({ eventTime: new Date(T0 - 6 * 60_000).toISOString() }))).status).toBe(401);
    expect((await post(a, "t2", message({ eventTime: new Date(T0 + 6 * 60_000).toISOString() }))).status).toBe(401);
    expect((await post(a, "t3", message({ eventTime: undefined }))).status).toBe(401);
    expect((await post(a, "t4", message({ eventTime: new Date(T0 + 4 * 60_000).toISOString() }))).status).toBe(200);
    expect(messages).toHaveLength(1);
  });

  it("only accepts identity-bearing messages from direct-message spaces", async () => {
    const { a, messages } = adapter();
    const r = await post(a, "t1", message({ space: { name: "spaces/room", type: "ROOM", spaceType: "SPACE" } }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ text: expect.stringContaining("direct message") });
    expect(messages).toHaveLength(0);
    expect((await post(a, "t2", message({ space: { name: "spaces/dm2", spaceType: "DIRECT_MESSAGE" } }))).body).toMatchObject({ text: "hi alice@example.com" });
    expect((await post(a, "t3", message({ user: { ...human, type: "BOT" }, message: { sender: { ...human, type: "BOT" }, text: "x" } }))).body).toEqual({});
  });

  it("card clicks carry the verified sender as ctx and are only honoured on cards this agent posted", async () => {
    const { a, clicks } = adapter();
    const click = (messageName: string, user = human) => ({ type: "CARD_CLICKED", eventTime: new Date(T0).toISOString(), space: { name: "spaces/room", spaceType: "SPACE" }, user, message: { name: messageName }, common: { parameters: { requestId: "r1", nonce: "n1", button: "approve" }, formInputs: { reason: { stringInputs: { value: ["ok"] } } } } });
    const unknown = await post(a, "c1", click("spaces/room/messages/not-ours"));
    expect(unknown.body).toMatchObject({ text: expect.stringContaining("stale") });
    expect(clicks).toHaveLength(0);
    // simulate a card this process posted
    (a as any).rememberCard("spaces/room/messages/ours");
    const ok = await post(a, "c2", click("spaces/room/messages/ours"));
    expect(ok.body).toMatchObject({ text: "clicked", privateMessageViewer: { name: "users/1" } });
    expect(clicks[0]).toMatchObject({ button: "approve", requestId: "r1", nonce: "n1", reason: "ok", user: { platformUserId: "users/1", email: "alice@example.com" } });
    // re-verification: the clicker must be the verified sender of the event that carried the click
    const verified = await a.resolveUser("users/1", clicks[0].ctx);
    expect(verified).toMatchObject({ email: "alice@example.com", emailVerified: true });
    const impostor = await a.resolveUser("users/2", clicks[0].ctx);
    expect(impostor).toMatchObject({ email: null, emailVerified: false });
    expect(await a.resolveUser("users/1")).toMatchObject({ email: null, emailVerified: false });
    const malformed = await post(a, "c3", { ...click("spaces/room/messages/ours"), common: { parameters: { requestId: "r1" } } });
    expect(malformed.body).toMatchObject({ text: expect.stringContaining("malformed") });
    expect(clicks).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("ReplayCache is bounded and time-limited", () => {
    const c = new ReplayCache(1000, 2);
    expect(c.seenBefore("a", 0)).toBe(false);
    expect(c.seenBefore("a", 10)).toBe(true);
    expect(c.seenBefore("b", 20)).toBe(false);
    expect(c.seenBefore("c", 30)).toBe(false); // evicts "a" (bounded to 2)
    expect(c.seenBefore("a", 40)).toBe(false);
    expect(c.seenBefore("b", 2000)).toBe(false); // expired
  });
  it("eventTimeFresh", () => {
    expect(eventTimeFresh(new Date(T0).toISOString(), T0)).toBe(true);
    expect(eventTimeFresh(new Date(T0 - 5 * 60_000).toISOString(), T0)).toBe(true);
    expect(eventTimeFresh(new Date(T0 - 5 * 60_000 - 1).toISOString(), T0)).toBe(false);
    expect(eventTimeFresh("garbage", T0)).toBe(false);
    expect(eventTimeFresh(12345, T0)).toBe(false);
    expect(eventTimeFresh(undefined, T0)).toBe(false);
  });
  it("vi sanity", () => expect(vi.fn()).toBeTypeOf("function"));
});
