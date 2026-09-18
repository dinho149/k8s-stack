import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './repository';
import { getStarter, type StarterId } from '../starters';
import { backendFiles } from './starter-backends';
function webFiles(typescript: boolean, react: boolean): Record<string, string> {
  const content: Record<string, string> = {
    'package.json': JSON.stringify(
      {
        name: 'dogfood-app',
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: {
          dev: 'vite',
          build: 'tsc --noEmit && vite build',
          typecheck: 'tsc --noEmit',
          test: 'vitest run',
          'test:browser': 'playwright test',
        },
        dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
        devDependencies: {
          '@types/react': '18.3.25',
          '@types/react-dom': '18.3.7',
          '@vitejs/plugin-react': '4.7.0',
          vite: '6.4.3',
          typescript: '5.9.3',
          vitest: '^3.2.0',
          '@playwright/test': '^1.63.0',
        },
      },
      null,
      2,
    ),
    '.gitignore':
      'node_modules/\ndist/\n.env\n.env.*\nplaywright-report/\ntest-results/\n.dogfood/\n',
    'index.html':
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>My app</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          jsx: 'react-jsx',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['src'],
      },
      null,
      2,
    ),
    'vite.config.ts':
      "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n",
    'vitest.config.ts':
      "import { defineConfig } from 'vitest/config';\nexport default defineConfig({test:{include:['src/**/*.test.ts']}});\n",
    'src/main.tsx':
      "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { greeting } from './greeting';\nimport './style.css';\ncreateRoot(document.getElementById('root')!).render(<main><small>Made with Dogfood</small><h1>{greeting('world')}</h1><p>Your next idea starts here.</p></main>);\n",
    'src/greeting.ts': 'export const greeting = (name: string) => `Hello, ${name}!`;\n',
    'src/greeting.test.ts':
      "import { expect, test } from 'vitest';\nimport { greeting } from './greeting';\ntest('greets the supplied person', () => expect(greeting('Ada')).toBe('Hello, Ada!'));\n",
    'src/style.css':
      'body { margin: 0; font-family: system-ui; background: #f3f6fc; color: #18243b; } main { max-width: 720px; margin: 15vh auto; padding: 32px; } small { color: #2455db; } h1 { font-size: 64px; letter-spacing: -.04em; }',
    'playwright.config.ts':
      "import { defineConfig } from '@playwright/test';\nimport { createServer } from 'node:net';\nconst port = Number(process.env.DOGFOOD_TEST_PORT) || await new Promise<number>((resolve, reject) => { const server = createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = (server.address() as {port:number}).port; server.close(() => resolve(port)); }); });\nprocess.env.DOGFOOD_TEST_PORT = String(port);\nconst url = `http://127.0.0.1:${port}`;\nexport default defineConfig({testDir:'tests', webServer:{command:`npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,url,reuseExistingServer:false},use:{baseURL:url}});\n",
    'tests/app.spec.ts':
      "import { test, expect } from '@playwright/test';\ntest('renders the application', async ({ page }) => { await page.goto('/'); await expect(page.getByRole('heading')).toHaveText('Hello, world!'); });\n",
    'AGENTS.md':
      '# Project instructions\n\nUse TypeScript and React. Keep changes focused on the approved task. Run npm test and npm run build. Add meaningful tests for new behaviour. Browser tests live in tests/. Never commit secrets.\n',
    'README.md':
      '# My application\n\nOpen this project in Dogfood. Review its commands, prepare a task, and run setup. Use Run locally for an isolated development server.\n',
    'dogfood.yaml':
      'version: 1\nsetup:\n  - name: Install dependencies\n    command: npm\n    args: [install]\n  - name: Install test browser\n    command: npx\n    args: [playwright, install, chromium]\ndev:\n  name: Development server\n  command: npm\n  args: [run, dev, --, --host, 127.0.0.1, --port, "{port}"]\nchecks:\n  - name: Unit tests\n    command: npm\n    args: [test]\n  - name: Build and typecheck\n    command: npm\n    args: [run, build]\n  - name: Browser acceptance\n    command: npm\n    args: [run, "test:browser"]\n',
  };
  if (!react) {
    const pkg = JSON.parse(content['package.json']);
    delete pkg.dependencies;
    for (const name of ['@types/react', '@types/react-dom', '@vitejs/plugin-react'])
      delete pkg.devDependencies[name];
    content['package.json'] = JSON.stringify(pkg, null, 2);
    delete content['src/main.tsx'];
    content['src/main.ts'] =
      "import { greeting } from './greeting';\nimport './style.css';\ndocument.getElementById('root')!.innerHTML = `<main><small>Made with Dogfood</small><h1>${greeting('world')}</h1><p>Your next idea starts here.</p></main>`;\n";
    content['index.html'] = content['index.html'].replace('/src/main.tsx', '/src/main.ts');
    content['vite.config.ts'] =
      "import { defineConfig } from 'vite';\nexport default defineConfig({});\n";
    const config = JSON.parse(content['tsconfig.json']);
    delete config.compilerOptions.jsx;
    content['tsconfig.json'] = JSON.stringify(config, null, 2);
  }
  if (!typescript) {
    const pkg = JSON.parse(content['package.json']);
    pkg.scripts.build = 'vite build';
    delete pkg.scripts.typecheck;
    for (const name of ['typescript', '@types/react', '@types/react-dom'])
      delete pkg.devDependencies[name];
    content['package.json'] = JSON.stringify(pkg, null, 2);
    delete content['tsconfig.json'];
    for (const file of Object.keys(content)) {
      if (!/\.tsx?$/.test(file)) continue;
      content[file.replace(/\.ts(x?)$/, '.js$1')] = content[file]
        .replace(': string', '')
        .replaceAll("getElementById('root')!", "getElementById('root')")
        .replace('new Promise<number>', 'new Promise')
        .replace('(server.address() as {port:number})', 'server.address()')
        .replace('src/**/*.test.ts', 'src/**/*.test.js');
      delete content[file];
    }
    content['index.html'] = content['index.html'].replace(/\.ts(x?)/g, '.js$1');
    content['dogfood.yaml'] = content['dogfood.yaml'].replace('Build and typecheck', 'Build');
  }
  return content;
}

export async function createStarter(path: string, starterId?: StarterId) {
  const starter = getStarter(starterId);
  if (!path.trim()) throw new Error('Choose an empty destination directory.');
  const content =
    starter.language === 'Python' || starter.language === 'Go'
      ? backendFiles(starter.language)
      : webFiles(starter.language === 'TypeScript', starter.framework === 'React');
  content['AGENTS.md'] =
    `# Project instructions\n\nUse ${starter.language} and ${starter.framework}. Keep changes focused on the approved task. Run the checks in dogfood.yaml. Add meaningful tests for new behaviour. Never commit secrets.\n`;
  content['README.md'] =
    `# My application\n\n${starter.description}\n\nRequires ${starter.requires}.\n\nOpen this project in Dogfood, review Project settings, create a task, and run setup in its worktree. Run locally starts an isolated development server. The setup, development, and check commands are listed in dogfood.yaml. Dependencies are installed during setup, not project creation.\n`;
  await mkdir(path, { recursive: true });
  if ((await readdir(path)).length)
    throw new Error('Choose an empty directory for the new application.');
  for (const [file, text] of Object.entries(content)) {
    await mkdir(join(path, file, '..'), { recursive: true });
    await writeFile(join(path, file), text);
  }
  await git(path, 'init', '-b', 'main');
  await git(path, 'add', '.');
  await git(
    path,
    '-c',
    'user.name=Dogfood',
    '-c',
    'user.email=dogfood@localhost',
    'commit',
    '-m',
    'Create application with Dogfood',
  );
}
