import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarter } from './starter';
import { git, inspectProject } from './repository';
import { starters, type StarterId } from '../starters';
import { Engine } from './engine';
import { Store } from './store';

for (const starter of starters) {
  test(`creates and registers ${starter.id} with matching files and commands`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'dogfood-starter-test-'));
    const store = new Store(join(root, 'state'));
    const engine = new Engine(store, () => {});
    t.after(async () => {
      engine.shutdown();
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const path = join(root, 'app');
    await engine.dispatch('project.create', { path, starterId: starter.id });
    assert.equal(store.all('projects').length, 1);
    assert.equal(await git(path, 'status', '--porcelain'), '');
    const { config, branch } = await inspectProject(path);
    assert.equal(branch, 'main');
    assert.ok(config.setup.length);
    assert.ok(config.checks.length);
    assert.ok(config.dev);
    assert.match(await readFile(join(path, 'AGENTS.md'), 'utf8'), new RegExp(starter.language));
    if (starter.language === 'Python') {
      await access(join(path, 'main.py'));
      assert.equal(config.dev.command, '.venv/bin/python');
      assert.deepEqual(config.checks[0].args, ['-m', 'pytest']);
    } else if (starter.language === 'Go') {
      await access(join(path, 'main.go'));
      assert.equal(config.dev.command, 'go');
      assert.deepEqual(config.checks[0].args, ['test', './...']);
    } else {
      const ts = starter.language === 'TypeScript';
      const react = starter.framework === 'React';
      const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      assert.equal(Boolean(pkg.dependencies?.react), react);
      assert.equal(Boolean(pkg.devDependencies.typescript), ts);
      const entry = `main.${ts ? 'ts' : 'js'}${react ? 'x' : ''}`;
      await access(join(path, 'src', entry));
      assert.ok((await readFile(join(path, 'index.html'), 'utf8')).includes(`/src/${entry}`));
      assert.equal(pkg.scripts.build.includes('tsc'), ts);
      if (!ts) {
        assert.ok(
          !(await readdir(path)).some((name) => name.endsWith('.ts') || name === 'tsconfig.json'),
        );
        assert.ok(!(await readdir(join(path, 'src'))).some((name) => /\.tsx?$/.test(name)));
      }
    }
  });
}

test('default starter stays React/TypeScript and invalid requests do not write files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dogfood-starter-errors-'));
  const store = new Store(join(root, 'state'));
  const engine = new Engine(store, () => {});
  t.after(async () => {
    engine.shutdown();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, 'app');
  await assert.rejects(
    engine.dispatch('project.create', { path, starterId: 'unknown' }),
    /supported project starter/,
  );
  assert.equal(store.all('projects').length, 0);
  await assert.rejects(createStarter(path, 'unknown' as StarterId), /supported project starter/);
  await assert.rejects(access(path));
  await assert.rejects(createStarter('   '), /destination directory/);
  await engine.dispatch('project.create', { path });
  await access(join(path, 'src/main.tsx'));
  await writeFile(join(path, 'keep.txt'), 'keep me');
  await assert.rejects(createStarter(path, 'http-go'), /empty directory/);
  assert.equal(await readFile(join(path, 'keep.txt'), 'utf8'), 'keep me');
  await assert.rejects(access(join(path, 'main.go')));
});
