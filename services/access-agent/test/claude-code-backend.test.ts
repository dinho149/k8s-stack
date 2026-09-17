import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBackend } from "../src/agent/claude-code-backend.js";
import { MemorySessionIdStore } from "../src/agent/session-ids.js";
import { ConfigSchema } from "../src/config/schema.js";

interface Call { cmd: string; args: string[]; env: NodeJS.ProcessEnv; stdin: string; mcpConfig: unknown }

/** A fake `spawn` that records the invocation and replays scripted stdout lines. */
function fakeSpawn(script: (call: Call) => { stdout: string[]; code: number; stderr?: string }) {
  const calls: Call[] = [];
  const spawn = ((cmd: string, args: string[], opts: any) => {
    const child: any = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const stdinChunks: string[] = [];
    child.stdin = { end: (data: string) => { stdinChunks.push(data ?? ""); finish(); } };
    child.kill = () => undefined;
    const mcpPath = args[args.indexOf("--mcp-config") + 1];
    const call: Call = { cmd, args, env: opts.env, stdin: "", mcpConfig: JSON.parse(fs.readFileSync(mcpPath, "utf8")) };
    calls.push(call);
    const finish = () => {
      call.stdin = stdinChunks.join("");
      const out = script(call);
      setImmediate(() => {
        for (const l of out.stdout) child.stdout.write(l + "\n");
        if (out.stderr) child.stderr.write(out.stderr);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", out.code, null);
      });
    };
    return child;
  }) as any;
  return { spawn, calls };
}

const baseCfg = ConfigSchema.parse({ CLAUDE_AUTH_MODE: "subscription", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test", MCP_SHARED_TOKEN: "mcp-secret", MCP_URL: "http://mcp:8080/mcp", CLAUDE_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-")) });
const ok = (text: string, sessionId = "sess-1") => [
  JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "teleport", status: "connected" }] }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, total_cost_usd: 0.01, num_turns: 1, stop_reason: "end_turn" }),
];
const input = (text: string, sessionKey = "cli:terminal:session") => ({ sessionKey, principal: { teleportUser: "alice", email: "alice@example.com" }, platform: "cli", isApprover: false, text });

describe("ClaudeCodeBackend", () => {
  it("spawns claude -p with the MCP-only tool surface and identity in a temp file, never argv", async () => {
    const { spawn, calls } = fakeSpawn(() => ({ stdout: ok("hello alice"), code: 0 }));
    const b = new ClaudeCodeBackend(baseCfg, new MemorySessionIdStore(), pino({ level: "silent" }), { spawn, baseEnv: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-api-should-be-removed", CLAUDECODE: "1", HOME: "/home/x" } });
    const deltas: string[] = [];
    const r = await b.run({ ...input("who am I?"), onDelta: (d) => deltas.push(d) });
    expect(r.text).toBe("hello alice");
    expect(r.sessionId).toBe("sess-1");
    expect(deltas.join("")).toBe("hello alice");
    const c = calls[0];
    expect(c.cmd).toBe("claude");
    expect(c.args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--tools", "", "--allowedTools", "mcp__teleport__*", "--permission-mode", "default", "--session-id"]));
    expect(c.args.join(" ")).not.toContain("sk-ant-oat-test");
    expect(c.args.join(" ")).not.toContain("mcp-secret");
    expect(c.args).not.toContain("--resume");
    expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(c.env.CLAUDECODE).toBeUndefined();
    expect(c.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-test");
    expect(c.env.CLAUDE_CONFIG_DIR).toBe(baseCfg.CLAUDE_STATE_DIR);
    expect(c.mcpConfig).toEqual({ mcpServers: { teleport: { type: "http", url: "http://mcp:8080/mcp", headers: { Authorization: "Bearer mcp-secret", "X-Teleport-User": "alice", "X-Teleport-User-Email": "alice@example.com" } } } });
    expect(c.stdin).toContain('Teleport username "alice"');
    expect(c.stdin.trim().endsWith("who am I?")).toBe(true);
    const mcpPath = c.args[c.args.indexOf("--mcp-config") + 1];
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(mcpPath)).toBe(false); // deleted after the turn
  });

  it("resumes the thread's session on the next turn and recovers when resume fails", async () => {
    let n = 0;
    const { spawn, calls } = fakeSpawn((c) => {
      n++;
      if (c.args.includes("--resume") && n === 2) return { stdout: [JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "No conversation found with session ID x" })], code: 1 };
      return { stdout: ok(`turn ${n}`, `sess-${n}`), code: 0 };
    });
    const store = new MemorySessionIdStore();
    const b = new ClaudeCodeBackend(baseCfg, store, pino({ level: "silent" }), { spawn, baseEnv: {} });
    await b.run(input("first"));
    expect(store.get("cli:terminal:session")).toBe("sess-1");
    const r = await b.run(input("second"));
    expect(calls[1].args).toContain("--resume");
    expect(calls[1].args).toContain("sess-1");
    expect(calls[2].args).toContain("--session-id"); // fresh session after the failed resume
    expect(r.text).toBe("turn 3");
    expect(store.get("cli:terminal:session")).toBe("sess-3");
  });

  it("marks itself stale on an authentication failure and answers gracefully", async () => {
    const { spawn } = fakeSpawn(() => ({ stdout: [JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", terminal_reason: "api_error" })], code: 1 }));
    const b = new ClaudeCodeBackend(baseCfg, new MemorySessionIdStore(), pino({ level: "silent" }), { spawn, baseEnv: {} });
    const r = await b.run(input("hi"));
    expect(b.stale).toBe(true);
    expect(r.stopReason).toBe("auth_error");
    expect(r.text).toMatch(/subscription login/);
    expect((await b.probe()).ok).toBe(false);
  });

  it("uses the local login when allowed and no token is set", () => {
    const cfg = ConfigSchema.parse({ CLAUDE_AUTH_MODE: "subscription", CLAUDE_ALLOW_LOCAL_LOGIN: "true", MCP_SHARED_TOKEN: "t" });
    const b = new ClaudeCodeBackend(cfg, new MemorySessionIdStore(), pino({ level: "silent" }), { baseEnv: { HOME: "/home/x", CLAUDE_CODE_OAUTH_TOKEN: "stale-from-shell" } });
    const env = b.buildEnv();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined(); // operator's own ~/.claude login is used
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // only the configured token is ever passed
  });
});
