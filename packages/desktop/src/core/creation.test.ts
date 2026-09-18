import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store';
import { Engine } from './engine';
import { git, hash, sourceHash } from './repository';
import { ContextBroker } from './context';
import { githubReference, captureReference } from './reference-source';
import type { HarnessAdapter, HarnessInput } from './harness';
import type { CreationInput, CreationJob, ConventionProfile } from '../reference';

const command = (name: string, args: string[]) => ({
  name,
  command: process.execPath,
  args,
  cwd: '.',
  timeoutSeconds: 10,
});
const profile: ConventionProfile = {
  stack: 'Node.js application following the reference’s kebab-case CommonJS conventions',
  packageManager: 'npm',
  structure: ['src/greeting.cjs', 'test/greeting.test.cjs'],
  conventions: 'Use kebab-case filenames. Keep tests in test/. Export small pure functions.',
  prerequisites: 'Node.js',
  uncertainties: [],
  evidence: ['package.json'],
  commands: {
    setup: [],
    checks: [command('Unit tests', ['--test', 'test/greeting.test.cjs'])],
    dev: command('Local app', ['src/server.cjs']),
    readinessPath: '/',
  },
};
const manifest = {
  files: [
    { path: 'package.json', content: JSON.stringify({ name: 'fresh-app', private: true }) },
    { path: 'src/greeting.cjs', content: 'module.exports = name => `Hello, ${name}!`;' },
    {
      path: 'src/server.cjs',
      content:
        "require('node:http').createServer((req,res)=>res.end(require('./greeting.cjs')('world'))).listen(Number(process.env.PORT),'127.0.0.1');",
    },
    {
      path: 'test/greeting.test.cjs',
      content:
        "const test=require('node:test'); const assert=require('node:assert/strict'); test('greets a name',()=>assert.equal(require('../src/greeting.cjs')('Ada'),'Hello, Ada!'));",
    },
    { path: '.gitignore', content: 'node_modules/\n' },
  ],
};
class Fixture implements HarnessAdapter {
  calls: HarnessInput[] = [];
  manifest = structuredClone(manifest);
  profile = structuredClone(profile);
  block = false;
  async run(input: HarnessInput, emit: Parameters<HarnessAdapter['run']>[1]) {
    this.calls.push(input);
    assert.equal(input.readOnly, true);
    if (this.block)
      await new Promise<void>((_, reject) =>
        input.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        }),
      );
    emit({
      type: 'usage',
      usage: {
        requestId: 'one',
        provider: 'codex',
        model: 'fixture',
        input: 100,
        cached: 10,
        cacheWrite: 0,
        output: 100,
        reasoning: 0,
        costUsd: 0.01,
        costKind: 'reported',
      },
    });
    return {
      text: JSON.stringify(
        input.prompt.includes('Analyze reference conventions') ? this.profile : this.manifest,
      ),
    };
  }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'dogfood-reference-')),
    source = join(root, 'reference'),
    destination = join(root, 'new-app');
  await mkdir(source);
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({ name: 'old-product', dependencies: { astro: '^5.0.0' } }),
  );
  await writeFile(join(source, 'AGENTS.md'), 'Use kebab-case filenames.');
  await writeFile(join(source, 'business.cjs'), "module.exports = 'old product business logic';");
  await git(source, 'init', '-b', 'main');
  await git(source, 'add', '.');
  await git(
    source,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@local',
    'commit',
    '-m',
    'source',
  );
  const store = new Store(join(root, 'state')),
    adapter = new Fixture(),
    engine = new Engine(store, () => {}, {}, { codex: adapter, claude: adapter });
  const input: CreationInput = {
    source: { kind: 'local', path: source },
    name: 'Fresh app',
    destination,
    description: 'A new application',
    subdirectory: '',
    role: { harness: 'codex', model: 'fixture', effort: 'high' },
  };
  t.after(async () => {
    engine.shutdown();
    while (engine.creations.active.size) await new Promise((r) => setTimeout(r, 10));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, destination, store, adapter, engine, input };
}
async function settled(engine: Engine, id: string) {
  const start = Date.now();
  while (engine.creations.active.has(id)) {
    if (Date.now() - start > 20000) throw new Error('creation timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
  return engine.creations.get(id);
}
async function review(f: Awaited<ReturnType<typeof fixture>>) {
  const job = (await f.engine.dispatch('creation.start', { input: f.input })) as CreationJob;
  const result = await settled(f.engine, job.id);
  assert.equal(result.status, 'review', result.error);
  return result;
}

test('reference creation analyzes, verifies startup and tests, keeps fresh history and task context', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.source, 'AGENTS.md'),
    'Use kebab-case filenames. Include current uncommitted instructions.',
  );
  const before = await sourceHash(f.source),
    job = await review(f);
  assert.match(f.adapter.calls[0].prompt, /uncommitted instructions/);
  assert.match(f.adapter.calls[0].prompt, /astro/);
  await f.engine.dispatch('creation.generate', { id: job.id, profile: job.profile });
  const complete = await settled(f.engine, job.id);
  assert.equal(complete.status, 'complete', complete.error);
  assert.equal(complete.verified, true);
  assert.equal(complete.usage.length, 2);
  assert.match(complete.log, /Local startup passed/);
  assert.equal(f.store.snapshot().projects.length, 1);
  assert.equal(f.store.snapshot().tasks.length, 0);
  assert.equal(await sourceHash(f.source), before);
  assert.equal((await git(f.destination, 'rev-list', '--count', 'HEAD')).trim(), '1');
  assert.equal((await git(f.destination, 'remote')).trim(), '');
  assert.equal((await git(f.destination, 'status', '--porcelain')).trim(), '');
  assert.equal(
    await readFile(join(f.destination, 'package.json'), 'utf8'),
    manifest.files[0].content,
  );
  const context = await new ContextBroker(f.store).package(f.destination, 'greeting');
  assert.match(context, /REFERENCE.md/);
  assert.match(context, /kebab-case/);
  assert.equal((await readdir(f.destination)).includes('business.cjs'), false);
});

test('monorepo requires explicit scope and keeps unrelated package code out of analysis', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, 'apps', 'web'), { recursive: true });
  await mkdir(join(f.source, 'apps', 'other'), { recursive: true });
  await writeFile(join(f.source, 'apps', 'web', 'package.json'), '{"name":"web"}');
  await writeFile(join(f.source, 'apps', 'other', 'package.json'), '{"name":"unrelated-product"}');
  const started = await f.engine.creations.start(f.input),
    job = await settled(f.engine, started.id);
  assert.equal(job.status, 'awaiting-scope');
  assert.equal(f.adapter.calls.length, 0);
  await f.engine.dispatch('creation.scope', { id: job.id, subdirectory: 'apps/web' });
  assert.equal((await settled(f.engine, job.id)).status, 'review');
  assert.doesNotMatch(f.adapter.calls[0].prompt, /unrelated-product/);
  assert.match(f.adapter.calls[0].prompt, /apps\/web\/package.json/);
});

test('snapshot skips secrets, ignored files and escaping symlinks for local and non-Git projects', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, '.env'), 'SECRET=never-send');
  await writeFile(join(f.source, 'credentials.json'), 'never-send');
  await writeFile(join(f.source, 'settings.yaml'), 'api_key: never-send-credentials');
  await writeFile(join(f.source, '.gitignore'), 'private.txt\n');
  await writeFile(join(f.source, 'private.txt'), 'never-send');
  await symlink(join(f.source, '..', 'outside'), join(f.source, 'escape'));
  await writeFile(join(f.root, 'outside'), 'never-send');
  const storage = join(f.root, 'capture');
  await mkdir(storage);
  const snapshot = await captureReference(f.input, storage, new AbortController().signal);
  assert.doesNotMatch(JSON.stringify(snapshot.files), /never-send/);
  await rm(join(f.source, '.git'), { recursive: true });
  const plain = await captureReference(f.input, storage, new AbortController().signal);
  assert.doesNotMatch(JSON.stringify(plain.files), /never-send/);
  assert.equal(plain.files['.env'], undefined);
  assert.equal(plain.files.escape, undefined);
});

test('failed verification is saved and retry preserves external file edits', async (t) => {
  const f = await fixture(t);
  f.adapter.manifest.files.find((file) => file.path === 'src/greeting.cjs')!.content =
    "module.exports = name => 'broken';";
  const job = await review(f);
  await f.engine.dispatch('creation.generate', { id: job.id, profile: job.profile });
  let result = await settled(f.engine, job.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.materialized, true);
  assert.equal(f.store.snapshot().projects.length, 0);
  await writeFile(
    join(f.destination, 'src/greeting.cjs'),
    '// User repair\nmodule.exports = name => `Hello, ${name}!`;\n',
  );
  await writeFile(join(f.destination, 'src/repair-helper.cjs'), 'module.exports = true;');
  const count = f.adapter.calls.length;
  await f.engine.dispatch('creation.retry', { id: job.id });
  result = await settled(f.engine, job.id);
  assert.equal(result.status, 'complete', result.error);
  assert.equal(f.adapter.calls.length, count);
  assert.match(await git(f.destination, 'ls-files'), /src\/repair-helper.cjs/);
  assert.match(await readFile(join(f.destination, 'src/greeting.cjs'), 'utf8'), /User repair/);
});

test('destination race and unsafe generated paths do not overwrite files', async (t) => {
  const f = await fixture(t),
    job = await review(f);
  await mkdir(f.destination);
  await writeFile(join(f.destination, 'keep.txt'), 'keep');
  await f.engine.dispatch('creation.generate', { id: job.id, profile: job.profile });
  let result = await settled(f.engine, job.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /no longer empty/);
  assert.equal(await readFile(join(f.destination, 'keep.txt'), 'utf8'), 'keep');
  await rm(f.destination, { recursive: true });
  f.adapter.manifest = { files: [{ path: '../escaped.txt', content: 'bad' }] };
  await f.engine.dispatch('creation.generate', { id: job.id, profile: job.profile });
  result = await settled(f.engine, job.id);
  assert.match(result.error!, /Unsafe generated path/);
  assert.equal((await readdir(f.root)).includes('escaped.txt'), false);
});

test('cancellation stops a paid stage and restart marks active drafts interrupted without resuming', async (t) => {
  const f = await fixture(t);
  f.adapter.block = true;
  const job = await f.engine.creations.start(f.input);
  while (!f.adapter.calls.length) await new Promise((r) => setTimeout(r, 10));
  await f.engine.dispatch('creation.cancel', { id: job.id });
  assert.equal((await settled(f.engine, job.id)).status, 'cancelled');
  f.engine.creations.update(job.id, { status: 'generating' });
  const restarted = new Engine(f.store, () => {}, {}, { codex: f.adapter, claude: f.adapter });
  assert.equal(restarted.creations.get(job.id).status, 'interrupted');
  assert.equal(f.adapter.calls.length, 1);
  restarted.shutdown();
});

test('GitHub URLs reject credentials, ambiguous tree links and other transports', () => {
  assert.equal(
    githubReference('https://github.com/team/project/'),
    'https://github.com/team/project',
  );
  for (const url of [
    'https://token@github.com/team/project',
    'https://example.com/team/project',
    'https://github.com/team/project/tree/main',
    'file:///tmp/repo',
    'https://github.com/team/project?token=secret',
  ])
    assert.throws(() => githubReference(url));
});

test('invalid profile commands and nested destination are rejected before creation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.engine.creations.start({ ...f.input, destination: join(f.source, 'child') }),
    /outside the reference/,
  );
  const job = await review(f);
  const changed = structuredClone(job.profile!);
  changed.commands.checks[0].cwd = '../outside';
  await assert.rejects(
    f.engine.dispatch('creation.generate', { id: job.id, profile: changed }),
    /inside the new workspace/,
  );
  assert.equal((await readdir(f.root)).includes('new-app'), false);
});

test('GitHub capture handles canonical paths and propagates authentication failures without an agent call', async (t) => {
  const f = await fixture(t),
    storage = join(f.root, 'remote');
  await mkdir(storage);
  const input = {
    ...f.input,
    source: {
      kind: 'github' as const,
      url: 'https://github.com/example/reference',
      branch: 'main',
    },
  };
  const snapshot = await captureReference(
    input,
    storage,
    new AbortController().signal,
    async (_command, args) => {
      assert.ok(args.includes('--no-recurse-submodules'));
      await git(storage, 'clone', '--', f.source, args.at(-1)!);
      return '';
    },
  );
  assert.match(snapshot.files['package.json'], /astro/);
  assert.equal(snapshot.label, input.source.url);
  assert.ok(snapshot.revision);
  await assert.rejects(
    captureReference(input, storage, new AbortController().signal, async () => {
      throw new Error('Authentication failed. Sign in to GitHub.');
    }),
    /Authentication failed/,
  );
  assert.equal(f.adapter.calls.length, 0);
});

test('bounded repairs fix application source without changing tests or commands', async (t) => {
  const f = await fixture(t);
  f.adapter.manifest.files.find((file) => file.path === 'src/greeting.cjs')!.content =
    "module.exports = () => 'broken';";
  const originalRun = f.adapter.run.bind(f.adapter);
  f.adapter.run = async (input, emit) =>
    input.prompt.includes('Repair the generated application')
      ? {
          text: JSON.stringify({
            files: [manifest.files.find((file) => file.path === 'src/greeting.cjs')],
          }),
        }
      : originalRun(input, emit);
  const job = await review(f);
  await f.engine.dispatch('creation.generate', { id: job.id, profile: job.profile });
  const result = await settled(f.engine, job.id);
  assert.equal(result.status, 'complete', result.error);
  assert.equal(result.repairs, 1);
  assert.equal(
    await readFile(join(f.destination, 'test/greeting.test.cjs'), 'utf8'),
    manifest.files.find((file) => file.path === 'test/greeting.test.cjs')!.content,
  );
  assert.equal(result.usage.at(-1)!.costKind, 'unknown');
});

test('command review refuses stale writes and verification retains explicitly edited commands', async (t) => {
  const f = await fixture(t);
  f.adapter.profile.commands.checks = [command('Missing test', ['missing.cjs'])];
  const job = await review(f);
  await f.engine.dispatch('creation.generate', { id: job.id, profile: job.profile });
  assert.equal((await settled(f.engine, job.id)).status, 'failed');
  let reviewed = (await f.engine.dispatch('creation.review-commands', {
    id: job.id,
  })) as CreationJob;
  const path = join(f.destination, 'dogfood.yaml');
  await writeFile(path, (await readFile(path, 'utf8')) + '# external edit\n');
  await assert.rejects(
    f.engine.dispatch('creation.generate', { id: job.id, profile: reviewed.profile }),
    /changed on disk/,
  );
  reviewed = (await f.engine.dispatch('creation.review-commands', { id: job.id })) as CreationJob;
  reviewed.profile!.commands = structuredClone(profile.commands);
  await f.engine.dispatch('creation.generate', { id: job.id, profile: reviewed.profile });
  const result = await settled(f.engine, job.id);
  assert.equal(result.status, 'complete', result.error);
});

test('saved proposals persist without starting generation and budget failures can be retried', async (t) => {
  const f = await fixture(t);
  const started = await f.engine.creations.start({ ...f.input, budgetUsd: 0.001 });
  let job = await settled(f.engine, started.id);
  assert.equal(job.status, 'failed');
  assert.match(job.error!, /prices/);
  assert.equal(f.adapter.calls.length, 0);
  await f.engine.dispatch('creation.retry', { id: job.id, budgetUsd: null });
  job = await settled(f.engine, job.id);
  assert.equal(job.status, 'review', job.error);
  const changed = {
    ...job.profile!,
    conventions: 'Use snake_case functions and kebab-case filenames.',
  };
  await f.engine.dispatch('creation.save-profile', { id: job.id, profile: changed });
  assert.equal(f.engine.creations.get(job.id).profile!.conventions, changed.conventions);
  assert.equal(f.adapter.calls.length, 1);
  assert.equal((await readdir(f.root)).includes('new-app'), false);
});

test('external edits during repair are preserved and abort the generated patch', async (t) => {
  const f = await fixture(t);
  f.adapter.manifest.files.find((file) => file.path === 'src/greeting.cjs')!.content =
    "module.exports = () => 'broken';";
  const originalRun = f.adapter.run.bind(f.adapter);
  f.adapter.run = async (input, emit) => {
    if (!input.prompt.includes('Repair the generated application')) return originalRun(input, emit);
    await writeFile(
      join(f.destination, 'src/greeting.cjs'),
      '// external edit\n' +
        manifest.files.find((file) => file.path === 'src/greeting.cjs')!.content,
    );
    return {
      text: JSON.stringify({
        files: [manifest.files.find((file) => file.path === 'src/greeting.cjs')],
      }),
    };
  };
  const job = await review(f);
  await f.engine.dispatch('creation.generate', { id: job.id, profile: job.profile });
  const result = await settled(f.engine, job.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /changed during repair/);
  assert.match(await readFile(join(f.destination, 'src/greeting.cjs'), 'utf8'), /external edit/);
});
