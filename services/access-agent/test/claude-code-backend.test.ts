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
import { verifyAssertion } from "../src/identity/assertion.js";

const KEY = "s".repeat(32);

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

const baseCfg = ConfigSchema.parse({ CLAUDE_AUTH_MODE: "subscription", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test", MCP_SHARED_TOKEN: "mcp-secret", IDENTITY_SIGNING_KEY: KEY, MCP_URL: "http://mcp:8080/mcp", CLAUDE_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-")) });
const ok = (text: string, sessionId = "sess-1") => [
  JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "teleport", status: "connected" }] }),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, total_cost_usd: 0.01, num_turns: 1, stop_reason: "end_turn" }),
];
const input = (text: string, sessionKey = "cli:terminal:session") => ({ sessionKey, principal: { teleportUser: "alice", email: "alice@example.com", platform: "cli" as const, platformUserId: "alice" }, platform: "cli", isApprover: false, text });

describe("ClaudeCodeBackend", () => {
  it("spawns claude -p with the MCP-only tool surface, no settings, and a per-turn loopback proxy in a temp file, never argv", async () => {
    const { spawn, calls } = fakeSpawn(() => ({ stdout: ok("hello alice"), code: 0 }));
    const b = new ClaudeCodeBackend(baseCfg, new MemorySessionIdStore(), pino({ level: "silent" }), { spawn, baseEnv: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-api-should-be-removed", AWS_SECRET_ACCESS_KEY: "leak", KUBERNETES_SERVICE_HOST: "10.0.0.1", CLAUDECODE: "1", CLAUDE_SESSION_ID: "parent", CLAUDE_CONFIG_DIR: "/operator/.claude", HOME: "/home/x", LC_ALL: "C.UTF-8", HTTPS_PROXY: "http://proxy:3128", NODE_EXTRA_CA_CERTS: "/ca.pem", CLAUDE_CODE_OAUTH_TOKEN: "stale-from-shell" } });
    const deltas: string[] = [];
    const r = await b.run({ ...input("who am I?"), onDelta: (d) => deltas.push(d) });
    expect(r.text).toBe("hello alice");
    expect(r.sessionId).toBe("sess-1");
    expect(deltas.join("")).toBe("hello alice");
    const c = calls[0];
    expect(c.cmd).toBe("claude");
    expect(c.args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--tools", "", "--allowedTools", "mcp__teleport__*", "--permission-mode", "default", "--session-id"]));
    expect(c.args[c.args.indexOf("--setting-sources") + 1]).toBe("");
    expect(c.args.join(" ")).not.toContain("sk-ant-oat-test");
    expect(c.args.join(" ")).not.toContain("mcp-secret");
    expect(c.args.join(" ")).not.toContain(KEY);
    expect(c.args).not.toContain("--resume");
    // env is an allow-list: credentials and cluster noise never reach the child
    expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(c.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(c.env.KUBERNETES_SERVICE_HOST).toBeUndefined();
    expect(c.env.CLAUDECODE).toBeUndefined();
    expect(c.env.CLAUDE_SESSION_ID).toBeUndefined();
    expect(c.env).toMatchObject({ PATH: "/bin", HOME: "/home/x", LC_ALL: "C.UTF-8", HTTPS_PROXY: "http://proxy:3128", NODE_EXTRA_CA_CERTS: "/ca.pem", DISABLE_TELEMETRY: "1" });
    expect(c.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-test");
    expect(c.env.CLAUDE_CONFIG_DIR).toBe(baseCfg.CLAUDE_STATE_DIR);
    // the child talks to a loopback proxy with a single-use token; the shared token, signing key and identity stay in this process
    const server = (c.mcpConfig as any).mcpServers.teleport;
    expect(server.type).toBe("http");
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(server.headers.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]{40,}$/);
    expect(server.headers.Authorization).not.toBe("Bearer mcp-secret");
    expect(server.headers["X-Teleport-User"]).toBeUndefined();
    expect(server.headers["X-Teleport-Assertion"]).toBeUndefined();
    expect(JSON.stringify(c.mcpConfig)).not.toContain(KEY);
    expect(c.stdin).toContain('Teleport username "alice"');
    expect(c.stdin.trim().endsWith("who am I?")).toBe(true);
    const mcpPath = c.args[c.args.indexOf("--mcp-config") + 1];
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(mcpPath)).toBe(false); // deleted after the turn
    await expect(fetch(server.url, { method: "POST", headers: { Authorization: server.headers.Authorization } })).rejects.toThrow(); // proxy closed after the turn
  });

  it("the per-turn proxy mints a fresh assertion for the turn's principal while the child runs", async () => {
    let upstreamHeaders: Record<string, string | string[] | undefined> = {};
    const http = await import("node:http");
    const upstream = http.createServer((req, res) => {
      upstreamHeaders = req.headers;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const cfg = { ...baseCfg, MCP_URL: `http://127.0.0.1:${(upstream.address() as any).port}/mcp` };
    let proxied: Response | undefined;
    // a fake child that calls the proxy (like claude would) and only exits once the call completed
    const spawn = ((_cmd: string, args: string[]) => {
      const child: any = new EventEmitter();
      child.pid = 4243;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => undefined;
      const server = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.teleport;
      child.stdin = {
        end: () => {
          void fetch(server.url, { method: "POST", headers: { Authorization: server.headers.Authorization, "content-type": "application/json" }, body: "{}" }).then((r) => {
            proxied = r;
            for (const l of ok("done")) child.stdout.write(l + "\n");
            child.stdout.end();
            child.stderr.end();
            child.emit("close", 0, null);
          });
        },
      };
      return child;
    }) as any;
    const b = new ClaudeCodeBackend(cfg, new MemorySessionIdStore(), pino({ level: "silent" }), { spawn, baseEnv: {} });
    const r = await b.run(input("hi"));
    expect(r.text).toBe("done");
    expect(proxied?.status).toBe(200);
    expect(upstreamHeaders.authorization).toBe("Bearer mcp-secret");
    expect(verifyAssertion(KEY, upstreamHeaders["x-teleport-assertion"] as string, "mcp")).toMatchObject({ sub: "alice", platform: "cli", aud: "mcp" });
    await new Promise<void>((r) => upstream.close(() => r()));
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
    const cfg = ConfigSchema.parse({ CLAUDE_AUTH_MODE: "subscription", CLAUDE_ALLOW_LOCAL_LOGIN: "true", MCP_SHARED_TOKEN: "t", IDENTITY_SIGNING_KEY: KEY });
    const b = new ClaudeCodeBackend(cfg, new MemorySessionIdStore(), pino({ level: "silent" }), { baseEnv: { HOME: "/home/x", CLAUDE_CODE_OAUTH_TOKEN: "stale-from-shell" } });
    const env = b.buildEnv();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined(); // operator's own ~/.claude login is used
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); // only the configured token is ever passed
  });
});
