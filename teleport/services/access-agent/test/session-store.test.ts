import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FileSessionIdStore } from "../src/agent/session-ids.js";
import { FileSessionStore, MemorySessionStore, sessionKey } from "../src/agent/session-store.js";

describe("sessionKey", () => {
  it("always includes the platform, channel, thread and user so sessions are never shared across users", () => {
    expect(sessionKey("slack", "C1", "T1", "U1")).toBe("slack:C1:T1:U1");
    expect(sessionKey("slack", "C1", undefined, "U1")).toBe("slack:C1:root:U1");
    expect(sessionKey("slack", "C1", "T1", "U1")).not.toBe(sessionKey("slack", "C1", "T1", "U2"));
    expect(() => sessionKey("slack", "C1", "T1", "")).toThrow(/user id/);
  });
});

describe("MemorySessionStore", () => {
  it("appends and trims whole turns", async () => {
    const s = new MemorySessionStore(4);
    const k = sessionKey("slack", "C", "T", "U");
    await s.append(k, { role: "user", content: "q1" }, { role: "assistant", content: [{ type: "text", text: "a1" }] });
    await s.append(k, { role: "user", content: "q2" }, { role: "assistant", content: [{ type: "text", text: "a2" }] });
    await s.append(k, { role: "user", content: "q3" }, { role: "assistant", content: [{ type: "text", text: "a3" }] });
    const h = await s.get(k);
    expect(h.length).toBeLessThanOrEqual(4);
    expect(h[0]).toEqual({ role: "user", content: "q2" });
  });
});

describe("file stores are owner-only", () => {
  const mode = (p: string) => fs.statSync(p).mode & 0o777;
  it("writes transcripts 0600 in a 0700 directory and fixes up loose modes on load", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-sessions-")), "nested");
    const file = path.join(dir, "sessions.json");
    const s = new FileSessionStore(file);
    await s.append(sessionKey("slack", "C", "T", "U"), { role: "user", content: "secret question" });
    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["sessions.json"]); // no temp file left behind
    fs.chmodSync(file, 0o644);
    const reloaded = new FileSessionStore(file);
    expect(mode(file)).toBe(0o600);
    expect((await reloaded.get(sessionKey("slack", "C", "T", "U"))).length).toBe(1);
  });
  it("claude session-id map is 0600 too", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ids-"));
    const file = path.join(dir, "ids", "claude-sessions.json");
    new FileSessionIdStore(file).set("k", "sess");
    expect(mode(file)).toBe(0o600);
    expect(mode(path.dirname(file))).toBe(0o700);
  });
});
