import { join } from 'node:path';
import { chmod, mkdir, cp, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Store, id, now } from './core/store';
import { Engine } from './core/engine';
import { mcpMain, serveTools } from './core/mcp';
import type { Request, Settings, Task, Project, DesktopEvent } from './shared';
import { defaultSettings } from './shared';

if (process.argv.includes('--mcp')) {
  const index = process.argv.indexOf('--mcp');
  mcpMain(process.argv[index + 1], process.argv[index + 2]);
} else {
  const parent = (
    process as unknown as {
      parentPort: {
        on(name: string, fn: (event: { data: any }) => void): void;
        postMessage(value: unknown): void;
      };
    }
  ).parentPort;
  let engine: Engine, store: Store, root: string;
  const terminals = new Map<string, { taskId: string; pty: import('node-pty').IPty }>();
  const send = (event: DesktopEvent) => parent.postMessage({ event });
  const initialize = async (data: any) => {
    root = data.root;
    store = new Store(root);
    engine = new Engine(store, send, data.secrets);
    const socket = join(root, 'tools.sock'),
      token = randomBytes(32).toString('hex');
    await serveTools(socket, token, (runId, name, args) => engine.callTool(runId, name, args));
    engine.runtime = { command: data.runtime, script: __filename, socket, token };
    const settings = {
      ...defaultSettings,
      ...store.settings(),
      hasClaudeKey: !!data.secrets.claudeKey,
      hasPlatformToken: !!data.secrets.platformToken,
    };
    store.put('settings', 'global', settings);
    parent.postMessage({ ready: true });
  };
  parent.on('message', ({ data }) => {
    if (data.init) {
      void initialize(data.init).catch((error) => parent.postMessage({ fatal: String(error) }));
      return;
    }
    if (data.shutdown) {
      engine?.shutdown();
      for (const terminal of terminals.values()) terminal.pty.kill();
      setTimeout(() => process.exit(0), 1700);
      return;
    }
    void (async () => {
      let result: unknown;
      const params = data.params ?? {};
      if (data.method === 'settings.save') {
        const settings = z
          .object({
            codexPath: z.string().min(1),
            claudePath: z.string().min(1),
            claudeProvider: z.enum(['api', 'bedrock', 'vertex']),
            region: z.string(),
            vertexProject: z.string(),
            platformUrl: z.string().url(),
            prices: z.array(
              z.object({
                model: z.string().min(1),
                provider: z.enum(['codex', 'claude']),
                input: z.number().nonnegative(),
                cached: z.number().nonnegative(),
                cacheWrite: z.number().nonnegative(),
                output: z.number().nonnegative(),
                date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              }),
            ),
          })
          .parse(params.settings);
        Object.assign(engine.secrets, params.secrets ?? {});
        store.put('settings', 'global', {
          ...settings,
          hasClaudeKey: !!engine.secrets.claudeKey,
          hasPlatformToken: !!engine.secrets.platformToken,
        });
        engine.ledger.repriceUnknown();
        engine.changed();
        result = true;
      } else if (data.method === 'terminal.open') {
        const task = store.require<Task>('tasks', z.string().uuid().parse(params.id));
        if (engine.active.has(task.id))
          throw new Error('Pause the task agent before opening a writing terminal.');
        const prepared = await engine.prepare(task);
        const key = id();
        const { spawn } = await import('node-pty');
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env))
          if (v !== undefined && !/TOKEN|SECRET|API_KEY|PASSWORD|^DOGFOOD_/.test(k)) env[k] = v;
        const pty = spawn(process.env.SHELL ?? '/bin/zsh', [], {
          cwd: prepared.worktree,
          env,
          name: 'xterm-256color',
          cols: 100,
          rows: 24,
        });
        terminals.set(key, { taskId: task.id, pty });
        pty.onData((text) => send({ type: 'terminal', taskId: task.id, terminalId: key, text }));
        pty.onExit(() => {
          terminals.delete(key);
          send({
            type: 'terminal',
            taskId: task.id,
            terminalId: key,
            text: '\r\n[Terminal exited]\r\n',
          });
        });
        result = key;
      } else if (data.method.startsWith('terminal.')) {
        const key = z.string().uuid().parse(params.terminalId),
          terminal = terminals.get(key);
        if (!terminal) throw new Error('Terminal is closed.');
        if (data.method === 'terminal.write') {
          if (engine.active.has(terminal.taskId))
            throw new Error('Pause the agent before typing in the terminal.');
          terminal.pty.write(z.string().max(64000).parse(params.text));
          const task = store.require<Task>('tasks', terminal.taskId);
          engine.update(task, {
            validatedHash: undefined,
            reviewedHash: undefined,
            approvedHash: undefined,
          });
        } else if (data.method === 'terminal.resize')
          terminal.pty.resize(
            z.number().int().min(10).max(500).parse(params.cols),
            z.number().int().min(2).max(200).parse(params.rows),
          );
        else if (data.method === 'terminal.close') {
          terminal.pty.kill();
          terminals.delete(key);
        } else throw new Error('Unknown terminal operation');
        result = true;
      } else if (data.method === 'backup.create') {
        const destination = z.string().parse(params.path);
        await mkdir(destination, { recursive: false });
        store.backup(join(destination, 'dogfood.sqlite'));
        await cp(join(root, 'artifacts'), join(destination, 'artifacts'), { recursive: true });
        await writeFile(
          join(destination, 'README.txt'),
          'Dogfood history backup. Repository and worktree files remain at their original paths and should be backed up separately. Credentials are not included.\n',
        );
        result = destination;
      } else if (data.method === 'backup.restore') {
        if (engine.active.size || engine.runner.apps.size || terminals.size)
          throw new Error('Stop tasks, applications, and terminals before restoring.');
        const source = z.string().parse(params.path),
          database = join(source, 'dogfood.sqlite');
        const check = new DatabaseSync(database, { readOnly: true });
        try {
          const row = check.prepare('PRAGMA integrity_check').get();
          if (row?.integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
          const version = check.prepare('PRAGMA user_version').get();
          if (version?.user_version !== 1) throw new Error('Unsupported backup schema.');
        } finally {
          check.close();
        }
        const savedSecrets = { ...engine.secrets };
        store.backup(join(root, `before-restore-${Date.now()}.sqlite`));
        store.close();
        await rm(join(root, 'dogfood.sqlite-wal'), { force: true });
        await rm(join(root, 'dogfood.sqlite-shm'), { force: true });
        await cp(database, join(root, 'dogfood.sqlite'));
        await cp(join(source, 'artifacts'), join(root, 'artifacts'), { recursive: true });
        store = new Store(root);
        const runtime = engine.runtime;
        engine = new Engine(store, send, savedSecrets);
        engine.runtime = runtime;
        engine.changed();
        result = true;
      } else if (data.method === 'export.task') {
        const task = store.require<Task>('tasks', z.string().uuid().parse(params.id));
        const exported = {
          task,
          runs: store.all<any>('runs').filter((r) => r.taskId === task.id),
          usage: store.all<any>('usage').filter((r) => r.taskId === task.id),
          artifacts: store
            .all<any>('artifacts')
            .filter((r) => r.taskId === task.id)
            .map((a) => ({ ...a, content: store.readArtifact(a.id) })),
        };
        await writeFile(z.string().parse(params.path), JSON.stringify(exported, null, 2), {
          mode: 0o600,
        });
        result = true;
      } else if (data.method === 'screenshot.add') {
        const task = store.require<Task>('tasks', z.string().uuid().parse(params.id));
        result = store.artifact(
          task.id,
          'screenshot',
          'Local preview screenshot',
          z.string().max(20000000).parse(params.image),
        );
        engine.changed();
      } else {
        if (data.method === 'task.action' && params.action !== 'pause') {
          for (const [key, terminal] of terminals)
            if (terminal.taskId === params.id) {
              terminal.pty.kill();
              terminals.delete(key);
            }
        }
        result = await engine.dispatch(data.method, params);
      }
      parent.postMessage({ id: data.id, result });
    })().catch((error) =>
      parent.postMessage({
        id: data.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}
