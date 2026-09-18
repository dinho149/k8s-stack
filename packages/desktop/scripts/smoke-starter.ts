import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarter } from '../src/core/starter';
import { inspectProject, git } from '../src/core/repository';
import { Runner } from '../src/core/runner';
import { starters } from '../src/starters';
import type { Task, Project } from '../src/shared';

async function main() {
  for (const starter of starters) {
    console.log(`\nTesting starter: ${starter.id}`);
    const root = await mkdtemp(join(tmpdir(), `dogfood-${starter.id}-`));
    const runner = new Runner(root, (_, text) => process.stdout.write(text));
    try {
      const path = join(root, 'app');
      await createStarter(path, starter.id);
      const { config } = await inspectProject(path);
      const task = { id: starter.id, worktree: path } as Task;
      const project = { config } as Project;
      for (const command of [...config.setup, ...config.checks]) {
        const result = await runner.run(task, command);
        assert.equal(result.code, 0, `${starter.id}: ${command.name} failed`);
      }
      const url = await runner.start(task, project);
      const response = await fetch(url);
      assert.equal(response.status, 200);
      if (starter.language === 'Python' || starter.language === 'Go') {
        assert.deepEqual(await response.json(), { message: 'Hello, world!' });
      } else {
        assert.match(await response.text(), /src\/main\.(ts|js)/);
      }
      runner.stop(task.id);
      let stopped = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          await fetch(url, { signal: AbortSignal.timeout(200) });
        } catch {
          stopped = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(stopped, 'Development server must stop');
      const status = (await git(path, 'status', '--porcelain', '--untracked-files=all'))
        .split('\n')
        .filter(Boolean);
      assert.deepEqual(
        status.filter((line) => line !== '?? package-lock.json'),
        [],
        'Builds and tests must not dirty generated source',
      );
    } finally {
      runner.stopAll();
      await rm(root, { recursive: true, force: true });
    }
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
