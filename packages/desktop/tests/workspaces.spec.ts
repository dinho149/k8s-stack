import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Project } from '../src/shared';

test('workspaces can be viewed, edited, removed and restored without deleting files', async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'dogfood-workspaces-ui-'));
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
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Open your first project' })).toBeVisible();
    const { first, second } = await page.evaluate(async (root) => {
      const first = await window.dogfood.call<Project>('project.create', {
        path: root + '/first',
        starterId: 'vanilla-js',
      });
      const second = await window.dogfood.call<Project>('project.create', {
        path: root + '/second',
        starterId: 'http-go',
      });
      return { first, second };
    }, root);
    const library = () => page.getByRole('button', { name: 'Workspaces', exact: true }).click();
    await library();
    await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(2);
    await page
      .getByRole('article', { name: 'first', exact: true })
      .getByRole('button', { name: 'Open workspace' })
      .click();
    await expect(page.getByRole('heading', { name: 'first', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Browse files' }).click();
    await page.getByRole('button', { name: 'README.md', exact: true }).click();
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('My application');
    await page.locator('.monaco-editor .native-edit-context, .monaco-editor .inputarea').focus();
    await page.keyboard.press('Meta+A');
    await page.keyboard.insertText('# Edited workspace\n');
    await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeEnabled();
    await library();
    await expect(
      page
        .getByRole('article', { name: 'first', exact: true })
        .getByRole('button', { name: 'Remove workspace' }),
    ).toBeDisabled();
    await page
      .getByRole('article', { name: 'first', exact: true })
      .getByRole('button', { name: 'Open workspace' })
      .click();
    await page.getByRole('button', { name: 'Browse files' }).click();
    await page.getByRole('button', { name: 'README.md *', exact: true }).click();
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Edited workspace');
    await page.getByRole('button', { name: 'Save file', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeDisabled();
    expect(await readFile(join(first.path, 'README.md'), 'utf8')).toBe('# Edited workspace\n');
    await writeFile(join(first.path, 'README.md'), '# Changed externally\n');
    await page.locator('.monaco-editor .native-edit-context, .monaco-editor .inputarea').focus();
    await page.keyboard.press('Meta+A');
    await page.keyboard.insertText('# Stale change\n');
    await page.getByRole('button', { name: 'Save file', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'changed on disk' })).toBeVisible();
    await page.getByRole('button', { name: 'Discard edits and reload' }).click();
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('Changed externally');
    await page.screenshot({ path: testInfo.outputPath('workspace-files.png') });
    await page.getByRole('button', { name: 'dogfood.yaml', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit in Project settings' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit in Project settings' }).click();
    await page
      .getByRole('textbox', { name: 'Workspace name', exact: true })
      .fill('Renamed workspace');
    await page.getByRole('button', { name: 'Save workspace name' }).click();
    await expect(
      page.getByRole('combobox', { name: 'Project', exact: true }).locator('option:checked'),
    ).toHaveText('Renamed workspace');
    await library();
    await page.screenshot({ path: testInfo.outputPath('workspaces.png') });
    const renamed = page.getByRole('article', { name: 'Renamed workspace', exact: true });
    await renamed.getByRole('button', { name: 'Remove workspace' }).click();
    await renamed.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(renamed).toBeVisible();
    await renamed.getByRole('button', { name: 'Remove workspace' }).click();
    await renamed.getByRole('button', { name: 'Confirm removal' }).click();
    await expect(page.getByRole('article')).toHaveCount(1);
    await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue(
      second.id,
    );
    expect(await readFile(join(first.path, 'README.md'), 'utf8')).toBe('# Changed externally\n');
    await page.evaluate((id) => localStorage.setItem('dogfood-project', id), first.id);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue(
      second.id,
    );
    await expect(page.getByRole('heading', { name: 'second', exact: true })).toBeVisible();
    await library();
    await page.getByRole('button', { name: 'Add workspace' }).click();
    await page
      .getByRole('dialog')
      .getByLabel('Repository directory', { exact: true })
      .fill(first.path);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Open project', exact: true })
      .click();
    await expect(page.getByRole('textbox', { name: 'Workspace name', exact: true })).toHaveValue(
      'Renamed workspace',
    );
    await library();
    await expect(page.getByRole('article')).toHaveCount(2);
    for (const name of ['Renamed workspace', 'second']) {
      const row = page.getByRole('article', { name, exact: true });
      await row.getByRole('button', { name: 'Remove workspace' }).click();
      await row.getByRole('button', { name: 'Confirm removal' }).click();
      await expect(row).toHaveCount(0);
    }
    await expect(page.getByRole('heading', { name: 'No workspaces yet' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('');
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
