import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command, Task, Project } from '../shared';
import { safePath } from './repository';

export type CommandResult = {
  code: number;
  output: string;
  durationMs: number;
  truncated: boolean;
};
export class Runner {
  running = new Map<string, Set<ChildProcess>>();
  starting = new Map<string, Promise<string>>();
  apps = new Map<string, { url: string; port: number; stop: () => void }>();
  constructor(
    readonly root: string,
    readonly output: (taskId: string, text: string) => void,
    readonly appFinished?: (task: Task, result: CommandResult) => void,
  ) {}
  async run(
    task: Task,
    command: Command,
    signal?: AbortSignal,
    variables: Record<string, string> = {},
  ): Promise<CommandResult> {
    if (!task.worktree) throw new Error('Create a task worktree first.');
    if (signal?.aborted) throw new Error('Cancelled');
    const cwd = await safePath(task.worktree, command.cwd);
    const data = join(this.root, 'data', task.id);
    await mkdir(data, { recursive: true });
    const replace = (value: string) =>
      value.replace(
        /\{(port|data)\}/g,
        (_, name) => variables[name] ?? (name === 'data' ? data : ''),
      );
    const started = Date.now();
    return new Promise((resolveResult, reject) => {
      const env = {
        ...process.env,
        PORT: variables.port ?? '',
        DOGFOOD_TASK_DATA: data,
        CI: '1',
        FORCE_COLOR: '0',
      };
      // Credentials belong to agent adapters, not application/test processes.
      for (const key of Object.keys(env))
        if (/TOKEN|SECRET|API_KEY|PASSWORD|^DOGFOOD_LOCAL/.test(key))
          delete (env as Record<string, unknown>)[key];
      const proc = spawn(command.command, command.args.map(replace), {
        cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const processes = this.running.get(task.id) ?? new Set();
      processes.add(proc);
      this.running.set(task.id, processes);
      let output = '',
        truncated = false,
        timedOut = false;
      const receive = (data: Buffer) => {
        const text = data.toString();
        this.output(task.id, text);
        if (output.length < 20_000_000) output += text;
        else truncated = true;
      };
      proc.stdout.on('data', receive);
      proc.stderr.on('data', receive);
      const stop = () => this.kill(proc);
      const timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, command.timeoutSeconds * 1000);
      signal?.addEventListener('abort', stop, { once: true });
      const clean = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', stop);
        processes.delete(proc);
      };
      proc.on('error', (error) => {
        clean();
        reject(error);
      });
      proc.on('close', (code) => {
        clean();
        resolveResult({
          code: signal?.aborted ? 130 : timedOut ? 124 : (code ?? 1),
          output: output + (truncated ? '\n[20 MB log limit reached]' : ''),
          durationMs: Date.now() - started,
          truncated,
        });
      });
    });
  }
  private kill(proc: ChildProcess) {
    if (!proc.pid) return;
    const send = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === 'win32') proc.kill(signal);
        else process.kill(-proc.pid!, signal);
      } catch {}
    };
    send('SIGTERM');
    const timer = setTimeout(() => send('SIGKILL'), 1500);
    timer.unref();
  }
  stop(taskId: string) {
    this.apps.get(taskId)?.stop();
    for (const proc of this.running.get(taskId) ?? []) this.kill(proc);
    this.apps.delete(taskId);
  }
  stopAll() {
    for (const key of this.running.keys()) this.stop(key);
  }
  start(task: Task, project: Project) {
    const pending = this.starting.get(task.id);
    if (pending) return pending;
    const result = this.startOwned(task, project).finally(() => this.starting.delete(task.id));
    this.starting.set(task.id, result);
    return result;
  }
  private async startOwned(task: Task, project: Project) {
    if (!project.config.dev)
      throw new Error('Configure a development command in Project settings.');
    if (this.apps.has(task.id)) return this.apps.get(task.id)!.url;
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port;
        server.close(() => resolvePort(port));
      });
    });
    const url = `http://127.0.0.1:${port}`,
      controller = new AbortController();
    this.apps.set(task.id, { url, port, stop: () => controller.abort() });
    let failure: string | undefined;
    void this.run(task, { ...project.config.dev, timeoutSeconds: 86400 }, controller.signal, {
      port: String(port),
    })
      .then((result) => {
        this.appFinished?.(task, result);
        failure = `Development server exited (${result.code}). ${result.output.slice(-1500)}`;
        this.apps.delete(task.id);
      })
      .catch((error) => {
        failure = String(error);
        this.apps.delete(task.id);
      });
    for (let attempt = 0; attempt < 90; attempt++) {
      if (controller.signal.aborted) throw new Error('Local preview stopped.');
      if (failure) throw new Error(failure);
      try {
        const response = await fetch(new URL(project.config.readinessPath, url), {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) return url;
      } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    controller.abort();
    this.apps.delete(task.id);
    throw new Error('App did not become ready in 45 seconds. Check the run command and logs.');
  }
  async compose(task: Task, project: Project, action: 'up' | 'down') {
    if (!project.config.composeFile) throw new Error('No Compose file configured.');
    const file = await safePath(task.worktree!, project.config.composeFile);
    return this.run(task, {
      name: `Compose ${action}`,
      command: 'docker',
      args: [
        'compose',
        '--project-name',
        `dogfood-${task.id.slice(0, 8)}`,
        '-f',
        file,
        action,
        ...(action === 'up' ? ['-d'] : []),
      ],
      cwd: '.',
      timeoutSeconds: 300,
    });
  }
}
