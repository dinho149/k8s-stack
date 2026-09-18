import { describe, expect, it } from "vitest";
import { StreamJsonParser, looksLikeAuthFailure } from "../src/agent/stream-json.js";

const init = JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "teleport", status: "connected" }], tools: ["mcp__teleport__whoami"] });
const delta = (t: string) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
const assistantTool = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__teleport__whoami", input: {} }] } });
const assistantText = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "You hold requester." }] } });
const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "You hold requester.", session_id: "s1", total_cost_usd: 0.02, num_turns: 2, stop_reason: "end_turn", terminal_reason: "completed" });

describe("StreamJsonParser", () => {
  it("streams deltas, collects tool calls and the final result", () => {
    const deltas: string[] = [];
    const p = new StreamJsonParser((d) => deltas.push(d));
    p.feed(init + "\n" + assistantTool + "\n" + delta("You hold ") + "\n");
    p.feed(delta("requester.") + "\n" + assistantText + "\nnot json at all\n" + result + "\n");
    const s = p.end();
    expect(deltas.join("")).toBe("You hold requester.");
    expect(s).toMatchObject({ text: "You hold requester.", sessionId: "s1", isError: false, costUsd: 0.02, numTurns: 2, stopReason: "end_turn", complete: true, toolCalls: ["mcp__teleport__whoami"] });
    expect(s.mcpServers).toEqual([{ name: "teleport", status: "connected" }]);
  });

  it("handles a partial last line and a missing result", () => {
    const p = new StreamJsonParser();
    p.feed(assistantText.slice(0, 20));
    p.feed(assistantText.slice(20));
    const s = p.end();
    expect(s.complete).toBe(false);
    expect(s.text).toBe("You hold requester.");
  });

  it("recognises the not-logged-in failure shape", () => {
    const p = new StreamJsonParser();
    p.feed(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", terminal_reason: "api_error", session_id: "x" }) + "\n");
    const s = p.end();
    expect(s.isError).toBe(true);
    expect(looksLikeAuthFailure(s.text)).toBe(true);
    expect(looksLikeAuthFailure("rate limited, retry later")).toBe(false);
  });
});
