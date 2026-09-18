import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id, now } from './store';
import { Engine } from './engine';
import { BudgetExceeded, UsageLedger, BudgetGuard, estimate } from './costs';
import { ContextBroker } from './context';
import { git, hash, sourceHash, readSource, writeSource, safePath } from './repository';
import {
  configSchema,
  type Project,
  type Task,
  type Run,
  type Usage,
  type AgentEvent,
} from '../shared';
import type { HarnessAdapter, HarnessInput } from './harness';

class FixtureHarness implements HarnessAdapter {
  calls: string[] = [];
  failing = false;
  async run(input: HarnessInput, emit: (event: AgentEvent) => void) {
    this.calls.push(input.prompt);
    emit({
      type: 'usage',
      usage: {
        requestId: 'fixture-request',
        provider: 'codex',
        model: 'fixture',
        input: 100,
        cached: 20,
        cacheWrite: 0,
        output: 40,
        reasoning: 10,
        costUsd: 0.01,
        costKind: 'reported',
      },
    });
    let text = 'Change app.txt to works. Run the configured acceptance check.';
    if (input.prompt.includes('Implement the approved plan')) {
      await writeFile(join(input.cwd, 'app.txt'), this.failing ? 'broken' : 'works');
      text = 'Implemented the planned change.';
    } else if (input.prompt.includes('Fix the failing checks')) {
      await writeFile(join(input.cwd, 'app.txt'), 'works');
      text = 'Fixed failing acceptance check.';
    } else if (input.prompt.includes('Review the actual changes'))
      text = JSON.stringify({ summary: 'Checked actual source and acceptance.', findings: [] });
    else if (input.prompt.includes('turn this idea'))
      text = JSON.stringify({
        spec: 'Deliver a working app.',
        tasks: [
          {
            title: 'Implement',
            description: 'Change output',
            acceptance: 'app.txt says works',
            dependsOn: [],
          },
          {
            title: 'Follow-up',
            description: 'Document output',
            acceptance: 'docs match',
            dependsOn: [0],
          },
        ],
      });
    emit({ type: 'text', text });
    return { text, sessionId: id() };
  }
}
async function fixture(t: { after(fn: () => Promise<void> | void): void }) {
  const root = await mkdtemp(join(tmpdir(), 'dogfood-test-')),
    repo = join(root, 'repo');
  await mkdir(repo);
  await writeFile(join(repo, 'app.txt'), 'initial');
  await writeFile(
    join(repo, 'check.cjs'),
    "const fs=require('fs');if(fs.readFileSync('app.txt','utf8')!=='works'){console.error('Expected works');process.exit(1)}\n",
  );
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'add', '.');
  await git(
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@localhost',
    'commit',
    '-m',
    'initial',
  );
  const store = new Store(join(root, 'state')),
    adapter = new FixtureHarness(),
    engine = new Engine(store, () => {}, {}, { codex: adapter, claude: adapter });
  const project = await engine.register(repo);
  project.config = configSchema.parse({
    checks: [{ name: 'Acceptance', command: process.execPath, args: ['check.cjs'] }],
    costs: { primary: { harness: 'codex', model: 'fixture', effort: 'high' } },
  });
  store.put('projects', project.id, project);
  t.after(async () => {
    engine.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, repo, store, adapter, engine, project };
}
async function settled(engine: Engine, taskId: string) {
  const start = Date.now();
  while (engine.active.has(taskId)) {
    if (Date.now() - start > 15000) throw new Error('Fixture timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
  return engine.store.require<Task>('tasks', taskId);
}
test('complete plan, implementation, repair, review and local merge preserve original checkout until delivery', async (t) => {
  const { engine, project, adapter, repo, store } = await fixture(t);
  const task = engine.task(project.id, 'Fix greeting', 'Change app.txt', 'app.txt says works');
  await engine.dispatch('task.action', { id: task.id, action: 'plan' });
  let current = await settled(engine, task.id);
  assert.equal(current.status, 'awaiting-plan');
  assert.equal(await readFile(join(repo, 'app.txt'), 'utf8'), 'initial');
  await assert.rejects(engine.implement(current, new AbortController().signal), /Approve/);
  await engine.dispatch('task.action', { id: task.id, action: 'approve-plan' });
  adapter.failing = true;
  await engine.dispatch('task.action', { id: task.id, action: 'implement' });
  current = await settled(engine, task.id);
  assert.equal(current.status, 'awaiting-review');
  assert.ok(current.validatedHash);
  assert.ok(current.reviewedHash);
  assert.ok(adapter.calls.some((p) => p.includes('Fix the failing checks')));
  assert.equal(await readFile(join(repo, 'app.txt'), 'utf8'), 'initial');
  current = await engine.approveReview(current);
  await engine.delivery(current, 'merge');
  assert.equal(await readFile(join(repo, 'app.txt'), 'utf8'), 'works');
  assert.equal(store.require<Task>('tasks', task.id).status, 'merged');
  assert.equal(store.all<Usage>('usage').length, 4);
});
test('external edits invalidate evidence and stale editor writes are rejected', async (t) => {
  const { engine, project } = await fixture(t);
  let task = await engine.prepare(engine.task(project.id, 'Change', 'Change'));
  await writeFile(join(task.worktree!, 'app.txt'), 'works');
  await engine.validate(task, new AbortController().signal);
  task = engine.store.require('tasks', task.id);
  await engine.review(task, new AbortController().signal);
  task = engine.store.require('tasks', task.id);
  await writeFile(join(task.worktree!, 'app.txt'), 'changed outside Dogfood');
  await assert.rejects(engine.approveReview(task), /current source/);
  await assert.rejects(
    writeSource(task.worktree!, 'app.txt', 'oops', hash('works')),
    /changed on disk/,
  );
});
test('worktrees preserve dirty source and prevent premature dependencies and cleanup', async (t) => {
  const { engine, project, repo } = await fixture(t);
  await writeFile(join(repo, 'local.txt'), 'keep me');
  const first = await engine.prepare(engine.task(project.id, 'One', 'First'));
  const next = engine.task(project.id, 'Two', 'Second', '', undefined, [first.id]);
  await assert.rejects(engine.prepare(next), /prerequisite/);
  await writeFile(join(first.worktree!, 'uncommitted.txt'), 'keep this too');
  await assert.rejects(
    engine.dispatch('task.action', { id: first.id, action: 'archive' }),
    /preserved/,
  );
  assert.equal(await readFile(join(repo, 'local.txt'), 'utf8'), 'keep me');
  const independent = await engine.prepare(engine.task(project.id, 'Independent', 'Third'));
  assert.notEqual(independent.worktree, first.worktree);
  assert.equal(await readFile(join(independent.worktree!, 'app.txt'), 'utf8'), 'initial');
});
test('path traversal and escaping symlinks cannot edit outside a task', async (t) => {
  const { root, repo } = await fixture(t);
  await writeFile(join(root, 'secret'), 'outside');
  await symlink(join(root, 'secret'), join(repo, 'link'));
  await assert.rejects(safePath(repo, '../secret'), /outside/);
  await assert.rejects(readSource(repo, 'link'), /outside/);
  await assert.rejects(safePath(repo, '.git/config', true), /Git internals/);
});
test('summary cache keys change with source, question, model, and instructions', async (t) => {
  const { store, repo } = await fixture(t),
    broker = new ContextBroker(store);
  const first = await broker.cacheKey(repo, ['app.txt'], 'purpose', 'small');
  broker.cache(first.key, 'initial', first.sources);
  assert.equal(broker.cached(first.key), 'initial');
  assert.notEqual(first.key, (await broker.cacheKey(repo, ['app.txt'], 'other', 'small')).key);
  await writeFile(join(repo, 'app.txt'), 'new');
  assert.notEqual(first.key, (await broker.cacheKey(repo, ['app.txt'], 'purpose', 'small')).key);
});
test('usage upserts cumulative notifications and never double-counts reasoning', async (t) => {
  const { store, project } = await fixture(t),
    ledger = new UsageLedger(store);
  const value: Omit<Usage, 'id' | 'createdAt'> = {
    taskId: 'task',
    projectId: project.id,
    runId: 'run',
    requestId: 'turn',
    provider: 'codex',
    model: 'fixture',
    input: 100,
    cached: 50,
    cacheWrite: 20,
    output: 40,
    reasoning: 30,
    costUsd: null,
    costKind: 'unknown',
  };
  store.put('settings', 'global', {
    ...store.settings(),
    prices: [
      {
        provider: 'codex',
        model: 'fixture',
        input: 1,
        cached: 0.1,
        cacheWrite: 1.25,
        output: 4,
        date: '2026-09-18',
      },
    ],
  });
  ledger.record(value);
  ledger.record({ ...value, output: 60 });
  assert.equal(store.all('usage').length, 1);
  assert.equal(ledger.totals('task').output, 60);
  assert.equal(ledger.totals('task').input, 170);
  assert.equal(ledger.totals('task').cost, (100 + 5 + 25 + 240) / 1e6);
});
test('budgets reserve concurrent spend and pause rather than count missing data as free', async (t) => {
  const { store, project } = await fixture(t),
    ledger = new UsageLedger(store),
    guard = new BudgetGuard(store, ledger);
  project.config.costs.taskBudgetUsd = 0.01;
  assert.throws(
    () => guard.reserve(project, 'task', project.config.costs.primary, 'hello'),
    BudgetExceeded,
  );
  store.put('settings', 'global', {
    ...store.settings(),
    prices: [
      {
        provider: 'codex',
        model: 'fixture',
        input: 1,
        cached: 0,
        cacheWrite: 1,
        output: 1,
        date: '2026-09-18',
      },
    ],
  });
  const first = guard.reserve(project, 'task', project.config.costs.primary, 'hello', 6000);
  assert.throws(
    () => guard.reserve(project, 'task', project.config.costs.primary, 'hello', 6000),
    BudgetExceeded,
  );
  guard.release(first);
  ledger.record({
    taskId: 'task',
    projectId: project.id,
    runId: 'run',
    requestId: 'unknown',
    provider: 'codex',
    model: 'fixture',
    input: null,
    cached: null,
    cacheWrite: null,
    output: null,
    reasoning: null,
    costUsd: null,
    costKind: 'unknown',
  });
  assert.throws(() => guard.check(project, 'task'), /unknown/);
});
test('source hashing detects untracked changes but remains stable after a content-only commit', async (t) => {
  const { repo } = await fixture(t),
    before = await sourceHash(repo);
  await writeFile(join(repo, 'new.txt'), 'hello');
  const changed = await sourceHash(repo);
  assert.notEqual(before, changed);
  await git(repo, 'add', '.');
  await git(
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@localhost',
    'commit',
    '-m',
    'new file',
  );
  assert.equal(await sourceHash(repo), changed);
});
test('restart recovery marks uncertain runs interrupted and keeps artifacts', async (t) => {
  const { store, project, engine } = await fixture(t),
    task = engine.task(project.id, 'Resume', 'Recovery');
  engine.update(task, { status: 'implementing' });
  store.put('runs', 'running', {
    id: 'running',
    taskId: task.id,
    status: 'running',
    harness: 'codex',
    stage: 'implement',
    model: 'fixture',
    startedAt: now(),
  });
  const artifact = store.artifact(task.id, 'transcript', 'Progress', 'saved output');
  const restored = new Engine(store, () => {});
  assert.equal(store.require<Task>('tasks', task.id).status, 'paused');
  assert.equal(store.require<Run>('runs', 'running').status, 'interrupted');
  assert.equal(store.readArtifact(artifact.id), 'saved output');
  restored.shutdown();
});
test('specification produces linked tasks with dependency ordering', async (t) => {
  const { engine, project, store } = await fixture(t);
  const idea = (await engine.dispatch('idea.create', {
    projectId: project.id,
    title: 'Idea',
    description: 'Make it work',
  })) as { id: string };
  await engine.dispatch('idea.spec', { id: idea.id });
  const active = [...engine.active.keys()][0];
  await settled(engine, active);
  const tasks = store.all<Task>('tasks').filter((t) => t.status !== 'archived');
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[1].dependencies, [tasks[0].id]);
});
test('command timeout and cancellation keep failure evidence', async (t) => {
  const { engine, project } = await fixture(t),
    task = await engine.prepare(engine.task(project.id, 'Timeout', 'Testing'));
  const result = await engine.runner.run(task, {
    name: 'timeout',
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: '.',
    timeoutSeconds: 1,
  });
  assert.equal(result.code, 124);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    engine.runner.run(
      task,
      { name: 'cancelled', command: process.execPath, args: [], cwd: '.', timeoutSeconds: 1 },
      controller.signal,
    ),
    /Cancelled/,
  );
});
test('consistent SQLite backup contains task records', async (t) => {
  const { engine, project, root, store } = await fixture(t);
  const task = engine.task(project.id, 'Backup', 'Keep history');
  const backup = join(root, 'backup.sqlite');
  store.backup(backup);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(backup, { readOnly: true });
  try {
    assert.equal(
      JSON.parse(String(db.prepare('select data from tasks where id=?').get(task.id)!.data)).title,
      'Backup',
    );
  } finally {
    db.close();
  }
});

test('saved guidance is included on resume and unknown usage can be priced later', async (t) => {
  const { engine, project, adapter, store } = await fixture(t);
  const task = engine.task(project.id, 'Guidance', 'Work');
  await engine.dispatch('agent.input', {
    id: task.id,
    text: 'Preserve the existing public interface.',
  });
  await engine.dispatch('task.action', { id: task.id, action: 'plan' });
  await settled(engine, task.id);
  assert.ok(adapter.calls[0].includes('Preserve the existing public interface.'));
  engine.ledger.record({
    taskId: task.id,
    projectId: project.id,
    runId: 'unpriced',
    requestId: 'one',
    provider: 'codex',
    model: 'priced-later',
    input: 100,
    cached: 0,
    cacheWrite: 0,
    output: 100,
    reasoning: 0,
    costUsd: null,
    costKind: 'unknown',
  });
  assert.equal(engine.ledger.totals(task.id).unknown, true);
  store.put('settings', 'global', {
    ...store.settings(),
    prices: [
      {
        provider: 'codex',
        model: 'priced-later',
        input: 1,
        cached: 0,
        cacheWrite: 0,
        output: 1,
        date: '2026-09-18',
      },
    ],
  });
  engine.ledger.repriceUnknown();
  assert.equal(engine.ledger.totals(task.id).unknown, false);
});

test('worker summaries are reused until source or repository rules change', async (t) => {
  const { engine, project, adapter } = await fixture(t);
  project.config.costs.workerRouting = true;
  project.config.costs.worker = { harness: 'codex', model: 'fixture', effort: 'low' };
  engine.store.put('projects', project.id, project);
  const task = await engine.prepare(engine.task(project.id, 'Inspect', 'Read code'));
  await writeFile(join(task.worktree!, 'large.txt'), 'meaningful source\n'.repeat(1100));
  engine.toolRuns.set('parent', { task, project, signal: new AbortController().signal });
  const first: any = await engine.callTool('parent', 'bulk_read', {
    paths: ['large.txt'],
    question: 'What is here?',
  });
  assert.equal(first.cached, false);
  const second: any = await engine.callTool('parent', 'bulk_read', {
    paths: ['large.txt'],
    question: 'What is here?',
  });
  assert.equal(second.cached, true);
  assert.equal(adapter.calls.length, 1);
  await writeFile(join(task.worktree!, 'AGENTS.md'), 'New interpretation rule');
  const changed: any = await engine.callTool('parent', 'bulk_read', {
    paths: ['large.txt'],
    question: 'What is here?',
  });
  assert.equal(changed.cached, false);
  assert.equal(adapter.calls.length, 2);
  const small: any = await engine.callTool('parent', 'bulk_read', {
    paths: ['app.txt'],
    question: 'What is here?',
  });
  assert.equal(small.delegated, false);
  assert.equal(adapter.calls.length, 2);
});

test('pattern writer refuses unrequested files and source changes during drafting', async (t) => {
  const { engine, project } = await fixture(t);
  project.config.costs.workerRouting = true;
  project.config.costs.worker = { harness: 'claude', model: 'fixture', effort: 'low' };
  engine.store.put('projects', project.id, project);
  const task = engine.update(
    await engine.prepare(engine.task(project.id, 'Generate', 'Boilerplate')),
    { status: 'implementing' },
  );
  engine.toolRuns.set('parent', { task, project, signal: new AbortController().signal });
  engine.adapters.claude = {
    run: async () => ({
      text: JSON.stringify({ files: [{ path: 'unexpected.txt', content: 'bad' }] }),
    }),
  };
  await assert.rejects(
    engine.callTool('parent', 'pattern_write', {
      reference: 'app.txt',
      targets: ['new.txt'],
      spec: 'Repeat pattern',
    }),
    /unexpected file/,
  );
  engine.adapters.claude = {
    run: async () => {
      await writeFile(join(task.worktree!, 'app.txt'), 'changed');
      return { text: JSON.stringify({ files: [{ path: 'new.txt', content: 'stale' }] }) };
    },
  };
  await assert.rejects(
    engine.callTool('parent', 'pattern_write', {
      reference: 'app.txt',
      targets: ['new.txt'],
      spec: 'Repeat pattern',
    }),
    /Reference changed/,
  );
  await assert.rejects(readFile(join(task.worktree!, 'new.txt')), { code: 'ENOENT' });
});

test('offline cost comparisons include all calls and reject incomplete costs', async (t) => {
  const { root } = await fixture(t);
  const { execute } = await import('./repository');
  const exportValue = (cost: number | null) => ({
    task: { acceptance: 'Works', validatedHash: 'same', reviewedHash: 'same' },
    usage: [
      { costUsd: cost, input: 100, output: 30 },
      { costUsd: cost, input: 30, output: 10 },
    ],
    artifacts: [
      {
        kind: 'validation',
        sourceHash: 'same',
        content: JSON.stringify({ commands: [{ command: 'test' }], results: [{ code: 0 }] }),
      },
    ],
  });
  const baseline = join(root, 'baseline.json'),
    optimized = join(root, 'optimized.json');
  await writeFile(baseline, JSON.stringify(exportValue(0.1)));
  await writeFile(optimized, JSON.stringify(exportValue(0.05)));
  const args = [
    join(__dirname, '../../scripts/compare-costs.mjs'),
    baseline,
    baseline,
    baseline,
    '--optimized',
    optimized,
    optimized,
    optimized,
  ];
  const result = JSON.parse(await execute(process.execPath, args, root));
  assert.equal(result.baseline.cost, 0.20000000000000004);
  assert.equal(result.costReduction, 0.5);
  await writeFile(optimized, JSON.stringify(exportValue(null)));
  await assert.rejects(execute(process.execPath, args, root), /cost is incomplete/);
});

test('daily project headroom is passed to the external harness budget', async (t) => {
  const { engine, project, store, adapter } = await fixture(t);
  project.config.costs.dailyBudgetUsd = 0.025;
  project.config.costs.taskBudgetUsd = 0.1;
  store.put('projects', project.id, project);
  store.put('settings', 'global', {
    ...store.settings(),
    prices: [
      {
        provider: 'codex',
        model: 'fixture',
        input: 1,
        cached: 0,
        cacheWrite: 1,
        output: 1,
        date: '2026-09-18',
      },
    ],
  });
  engine.ledger.record({
    taskId: 'other-task',
    projectId: project.id,
    runId: 'earlier',
    requestId: 'one',
    provider: 'codex',
    model: 'fixture',
    input: 100,
    cached: 0,
    cacheWrite: 0,
    output: 10,
    reasoning: 0,
    costUsd: 0.01,
    costKind: 'reported',
  });
  let allowed: number | undefined;
  engine.adapters.codex = {
    run: async (input, emit) => {
      allowed = input.maxBudgetUsd;
      return adapter.run(input, emit);
    },
  };
  const task = engine.task(project.id, 'Budget', 'Use remaining headroom');
  await engine.agent(
    task,
    'plan',
    'Read-only planning',
    new AbortController().signal,
    project.config.costs.primary,
  );
  assert.ok(allowed !== undefined && Math.abs(allowed - 0.015) < 1e-9);
  assert.throws(
    () =>
      engine.budget.reserve(project, task.id, project.config.costs.primary, 'next request', 8192),
    BudgetExceeded,
  );
});

test('workspace rename, removal and reopening preserve repository, worktrees and history', async (t) => {
  const { root, engine, store, project, repo } = await fixture(t);
  const task = engine.task(project.id, 'Keep my work', 'Important changes');
  const prepared = await engine.prepare(task);
  await writeFile(join(prepared.worktree!, 'unfinished.txt'), 'uncommitted work');
  store.artifact(task.id, 'test', 'Saved evidence', 'keep this evidence');
  const renamed = (await engine.dispatch('project.rename', {
    id: project.id,
    name: '  My workspace  ',
  })) as Project;
  assert.equal(renamed.name, 'My workspace');
  assert.equal(renamed.path, project.path);
  await assert.rejects(engine.dispatch('project.rename', { id: project.id, name: '  ' }));
  await engine.dispatch('project.remove', { id: project.id });
  assert.equal(engine.snapshot().projects.length, 0);
  assert.equal(engine.snapshot().tasks.length, 0);
  assert.equal(engine.snapshot().artifacts.length, 0);
  assert.equal(await readFile(join(repo, 'app.txt'), 'utf8'), 'initial');
  assert.equal(
    await readFile(join(prepared.worktree!, 'unfinished.txt'), 'utf8'),
    'uncommitted work',
  );
  assert.equal(store.all<Task>('tasks').length, 1);
  await assert.rejects(engine.dispatch('project.files', { id: project.id }), /was removed/);
  await assert.rejects(engine.prepare(prepared), /was removed/);
  await assert.rejects(
    engine.dispatch('task.action', { id: task.id, action: 'prepare' }),
    /was removed/,
  );
  const reopenedStore = new Store(join(root, 'state'));
  try {
    assert.equal(reopenedStore.snapshot().projects.length, 0);
  } finally {
    reopenedStore.close();
  }
  const restored = (await engine.dispatch('project.add', { path: repo })) as Project;
  assert.equal(restored.id, project.id);
  assert.equal(restored.name, 'My workspace');
  assert.equal(engine.snapshot().projects.length, 1);
  assert.equal(engine.snapshot().tasks.length, 1);
  assert.equal(engine.snapshot().artifacts.length, 1);
});

test('workspace removal refuses active tasks and local applications', async (t) => {
  const { engine, project } = await fixture(t);
  const task = engine.task(project.id, 'Busy task', '');
  engine.active.set(task.id, { controller: new AbortController() });
  await assert.rejects(engine.dispatch('project.remove', { id: project.id }), /Stop active tasks/);
  engine.active.delete(task.id);
  engine.runner.apps.set(task.id, { url: 'http://127.0.0.1:1234', port: 1234, stop: () => {} });
  await assert.rejects(engine.dispatch('project.remove', { id: project.id }), /Stop active tasks/);
  engine.runner.apps.delete(task.id);
  assert.equal(engine.snapshot().projects.length, 1);
});

test('workspace files can be edited before a task exists and reject stale or unsafe writes', async (t) => {
  const { engine, project, repo, root } = await fixture(t);
  const listed = (await engine.dispatch('project.files', { id: project.id })) as string[];
  assert.ok(listed.includes('app.txt'));
  const initial = (await engine.dispatch('project.read-file', {
    id: project.id,
    path: 'app.txt',
  })) as { content: string; hash: string };
  assert.equal(initial.content, 'initial');
  await engine.dispatch('project.write-file', {
    id: project.id,
    path: 'app.txt',
    hash: initial.hash,
    content: 'edited',
  });
  assert.equal(await readFile(join(repo, 'app.txt'), 'utf8'), 'edited');
  await assert.rejects(
    engine.dispatch('project.write-file', {
      id: project.id,
      path: 'app.txt',
      hash: initial.hash,
      content: 'stale',
    }),
    /changed on disk/,
  );
  for (const path of ['../outside.txt', '.git/config']) {
    await assert.rejects(
      engine.dispatch('project.write-file', {
        id: project.id,
        path,
        hash: hash(''),
        content: 'bad',
      }),
    );
  }
  await writeFile(join(root, 'outside.txt'), 'outside');
  await symlink(join(root, 'outside.txt'), join(repo, 'escape'));
  await assert.rejects(
    engine.dispatch('project.read-file', { id: project.id, path: 'escape' }),
    /Symlink/,
  );
  await writeFile(join(repo, 'dogfood.yaml'), 'version: 1\n');
  await symlink(join(repo, 'dogfood.yaml'), join(repo, 'config-link'));
  for (const path of ['dogfood.yaml', './dogfood.yaml', 'config-link']) {
    await assert.rejects(
      engine.dispatch('project.write-file', {
        id: project.id,
        path,
        hash: hash('version: 1\n'),
        content: 'bad',
      }),
      /Project settings/,
    );
  }
  const task = engine.task(project.id, 'Busy task', '');
  engine.active.set(task.id, { controller: new AbortController() });
  await assert.rejects(
    engine.dispatch('project.write-file', {
      id: project.id,
      path: 'app.txt',
      hash: hash('edited'),
      content: 'busy',
    }),
    /Stop active tasks/,
  );
  engine.active.delete(task.id);
  assert.equal(await readFile(join(repo, 'app.txt'), 'utf8'), 'edited');
});
