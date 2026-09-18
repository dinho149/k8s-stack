import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test('desktop completes isolated work, shows a local app, and persists history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dogfood-ui-')),
    repo = join(root, 'example');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  await writeFile(join(repo, 'app.txt'), 'initial');
  await writeFile(join(repo, 'style.css'), 'body { color: blue; }');
  await writeFile(
    join(repo, 'check.cjs'),
    "if(require('fs').readFileSync('app.txt','utf8')!=='works')process.exit(1)",
  );
  await writeFile(
    join(repo, 'server.cjs'),
    "require('http').createServer((req,res)=>res.end('<h1>Local acceptance preview</h1>')).listen(Number(process.env.PORT),'127.0.0.1')",
  );
  await writeFile(
    join(repo, 'dogfood.yaml'),
    `version: 1\nchecks:\n  - name: Acceptance\n    command: ${process.execPath}\n    args: [check.cjs]\ndev:\n  name: App\n  command: ${process.execPath}\n  args: [server.cjs]\n`,
  );
  git('init', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial');
  const harness = join(root, 'fixture-codex');
  await writeFile(
    harness,
    `#!${process.execPath}
const fs=require('fs');const readline=require('readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);if(!m.id)return;
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='thread/start'){
  const config=m.params.config.mcp_servers.dogfood;
  const child=require('child_process').spawn(config.command,config.args,{env:{...process.env,...config.env},stdio:['pipe','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('MCP timeout')),10000);
    child.on('error',reject);
    readline.createInterface({input:child.stdout}).on('line',line=>{const reply=JSON.parse(line);if(reply.id===1){clearTimeout(timeout);child.stdin.end();if(reply.error||!reply.result.content[0].text.includes('initial')&&!reply.result.content[0].text.includes('works'))reject(new Error('MCP source read failed'));else resolve();}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_source',arguments:{path:'app.txt',offset:1,limit:10}}})+'\\n');
  });
  send({id:m.id,result:{thread:{id:'fixture-thread'},model:'fixture-model'}});
 }
 else if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'fixture-turn'}}});send({method:'turn/started',params:{turn:{id:'fixture-turn'}}});
  const prompt=m.params.input[0].text;let text='Change app.txt to works and run Acceptance.';
  if(prompt.includes('Implement the approved plan')){fs.writeFileSync('app.txt','works');text='Implementation complete.';}
  if(prompt.includes('Review the actual changes'))text=JSON.stringify({summary:'Acceptance and source reviewed.',findings:[]});
  send({method:'item/agentMessage/delta',params:{delta:text}});
  send({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{inputTokens:140,cachedInputTokens:40,outputTokens:20,reasoningOutputTokens:5}}}});
  send({method:'item/completed',params:{item:{type:'agentMessage',text}}});
  send({method:'turn/completed',params:{turn:{id:'fixture-turn',status:'completed'}}});
 }else send({id:m.id,result:{}});
});
`,
    { mode: 0o755 },
  );
  let app: ElectronApplication | undefined;
  const bootstrap = join(root, 'launch.cjs');
  await writeFile(
    bootstrap,
    `const {app}=require('electron');app.setPath('userData',${JSON.stringify(join(root, 'profile'))});require(${JSON.stringify(resolve('dist/main.cjs'))});`,
  );
  const launch = () =>
    electron.launch({
      ...(process.env.DOGFOOD_TEST_PACKAGED
        ? {
            executablePath: process.env.DOGFOOD_TEST_PACKAGED,
            args: ['--user-data-dir=' + join(root, 'state')],
          }
        : { args: [bootstrap] }),
      env: { ...process.env, DOGFOOD_DESKTOP_DATA: join(root, 'state') },
      timeout: 30000,
    });
  try {
    app = await launch();
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await expect(
      page.getByRole('heading', { name: 'From the first idea to “it works.”' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Open your first project' }).click();
    await page.getByLabel('Repository directory', { exact: true }).fill(repo);
    await page.getByRole('button', { name: 'Open project', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Project settings', exact: true }),
    ).toBeVisible();
    await page.evaluate(async (path) => {
      const state: any = await window.dogfood.call('snapshot');
      await window.dogfood.call('settings.save', {
        settings: { ...state.settings, codexPath: path },
      });
    }, harness);
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await page.getByLabel('Task name').fill('Deliver working output');
    await page.getByLabel('What should change?').fill('Change app.txt to works');
    await page
      .getByLabel('How will you know it works?')
      .fill('Acceptance passes and preview renders');
    await page.getByRole('button', { name: 'Create task', exact: true }).click();
    await page.getByRole('button', { name: 'Generate plan', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Approve plan', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Approve plan', exact: true }).click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'style.css', exact: true }).click();
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('color');
    await page.getByRole('button', { name: 'app.txt', exact: true }).click();
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('initial');
    await page.getByRole('button', { name: 'Implement plan', exact: true }).click();
    await expect(page.locator('.status-pill')).toHaveText('Awaiting review', { timeout: 20000 });
    expect(await readFile(join(repo, 'app.txt'), 'utf8')).toBe('initial');
    await page.getByRole('button', { name: 'Checks & review', exact: true }).click();
    await expect(page.locator('.review-text')).toContainText('Acceptance and source reviewed.');
    await page.getByRole('button', { name: 'Approve reviewed changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Deliver change', exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Run locally', exact: false }).click();
    await expect
      .poll(() => page.locator('.dock-tabs small').innerText())
      .toMatch(/^http:\/\/127.0.0.1:/);
    await page.getByRole('button', { name: 'Capture', exact: true }).click();
    const previewText = await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith('http://127.0.0.1:'))!
        .executeJavaScript('document.body.innerText'),
    );
    expect(previewText).toContain('Local acceptance preview');
    const capture = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'),
    );
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/desktop-workspace.png', Buffer.from(capture, 'base64'));
    const snapshot: any = await page.evaluate(() => window.dogfood.call('snapshot'));
    expect(snapshot.artifacts.some((a: any) => a.kind === 'screenshot')).toBe(true);
    const previewImage: string = await page.evaluate(
      (id) => window.dogfood.call<string>('artifact.read', { id }),
      snapshot.artifacts.find((a: any) => a.kind === 'screenshot').id,
    );
    await writeFile(
      'test-results/local-preview.png',
      Buffer.from(previewImage.split(',')[1], 'base64'),
    );
    expect(snapshot.usage).toHaveLength(3);
    expect(snapshot.usage.every((u: any) => u.costUsd === null)).toBe(true);
    await page.getByRole('button', { name: 'Stop app', exact: true }).click();
    await page.evaluate(() => {
      (window as any).terminalOutput = '';
      window.dogfood.onEvent((event) => {
        if (event.type === 'terminal') (window as any).terminalOutput += event.text;
      });
    });
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.locator('.xterm')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (window as any).terminalOutput.length))
      .toBeGreaterThan(0);
    await page
      .locator('.xterm-helper-textarea')
      .pressSequentially("printf 'DOGFOOD_%s' 'TERMINAL_OK'");
    await page.locator('.xterm-helper-textarea').press('Enter');
    await expect
      .poll(() => page.evaluate(() => (window as any).terminalOutput))
      .toContain('DOGFOOD_TERMINAL_OK');
    await expect(page.locator('.banner.error')).toHaveCount(0);
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    await page.getByRole('button', { name: 'Run checks', exact: true }).click();
    await expect(page.locator('.status-pill')).toHaveText('Awaiting review');
    await page.getByRole('button', { name: 'Review code', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Approve reviewed changes', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Approve reviewed changes', exact: true }).click();
    await page.getByRole('button', { name: 'Deliver change', exact: false }).click();
    await page.getByRole('button', { name: 'Merge locally', exact: false }).click();
    await expect(page.locator('.status-pill')).toHaveText('Merged');
    expect(await readFile(join(repo, 'app.txt'), 'utf8')).toBe('works');
    expect(errors).toEqual([]);
    const finalSnapshot: any = await page.evaluate(() => window.dogfood.call('snapshot'));
    expect(finalSnapshot.artifacts.some((a: any) => a.kind === 'local-preview')).toBe(true);
    await app.close();
    app = undefined;
    app = await launch();
    const reopened = await app.firstWindow();
    await expect(reopened.getByRole('heading', { name: 'Deliver working output' })).toBeVisible();
    const restored: any = await reopened.evaluate(() => window.dogfood.call('snapshot'));
    expect(restored.tasks[0].status).toBe('merged');
    expect(restored.artifacts.length).toBe(finalSnapshot.artifacts.length);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
