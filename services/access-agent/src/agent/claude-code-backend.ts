/**
 * ClaudeCodeBackend — one headless `claude -p` process per turn, authenticated with a Claude Pro/Max
 * subscription token (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`) or, for the CLI adapter, the
 * operator's own Claude Code login.
 *
 * Security properties kept from the api-key path:
 *  - identity is bound to HTTP headers in a per-user MCP config file written by THIS process (0600, deleted
 *    after the turn, never on argv); the model cannot change who it acts as;
 *  - only our MCP tools exist (`--tools ""` removes every built-in tool, `--strict-mcp-config` ignores any
 *    other MCP server), and they are pre-approved, so print mode never prompts;
 *  - there are no approve/deny tools to reach.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import type { ClaudeBackend, ProbeResult, TurnInput, TurnResult } from "./backend.js";
import type { SessionIdStore } from "./session-ids.js";
import { STABLE_SYSTEM, perTurnContext } from "./system-prompt.js";
import { StreamJsonParser, looksLikeAuthFailure } from "./stream-json.js";

export type SpawnFn = typeof nodeSpawn;

export const MCP_SERVER_NAME = "teleport";
const NESTED_SESSION_VARS = ["CLAUDE_SESSION_ID", "CLAUDE_PARENT_SESSION_ID", "CLAUDECODE"];
/** Would outrank the subscription token in Claude Code's credential precedence. */
const API_CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"];

export interface ClaudeCodeBackendOptions {
  spawn?: SpawnFn;
  baseEnv?: NodeJS.ProcessEnv;
  tmpDir?: string;
}

export class ClaudeCodeBackend implements ClaudeBackend {
  readonly name = "subscription" as const;
  stale = false;
  private readonly spawnFn: SpawnFn;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly tmpDir: string;

  constructor(
    private readonly cfg: Config,
    private readonly sessions: SessionIdStore,
    private readonly log: Logger,
    opts: ClaudeCodeBackendOptions = {},
  ) {
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.baseEnv = opts.baseEnv ?? process.env;
    this.tmpDir = opts.tmpDir ?? os.tmpdir();
  }

  /** Environment for the child: explicit, with API credentials and nested-session markers removed. */
  buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(this.baseEnv)) {
      if (v === undefined || NESTED_SESSION_VARS.includes(k) || API_CREDENTIAL_VARS.includes(k)) continue;
      env[k] = v;
    }
    if (this.cfg.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = this.cfg.CLAUDE_CODE_OAUTH_TOKEN;
    else delete env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!this.cfg.CLAUDE_ALLOW_LOCAL_LOGIN) {
      // isolated state dir: nothing from the operator's own ~/.claude leaks in (settings, hooks, MCP servers)
      env.CLAUDE_CONFIG_DIR = this.cfg.CLAUDE_STATE_DIR;
    }
    env.HOME = env.HOME ?? os.homedir();
    env.DISABLE_TELEMETRY = "1";
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    env.DISABLE_AUTOUPDATER = "1";
    return env;
  }

  /** argv for one turn (no secrets: the MCP config lives in a file). */
  buildArgs(mcpConfigPath: string, sessionId: string, resume: boolean, systemPrompt: string): string[] {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--strict-mcp-config",
      "--mcp-config", mcpConfigPath,
      "--tools", "",
      "--allowedTools", `mcp__${MCP_SERVER_NAME}__*`,
      "--permission-mode", "default",
      "--system-prompt", systemPrompt,
      "--model", this.cfg.CLAUDE_MODEL,
      "--max-turns", "12",
    ];
    args.push(resume ? "--resume" : "--session-id", sessionId);
    return args;
  }

  private writeMcpConfig(input: TurnInput): string {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.cfg.MCP_SHARED_TOKEN}`, "X-Teleport-User": input.principal.teleportUser };
    if (input.principal.email) headers["X-Teleport-User-Email"] = input.principal.email;
    const file = path.join(this.tmpDir, `mcp-${randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: this.cfg.MCP_URL, headers } } }), { mode: 0o600 });
    return file;
  }

  async run(input: TurnInput): Promise<TurnResult> {
    fs.mkdirSync(this.cfg.CLAUDE_STATE_DIR, { recursive: true, mode: 0o700 });
    const existing = this.sessions.get(input.sessionKey);
    let result = await this.once(input, existing ?? randomUUID(), Boolean(existing));
    if (result.resumeFailed && existing) {
      this.log.warn({ sessionKey: input.sessionKey }, "claude session could not be resumed; starting a new one");
      this.sessions.delete(input.sessionKey);
      result = await this.once(input, randomUUID(), false);
    }
    if (result.sessionId) this.sessions.set(input.sessionKey, result.sessionId);
    return result;
  }

  private async once(input: TurnInput, sessionId: string, resume: boolean): Promise<TurnResult & { resumeFailed?: boolean }> {
    const mcpFile = this.writeMcpConfig(input);
    const prompt = `${perTurnContext({ teleportUser: input.principal.teleportUser, email: input.principal.email, platform: input.platform, isApprover: input.isApprover, nowIso: new Date().toISOString() })}\n\n${input.text}`;
    const args = this.buildArgs(mcpFile, sessionId, resume, STABLE_SYSTEM);
    const parser = new StreamJsonParser(input.onDelta);
    let stderr = "";
    const started = Date.now();
    try {
      const child = this.spawnFn(this.cfg.CLAUDE_CODE_PATH, args, { env: this.buildEnv(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
      const exit = await this.drive(child, prompt, parser, (s) => (stderr += s));
      const summary = parser.end();
      const text = summary.text || (exit.code === 0 ? "(no response)" : "");
      const authFailure = (summary.isError || exit.code !== 0) && looksLikeAuthFailure(`${summary.text}\n${stderr}`);
      if (authFailure) {
        this.stale = true;
        this.log.error({ exit: exit.code, result: summary.text.slice(0, 200) }, "claude subscription authentication failed");
        return { text: "The assistant's Claude subscription login is not valid right now. An administrator needs to refresh it (make claude-token).", stopReason: "auth_error", sessionId: undefined };
      }
      if (resume && (summary.isError || exit.code !== 0) && /no conversation found|session.*not found|could not resume/i.test(`${summary.text}\n${stderr}`)) {
        return { text: "", stopReason: "resume_failed", resumeFailed: true };
      }
      if (summary.isError || exit.code !== 0) {
        this.log.error({ exit: exit.code, signal: exit.signal, result: summary.text.slice(0, 300), stderr: stderr.slice(0, 300) }, "claude turn failed");
        return { text: text || "Something went wrong talking to Claude. Please try again.", stopReason: summary.terminalReason ?? "error", sessionId: summary.sessionId };
      }
      this.stale = false;
      this.log.info({ teleportUser: input.principal.teleportUser, turns: summary.numTurns, tools: summary.toolCalls, costUsd: summary.costUsd, ms: Date.now() - started, mcp: summary.mcpServers }, "turn complete");
      return { text, stopReason: summary.stopReason ?? summary.subtype ?? null, sessionId: summary.sessionId, costUsd: summary.costUsd };
    } finally {
      fs.rm(mcpFile, { force: true }, () => undefined);
    }
  }

  private drive(child: ChildProcess, prompt: string, parser: StreamJsonParser, onStderr: (s: string) => void): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.log.warn("claude turn timed out; killing process group");
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, this.cfg.CLAUDE_TURN_TIMEOUT_MS);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => parser.feed(d));
      child.stderr?.on("data", (d: string) => onStderr(d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      // The prompt goes on stdin; EOF is what releases --print.
      child.stdin?.end(prompt);
    });
  }

  /** A one-turn, tool-less call; cheap but not free (~a few hundred tokens). Auth failures set `stale`. */
  async probe(): Promise<ProbeResult> {
    try {
      const r = await this.once({ sessionKey: `probe-${randomUUID()}`, principal: { teleportUser: "probe", email: null }, platform: "probe", isApprover: false, text: "Reply with exactly: ok" }, randomUUID(), false);
      if (r.stopReason === "auth_error") return { ok: false, detail: "claude subscription login rejected" };
      return { ok: true, detail: `claude cli ok (${this.cfg.CLAUDE_CODE_OAUTH_TOKEN ? "setup-token" : "local login"}, model ${this.cfg.CLAUDE_MODEL})` };
    } catch (e) {
      return { ok: true, detail: `probe inconclusive (${(e as Error).message})` };
    }
  }
}
