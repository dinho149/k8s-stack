import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, lstat, readlink } from 'node:fs/promises';
import { resolve, relative, join, dirname, isAbsolute } from 'node:path';
import { parse, stringify } from 'yaml';
import { configSchema, type ProjectConfig, type Project, type Task } from '../shared';

export function execute(
  command: string,
  args: string[],
  cwd: string,
  timeout = 30000,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) {
      reject(new Error('Cancelled'));
      return;
    }
    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '',
      err = '',
      size = 0;
    const stop = () => {
      proc.kill('SIGTERM');
      const kill = setTimeout(() => proc.kill('SIGKILL'), 1500);
      kill.unref();
    };
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, timeout);
    proc.stdout.on('data', (data) => {
      size += data.length;
      if (size > 20_000_000) proc.kill('SIGTERM');
      else out += data;
    });
    proc.stderr.on('data', (data) => {
      if (err.length < 100_000) err += data;
    });
    proc.on('error', (error) => {
      signal?.removeEventListener('abort', stop);
      clearTimeout(timer);
      reject(error);
    });
    proc.on('close', (code, exitSignal) => {
      signal?.removeEventListener('abort', stop);
      clearTimeout(timer);
      if (code === 0) resolveResult(out);
      else
        reject(
          new Error(`${command} ${args[0] ?? ''}: ${err.trim() || exitSignal || 'exit ' + code}`),
        );
    });
  });
}
export const git = (cwd: string, ...args: string[]) => execute('git', args, cwd);
export const hash = (content: string | Buffer) =>
  createHash('sha256').update(content).digest('hex');

export async function safePath(root: string, path: string, writing = false): Promise<string> {
  if (path.split(/[\\/]/).includes('.git'))
    throw new Error('Git internals are not editable through the workspace.');
  const base = await realpath(root),
    candidate = resolve(base, path);
  const inside = (target: string) => {
    const rel = relative(base, target);
    return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
  };
  if (!inside(candidate)) throw new Error('Path is outside this worktree.');
  let existing = candidate;
  while (true) {
    try {
      const actual = await realpath(existing);
      if (!inside(actual)) throw new Error('Symlink points outside this worktree.');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !writing) throw error;
      existing = dirname(existing);
    }
  }
  return candidate;
}
export async function files(root: string) {
  return [
    ...new Set(
      (await git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'))
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
}
export async function readSource(root: string, path: string) {
  const target = await safePath(root, path),
    stat = await lstat(target);
  if (!stat.isFile() || stat.size > 2_000_000)
    throw new Error('Select a text file smaller than 2 MB.');
  const text = await readFile(target, 'utf8');
  if (text.includes('\0')) throw new Error('Binary files cannot be edited as text.');
  return text;
}
export async function writeSource(root: string, path: string, text: string, expectedHash?: string) {
  const target = await safePath(root, path, true);
  if (expectedHash !== undefined) {
    let current = '';
    try {
      current = await readFile(target, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (hash(current) !== expectedHash)
      throw new Error('This file changed on disk. Reload before saving.');
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
}
export async function sourceHash(root: string) {
  const digest = createHash('sha256');
  for (const path of await files(root)) {
    digest.update(path + '\0');
    try {
      const target = join(root, path),
        stat = await lstat(target);
      digest.update(String(stat.mode));
      digest.update(stat.isSymbolicLink() ? await readlink(target) : await readFile(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') digest.update('deleted');
      else throw error;
    }
  }
  return digest.digest('hex');
}
export async function inspectProject(
  path: string,
): Promise<{ path: string; branch: string; config: ProjectConfig }> {
  const root = await realpath((await git(path, 'rev-parse', '--show-toplevel')).trim());
  const branch = (await git(root, 'symbolic-ref', '--short', 'HEAD')).trim();
  let config = configSchema.parse({});
  try {
    config = configSchema.parse(parse(await readFile(join(root, 'dogfood.yaml'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      const script = (name: string) => ({
        name,
        command: 'npm',
        args: ['run', name],
        cwd: '.',
        timeoutSeconds: 300,
      });
      config = configSchema.parse({
        setup: [
          { name: 'Install dependencies', command: 'npm', args: ['install'], timeoutSeconds: 600 },
        ],
        checks: ['typecheck', 'lint', 'test', 'build']
          .filter((name) => pkg.scripts?.[name])
          .map(script),
        ...(pkg.scripts?.dev
          ? {
              dev: {
                ...script('dev'),
                args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '{port}'],
              },
            }
          : {}),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { path: root, branch, config };
}
export async function saveConfig(root: string, config: ProjectConfig) {
  await writeSource(root, 'dogfood.yaml', stringify(config));
}
export async function createWorktree(project: Project, task: Task, root: string) {
  const branch = `dogfood/${task.id.slice(0, 8)}`;
  const baseRevision = (
    await git(project.path, 'rev-parse', '--verify', `${project.baseBranch}^{commit}`)
  ).trim();
  const worktree = join(root, 'worktrees', project.id, task.id);
  await mkdir(dirname(worktree), { recursive: true });
  await git(project.path, 'worktree', 'add', '-b', branch, worktree, baseRevision);
  return { branch, worktree, baseRevision };
}
export async function diff(root: string, baseRevision: string) {
  const tracked = await git(root, 'diff', '--no-ext-diff', '--no-color', baseRevision, '--');
  const untracked = (await git(root, 'ls-files', '--others', '--exclude-standard', '-z'))
    .split('\0')
    .filter(Boolean);
  const additions = await Promise.all(
    untracked.map(async (path) => {
      try {
        return `\n--- /dev/null\n+++ b/${path}\n${(await readSource(root, path))
          .split('\n')
          .map((line) => '+' + line)
          .join('\n')}`;
      } catch {
        return `\nNew binary or large file: ${path}\n`;
      }
    }),
  );
  return tracked + additions.join('');
}
