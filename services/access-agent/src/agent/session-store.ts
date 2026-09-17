/**
 * Append-only per-thread conversation history. Full content blocks are kept (tool_use, tool_result,
 * thinking) so replays stay valid; the oldest whole turns are dropped beyond SESSION_MAX_TURNS.
 */
import * as fs from "node:fs";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta";

export interface SessionStore {
  get(key: string): Promise<BetaMessageParam[]>;
  append(key: string, ...messages: BetaMessageParam[]): Promise<void>;
  clear(key: string): Promise<void>;
}

export function sessionKey(platform: string, channelId: string, threadId?: string, userId?: string): string {
  return `${platform}:${channelId}:${threadId ?? userId ?? "root"}`;
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
      if (fs.existsSync(file)) this.data = new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))));
    } catch {
      this.data = new Map();
    }
  }
  protected override async persist(): Promise<void> {
    await fs.promises.mkdir(require("node:path").dirname(this.file), { recursive: true }).catch(() => undefined);
    await fs.promises.writeFile(this.file, JSON.stringify(Object.fromEntries(this.data)), "utf8");
  }
}
