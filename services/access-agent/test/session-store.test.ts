import { describe, expect, it } from "vitest";
import { MemorySessionStore, sessionKey } from "../src/agent/session-store.js";

describe("MemorySessionStore", () => {
  it("appends and trims whole turns", async () => {
    const s = new MemorySessionStore(4);
    const k = sessionKey("slack", "C", "T");
    await s.append(k, { role: "user", content: "q1" }, { role: "assistant", content: [{ type: "text", text: "a1" }] });
    await s.append(k, { role: "user", content: "q2" }, { role: "assistant", content: [{ type: "text", text: "a2" }] });
    await s.append(k, { role: "user", content: "q3" }, { role: "assistant", content: [{ type: "text", text: "a3" }] });
    const h = await s.get(k);
    expect(h.length).toBeLessThanOrEqual(4);
    expect(h[0]).toEqual({ role: "user", content: "q2" });
  });
});
