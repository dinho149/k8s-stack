import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createStarter } from '../src/core/starter';
async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dogfood-starter-'));
  try {
    await createStarter(root);
    for (const [command, args] of [
      ['npm', ['install', '--no-audit', '--no-fund']],
      ['npx', ['playwright', 'install', 'chromium']],
      ['npm', ['test']],
      ['npm', ['run', 'build']],
      ['npm', ['run', 'test:browser']],
    ] as [string, string[]][]) {
      const result = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, CI: '1' },
        timeout: 240000,
      });
      if (result.error || result.status !== 0)
        throw new Error(`${command} ${args.join(' ')} failed: ${result.error ?? result.status}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
