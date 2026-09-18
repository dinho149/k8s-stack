import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Artifact, Snapshot, Settings } from '../shared';
import { defaultSettings } from '../shared';

export const now = () => new Date().toISOString();
export const id = () => randomUUID();
const tables = [
  'projects',
  'ideas',
  'tasks',
  'runs',
  'artifacts',
  'usage',
  'cache',
  'settings',
  'events',
  'reservations',
] as const;
export type Table = (typeof tables)[number];
export class Store {
  db: DatabaseSync;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'artifacts'), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, 'dogfood.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version > 1)
      throw new Error('This database was created by a newer Dogfood. Upgrade before opening it.');
    this.db.exec('BEGIN');
    try {
      for (const table of tables)
        this.db.exec(
          `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
        );
      this.db.exec('PRAGMA user_version=1; COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  all<T>(table: Table): T[] {
    return this.db
      .prepare(`SELECT data FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  get<T>(table: Table, key: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(key);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  require<T>(table: Table, key: string): T {
    const value = this.get<T>(table, key);
    if (!value) throw new Error(`${table}: record not found`);
    return value;
  }
  put<T>(table: Table, key: string, value: T): T {
    this.db
      .prepare(
        `INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(key, JSON.stringify(value));
    return value;
  }
  delete(table: Table, key: string) {
    this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(key);
  }
  event(taskId: string, type: string, detail: unknown) {
    const key = id();
    this.put('events', key, { id: key, taskId, type, detail, at: now() });
  }
  settings(): Settings {
    return { ...defaultSettings, ...this.get<Settings>('settings', 'global') };
  }
  snapshot(): Omit<Snapshot, 'approvals'> {
    return {
      projects: this.all('projects'),
      ideas: this.all('ideas'),
      tasks: this.all('tasks'),
      runs: this.all('runs'),
      artifacts: this.all('artifacts'),
      usage: this.all('usage'),
      settings: this.settings(),
    };
  }
  artifact(
    taskId: string,
    kind: string,
    title: string,
    content: string,
    runId?: string,
    sourceHash?: string,
  ): Artifact {
    const key = id(),
      path = join(this.root, 'artifacts', `${key}.txt`);
    writeFileSync(path + '.tmp', content, { mode: 0o600 });
    renameSync(path + '.tmp', path);
    return this.put('artifacts', key, {
      id: key,
      taskId,
      kind,
      title,
      path,
      runId,
      sourceHash,
      createdAt: now(),
    });
  }
  readArtifact(key: string) {
    const artifact = this.require<Artifact>('artifacts', key);
    if (!/^[0-9a-f-]{36}$/.test(artifact.id)) throw new Error('Invalid artifact identifier');
    return readFileSync(join(this.root, 'artifacts', `${artifact.id}.txt`), 'utf8');
  }
  backup(destination: string) {
    // VACUUM INTO produces a consistent copy even while WAL mode is enabled.
    this.db.prepare('VACUUM INTO ?').run(destination);
  }
  close() {
    this.db.close();
  }
}
