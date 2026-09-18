import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

for (const kind of ['local', 'github']) {
  test(`creates a verified workspace from a ${kind} reference`, async ({}, testInfo) => {
    const root = await mkdtemp(join(tmpdir(), 'dogfood-reference-ui-'));
    let app: ElectronApplication | undefined;
    try {
      const source = join(root, 'reference'),
        destination = join(root, 'new-project'),
        bin = join(root, 'bin');
      await mkdir(source);
      await mkdir(bin);
      await writeFile(
        join(source, 'package.json'),
        JSON.stringify({ name: 'reference-product', dependencies: { astro: '5.0.0' } }),
      );
      await writeFile(
        join(source, 'AGENTS.md'),
        'Use kebab-case filenames and isolated unit tests.',
      );
      const git = (...args: string[]) =>
        execFileSync('/usr/bin/git', args, { cwd: source, encoding: 'utf8' });
      git('init', '-b', 'main');
      git('add', '.');
      git('-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'reference');
      const before = git('status', '--porcelain');
      const command = {
        name: 'Unit tests',
        command: process.execPath,
        args: ['--test', 'test/greeting.test.cjs'],
        cwd: '.',
        timeoutSeconds: 10,
      };
      const profile = {
        stack: 'Node.js with reference naming conventions',
        packageManager: 'npm',
        structure: ['src/greeting.cjs', 'test/greeting.test.cjs'],
        conventions: 'Use kebab-case filenames and isolated unit tests.',
        prerequisites: 'Node.js',
        uncertainties: ['Keep this scaffold minimal; original product features are omitted.'],
        evidence: ['package.json', 'AGENTS.md'],
        commands: { setup: [], checks: [command], readinessPath: '/' },
      };
      const greeting = 'module.exports = name => `Hello, ${name}!`;';
      const manifest = {
        files: [
          { path: 'package.json', content: '{"name":"new-project","private":true}' },
          {
            path: 'src/greeting.cjs',
            content: kind === 'github' ? "module.exports = () => 'broken';" : greeting,
          },
          {
            path: 'test/greeting.test.cjs',
            content:
              "require('node:test')('greets a name',()=>require('node:assert/strict').equal(require('../src/greeting.cjs')('Ada'),'Hello, Ada!'));",
          },
        ],
      };
      const harness = join(root, 'fixture-agent.cjs');
      await writeFile(
        harness,
        `#!${process.execPath}
const readline=require('node:readline');const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;
if(m.method==='initialize')send({id:m.id,result:{}});
else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'fixture'},model:'fixture'}});
else if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn'}}});const prompt=m.params.input[0].text;
const text=JSON.stringify(prompt.includes('Analyze reference conventions')?${JSON.stringify(profile)}:prompt.includes('Repair the generated application')?{files:[{path:'src/greeting.cjs',content:"module.exports = () => 'broken';"}]}:${JSON.stringify(manifest)});
send({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{inputTokens:120,cachedInputTokens:20,outputTokens:100}}}});
send({method:'item/completed',params:{item:{type:'agentMessage',text}}});send({method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});}
else send({id:m.id,result:{}});});`,
        { mode: 0o755 },
      );
      // Fetch fixture keeps the real GitHub source path through the engine without using the network.
      await writeFile(
        join(bin, 'git'),
        `#!${process.execPath}
const cp=require('node:child_process');const args=process.argv.slice(2).map(arg=>arg==='https://github.com/example/reference'?${JSON.stringify(source)}:arg);
try{cp.execFileSync('/usr/bin/git',args,{stdio:'inherit'});}catch(e){process.exit(e.status||1);}`,
        { mode: 0o755 },
      );
      const bootstrap = join(root, 'launch.cjs');
      await writeFile(
        bootstrap,
        `const {app}=require('electron');app.setPath('userData',${JSON.stringify(join(root, 'profile'))});require(${JSON.stringify(resolve('dist/main.cjs'))});`,
      );
      const launch = () =>
        electron.launch({
          args: [bootstrap],
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            DOGFOOD_DESKTOP_DATA: join(root, 'state'),
          },
          timeout: 30000,
        });
      app = await launch();
      let page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.evaluate(async (executable) => {
        const state: any = await window.dogfood.call('snapshot');
        await window.dogfood.call('settings.save', {
          settings: { ...state.settings, codexPath: executable },
        });
      }, harness);
      await page.getByRole('button', { name: 'Open your first project' }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Create new', exact: true }).click();
      await dialog
        .getByRole('combobox', { name: 'Create from', exact: true })
        .selectOption('reference');
      await dialog
        .getByRole('combobox', { name: 'Reference source', exact: true })
        .selectOption(kind);
      await dialog
        .getByLabel(kind === 'local' ? 'Reference directory' : 'Reference GitHub URL', {
          exact: true,
        })
        .fill(kind === 'local' ? source : 'https://github.com/example/reference');
      if (kind === 'github')
        await dialog.getByLabel('Branch (optional)', { exact: true }).fill('main');
      await dialog.getByLabel('New project name', { exact: true }).fill('New project');
      await dialog.getByLabel('New workspace directory', { exact: true }).fill(destination);
      await dialog.getByRole('button', { name: 'Analyze reference', exact: true }).click();
      await expect(
        dialog.getByRole('heading', { name: 'Review the setup', exact: true }),
      ).toBeVisible({ timeout: 20000 });
      await dialog
        .getByLabel('Naming and development conventions', { exact: true })
        .fill('Use kebab-case filenames. Prefer small pure functions and unit tests.');
      await dialog.screenshot({ path: testInfo.outputPath('reference-review.png') });
      await dialog.getByRole('button', { name: 'Create and verify', exact: true }).click();
      if (kind === 'github') {
        await expect(
          dialog.getByRole('heading', { name: 'Creation needs attention', exact: true }),
        ).toBeVisible({ timeout: 20000 });
        await expect(dialog.getByText('Repair attempt 2 of 2.', { exact: false })).toBeVisible();
        await app.close();
        app = await launch();
        page = await app.firstWindow();
        await page.getByRole('button', { name: 'Open your first project' }).click();
        dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: 'Create new', exact: true }).click();
        await dialog
          .getByRole('combobox', { name: 'Create from', exact: true })
          .selectOption('reference');
        await dialog.getByRole('button', { name: 'New project Creation needs attention' }).click();
        await writeFile(join(destination, 'src/greeting.cjs'), '// User repair\n' + greeting);
        await dialog.getByRole('button', { name: 'Retry verification', exact: true }).click();
      }
      await expect(
        dialog.getByRole('heading', { name: 'Workspace verified', exact: true }),
      ).toBeVisible({ timeout: 20000 });
      await dialog.screenshot({ path: testInfo.outputPath('reference-complete.png') });
      await dialog.getByRole('button', { name: 'Open new workspace', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'New project', exact: true })).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Reference setup', exact: true }),
      ).toBeVisible();
      expect(await readFile(join(destination, 'REFERENCE.md'), 'utf8')).toContain(
        'Prefer small pure functions',
      );
      expect(git('status', '--porcelain')).toBe(before);
      expect(
        execFileSync('/usr/bin/git', ['remote'], { cwd: destination, encoding: 'utf8' }).trim(),
      ).toBe('');
      expect(errors).toEqual([]);
    } finally {
      if (app) await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
