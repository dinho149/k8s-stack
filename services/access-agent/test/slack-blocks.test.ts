import { describe, expect, it } from "vitest";
import { renderBlocks, toMrkdwn } from "../src/adapters/slack/index.js";

describe("slack rendering", () => {
  it("renders buttons with requestId+nonce and no buttons once resolved", () => {
    const pending = renderBlocks({ requestId: "abc", nonce: "n", title: "t", fields: { A: "1" }, status: "pending", buttons: [{ id: "approve", label: "Approve", style: "primary" }] });
    const actions = pending.find((b) => b.type === "actions");
    expect(JSON.parse(actions.elements[0].value)).toEqual({ requestId: "abc", nonce: "n" });
    expect(actions.elements[0].action_id).toBe("access.approve");
    const done = renderBlocks({ requestId: "abc", nonce: "n", title: "t", fields: {}, status: "approved", buttons: [], footer: "by bob" });
    expect(done.find((b) => b.type === "actions")).toBeUndefined();
    expect(done.at(-1).type).toBe("context");
  });
  it("converts markdown to mrkdwn", () => {
    expect(toMrkdwn("**bold** and [x](https://y) \n- item")).toBe("*bold* and <https://y|x> \n• item");
  });
});
