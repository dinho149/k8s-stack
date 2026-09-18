/**
 * Thread key -> Claude Code session id (subscription backend keeps conversation state inside
 * Claude Code's own session files under CLAUDE_STATE_DIR). Owner-only on disk.
 */
import * as fs from "node:fs";
import { ensurePrivateFile, writePrivateFile } from "./session-store.js";

export interface SessionIdStore {
  get(key: string): string | undefined;
  set(key: string, sessionId: string): void;
  delete(key: string): void;
}

export class MemorySessionIdStore implements SessionIdStore {
  protected data = new Map<string, string>();
  get(key: string): string | undefined {
    return this.data.get(key);
  }
  set(key: string, sessionId: string): void {
    this.data.set(key, sessionId);
    this.persist();
  }
  delete(key: string): void {
    this.data.delete(key);
    this.persist();
  }
  protected persist(): void {}
}

export class FileSessionIdStore extends MemorySessionIdStore {
  constructor(private readonly file: string) {
    super();
    try {
      ensurePrivateFile(file);
      if (fs.existsSync(file)) this.data = new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))));
    } catch {
      this.data = new Map();
    }
  }
  protected override persist(): void {
    try {
      writePrivateFile(this.file, JSON.stringify(Object.fromEntries(this.data)));
    } catch {
      /* best effort */
    }
  }
}
