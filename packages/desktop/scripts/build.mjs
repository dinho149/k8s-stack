import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({
  entryPoints: { main: 'src/main.ts', preload: 'src/preload.ts', worker: 'src/worker.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron', 'node-pty', '@anthropic-ai/claude-agent-sdk'],
});
await viteBuild();
await copyFile('../portal/public/dogfood.svg', 'dist/ui/dogfood.svg');
