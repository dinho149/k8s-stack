/**
 * Append-only per-thread conversation history. Full content blocks are kept (tool_use, tool_result,
 * thinking) so replays stay valid; the oldest whole turns are dropped beyond SESSION_MAX_TURNS.
 *
 * Keys always include the user id, so two people in the same thread never share a transcript.
 * Transcripts on disk are owner-only (0600 in a 0700 directory).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta";

export interface SessionStore {
  get(key: string): Promise<BetaMessageParam[]>;
  append(key: string, ...messages: BetaMessageParam[]): Promise<void>;
  clear(key: string): Promise<void>;
}

export function sessionKey(platform: string, channelId: string, threadId: string | undefined, userId: string): string {
  if (!userId) throw new Error("session key needs a user id");
  return `${platform}:${channelId}:${threadId ?? "root"}:${userId}`;
}

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

/** Creates the parent directory 0700 and makes sure an existing file is 0600. */
export function ensurePrivateFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  try {
    const st = fs.statSync(file);
    if ((st.mode & 0o777) !== FILE_MODE) fs.chmodSync(file, FILE_MODE);
  } catch {
    /* not there yet */
  }
}

/** Atomic owner-only write: temp file (0600) + rename. */
export function writePrivateFile(file: string, data: string): void {
  ensurePrivateFile(file);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { encoding: "utf8", mode: FILE_MODE });
  fs.chmodSync(tmp, FILE_MODE);
  fs.renameSync(tmp, file);
}

export class MemorySessionStore implements SessionStore {
  protected data = new Map<string, BetaMessageParam[]>();
  constructor(protected readonly maxTurns = 40) {}

  async get(key: string): Promise<BetaMessageParam[]> {
    return [...(this.data.get(key) ?? [])];
  }
  async append(key: string, ...messages: BetaMessageParam[]): Promise<void> {
    const cur = this.data.get(key) ?? [];
    cur.push(...messages);
    // drop oldest user turns as whole units (user..assistant) to keep tool_use/tool_result pairs intact
    while (cur.length > this.maxTurns) {
      const firstUser = cur.findIndex((m, i) => i > 0 && m.role === "user" && typeof m.content === "string");
      if (firstUser <= 0) break;
      cur.splice(0, firstUser);
    }
    this.data.set(key, cur);
    await this.persist();
  }
  async clear(key: string): Promise<void> {
    this.data.delete(key);
    await this.persist();
  }
  protected async persist(): Promise<void> {}
}

export class FileSessionStore extends MemorySessionStore {
  constructor(private readonly file: string, maxTurns = 40) {
    super(maxTurns);
    try {
      ensurePrivateFile(file);
      if (fs.existsSync(file)) this.data = new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))));
    } catch {
      this.data = new Map();
    }
  }
  protected override async persist(): Promise<void> {
    writePrivateFile(this.file, JSON.stringify(Object.fromEntries(this.data)));
  }
}
