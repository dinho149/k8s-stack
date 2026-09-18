import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for (const choice of [
  { language: 'JavaScript', starter: 'vanilla-js', file: 'src/main.js' },
  { language: 'Python', starter: 'fastapi-python', file: 'main.py' },
  { language: 'Go', starter: 'http-go', file: 'main.go' },
]) {
  test(`creates ${choice.starter} through the project dialog`, async ({}, testInfo) => {
    const root = await mkdtemp(join(tmpdir(), 'dogfood-starter-ui-'));
    let app: ElectronApplication | undefined;
    try {
      const bootstrap = join(root, 'launch.cjs');
      await writeFile(
        bootstrap,
        `const {app}=require('electron');app.setPath('userData',${JSON.stringify(join(root, 'profile'))});require(${JSON.stringify(resolve('dist/main.cjs'))});`,
      );
      app = await electron.launch({
        ...(process.env.DOGFOOD_TEST_PACKAGED
          ? {
              executablePath: process.env.DOGFOOD_TEST_PACKAGED,
              args: ['--user-data-dir=' + join(root, 'state')],
            }
          : { args: [bootstrap] }),
        env: { ...process.env, DOGFOOD_DESKTOP_DATA: join(root, 'state') },
        timeout: 30000,
      });
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.getByRole('button', { name: 'Open your first project' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Create new', exact: true }).click();
      await expect(dialog.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue(
        'TypeScript',
      );
      await expect(dialog.getByRole('combobox', { name: 'Framework', exact: true })).toHaveValue(
        'react-ts',
      );
      await dialog
        .getByRole('combobox', { name: 'Framework', exact: true })
        .selectOption('vanilla-ts');
      await dialog
        .getByRole('combobox', { name: 'Language', exact: true })
        .selectOption('JavaScript');
      await expect(dialog.getByRole('combobox', { name: 'Framework', exact: true })).toHaveValue(
        'vanilla-js',
      );
      await dialog
        .getByRole('combobox', { name: 'Language', exact: true })
        .selectOption(choice.language);
      await dialog
        .getByRole('combobox', { name: 'Framework', exact: true })
        .selectOption(choice.starter);
      await expect(
        dialog.getByRole('combobox', { name: 'Framework', exact: true }).locator('option'),
      ).toHaveCount(choice.language === 'JavaScript' ? 2 : 1);
      await dialog.getByRole('button', { name: 'Open existing', exact: true }).click();
      await expect(dialog.getByRole('combobox', { name: 'Language', exact: true })).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Create new', exact: true }).click();
      await expect(dialog.getByRole('combobox', { name: 'Framework', exact: true })).toHaveValue(
        choice.starter,
      );
      await dialog.screenshot({ path: testInfo.outputPath('create-project.png') });
      const occupied = join(root, 'occupied');
      await mkdir(occupied);
      await writeFile(join(occupied, 'keep.txt'), 'keep');
      await dialog.getByLabel('Repository directory', { exact: true }).fill(occupied);
      await dialog.getByRole('button', { name: 'Create application', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('empty directory');
      await expect(dialog.getByRole('combobox', { name: 'Framework', exact: true })).toHaveValue(
        choice.starter,
      );
      await expect(dialog.getByLabel('Repository directory', { exact: true })).toHaveValue(
        occupied,
      );
      expect(await readFile(join(occupied, 'keep.txt'), 'utf8')).toBe('keep');
      const destination = join(root, 'new-project');
      await dialog.getByLabel('Repository directory', { exact: true }).fill(destination);
      await dialog.getByRole('button', { name: 'Create application', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Project settings', exact: true }),
      ).toBeVisible();
      expect(await readFile(join(destination, choice.file), 'utf8')).toMatch(
        /greeting|Hello, world!/,
      );
      const state = await page.evaluate(() => window.dogfood.call<any>('snapshot'));
      expect(state.projects).toHaveLength(1);
      expect(state.projects[0].name).toBe('new-project');
      expect(errors).toEqual([]);
    } finally {
      if (app) await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
