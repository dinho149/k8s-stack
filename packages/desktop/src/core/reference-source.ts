import { lstat, readFile, realpath, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { execute, files, git, hash, safePath } from './repository';
import type { CreationInput } from '../reference';

const excluded =
  /(^|\/)(\.git|\.hg|\.svn|node_modules|vendor|\.venv|venv|dist|build|coverage|\.next|\.cache|\.dogfood|\.claude|\.codex|\.github|\.aws|\.ssh|__pycache__|test-results|playwright-report)(\/|$)|(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|credentials[^/]*|secrets?(?:\.[^/]*)?|\.netrc|id_rsa[^/]*|.*\.(?:pem|key|p12|pfx|tfstate))(\/|$)/i;
const manifest =
  /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|.*\.csproj)$/;
const evidence =
  /(^|\/)(AGENTS\.md|CLAUDE\.md|README[^/]*|Makefile|\.editorconfig|\.gitignore|.*(?:config|rc)[^/]*|.*lock.*|.*\.ya?ml)$/i;
const secretContent =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:ghp_|github_pat_|sk_live_)[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16}|["']?(?:api[_-]?key|client[_-]?secret|password|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["']?[A-Za-z0-9_\/+.-]{8,}/i;
export type ReferenceSnapshot = {
  inventory: string[];
  files: Record<string, string>;
  candidates: string[];
  revision?: string;
  label: string;
  hash: string;
  omitted: number;
};

export function githubReference(url: string) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^\/[\w.-]+\/[\w.-]+\/?$/.test(parsed.pathname)
  )
    throw new Error(
      'Use a GitHub HTTPS repository URL, such as https://github.com/team/project. Enter the branch separately.',
    );
  return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
}
export async function captureReference(
  input: CreationInput,
  storage: string,
  signal: AbortSignal,
  fetchGit: typeof execute = execute,
): Promise<ReferenceSnapshot> {
  let root: string;
  if (input.source.kind === 'github') {
    const url = githubReference(input.source.url);
    root = join(storage, 'checkout');
    const branch = input.source.branch;
    if (branch.startsWith('-') || /[\s\x00-\x1f]/.test(branch))
      throw new Error('Enter a valid Git branch name.');
    await fetchGit(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        'clone',
        '--depth',
        '1',
        '--single-branch',
        '--no-recurse-submodules',
        ...(branch ? ['--branch', branch] : []),
        '--',
        url,
        root,
      ],
      storage,
      120000,
      signal,
    );
  } else root = await realpath(input.source.path);
  signal.throwIfAborted();
  root = await realpath(root);
  if (!(await lstat(root)).isDirectory()) throw new Error('Choose a project directory.');
  let inventory: string[];
  let revision: string | undefined;
  try {
    const top = (await git(root, 'rev-parse', '--show-toplevel')).trim();
    const prefix = relative(await realpath(top), root).replaceAll('\\', '/');
    inventory = (await files(top))
      .filter((p) => !prefix || p.startsWith(prefix + '/'))
      .map((p) => (prefix ? p.slice(prefix.length + 1) : p));
    revision = (await git(top, 'rev-parse', 'HEAD')).trim();
  } catch {
    // A plain directory can still have .gitignore rules. Use a temporary index
    // outside the reference rather than initializing or changing its repository.
    const gitDirectory = join(storage, 'inventory.git');
    await mkdir(storage, { recursive: true });
    await rm(gitDirectory, { recursive: true, force: true });
    try {
      await execute('git', ['init', '--bare', '--template=', gitDirectory], storage, 30000, signal);
      inventory = (
        await execute(
          'git',
          [
            '--git-dir',
            gitDirectory,
            '--work-tree',
            root,
            'ls-files',
            '--others',
            '--exclude-standard',
            '-z',
          ],
          root,
          30000,
          signal,
        )
      )
        .split('\0')
        .filter(Boolean);
    } finally {
      await rm(gitDirectory, { recursive: true, force: true });
    }
  }

  inventory = inventory.filter((p) => !excluded.test(p)).sort();
  if (inventory.length > 10000)
    throw new Error('Reference is too large. Select a smaller project directory.');
  const candidates = [
    ...new Set(
      inventory
        .filter((p) => manifest.test(p))
        .map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.')),
    ),
  ].sort();
  const selected: Record<string, string> = Object.create(null);
  let size = 0;
  // Give each package a fair share before taking additional examples.
  const priority = (p: string) =>
    manifest.test(p) ? 0 : evidence.test(p) ? 1 : /(?:src|app|lib|test|spec)/i.test(p) ? 2 : 3;
  for (const path of [...inventory].sort(
    (a, b) => priority(a) - priority(b) || a.localeCompare(b),
  )) {
    signal.throwIfAborted();
    try {
      const target = await safePath(root, path);
      const stat = await lstat(target);
      if (!stat.isFile() || stat.size > 64000 || size + stat.size > 500000) continue;
      const content = await readFile(target, 'utf8');
      if (
        content.includes('\0') ||
        secretContent.test(content) ||
        Object.keys(selected).length >= 160
      )
        continue;
      selected[path] = content;
      size += stat.size;
    } catch {
      /* Missing files, symlinks and unreadable files are not reference evidence. */
    }
  }
  if (!Object.keys(selected).length)
    throw new Error('No readable project files found in this reference.');
  const label =
    input.source.kind === 'github' ? githubReference(input.source.url) : root.split('/').at(-1)!;
  const snapshot = {
    inventory,
    files: selected,
    candidates,
    revision,
    label,
    hash: hash(JSON.stringify(selected)),
    omitted: inventory.length - Object.keys(selected).length,
  };
  await mkdir(storage, { recursive: true });
  await writeFile(join(storage, 'snapshot.json.tmp'), JSON.stringify(snapshot), { mode: 0o600 });
  await rename(join(storage, 'snapshot.json.tmp'), join(storage, 'snapshot.json'));
  return snapshot;
}
export function scopedSnapshot(snapshot: ReferenceSnapshot, subdirectory: string) {
  const scope = subdirectory.trim().replace(/\/$/, '') || '.';
  if (isAbsolute(scope) || scope.split(/[\\/]/).some((p) => p === '..') || scope.includes('\\'))
    throw new Error('Select a directory within the reference.');
  const inside = (p: string) => scope === '.' || p.startsWith(scope + '/');
  if (scope !== '.' && !snapshot.inventory.some(inside))
    throw new Error('The selected subdirectory was not found in the reference snapshot.');
  const scoped = Object.fromEntries(
    Object.entries(snapshot.files).filter(
      ([p]) => inside(p) || (!p.includes('/') && (manifest.test(p) || evidence.test(p))),
    ),
  );
  return {
    scope,
    inventory: snapshot.inventory.filter(inside).slice(0, 1500),
    files: scoped,
    omitted: snapshot.omitted,
  };
}
