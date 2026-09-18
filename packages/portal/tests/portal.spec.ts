import { test, expect } from '@playwright/test';
import { digest, environment, mockPlatform } from './fixtures';

test('overview, filtering, deep links, history, and persisted theme', async ({ page }) => {
  await mockPlatform(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your work, in motion.' })).toBeVisible();
  await expect(page.getByText('Powered by Backstage')).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Environments', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'Search environments' }).fill('payments');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('link', { name: 'pr-payments-38', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'pr-payments-38', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'pr-payments-38', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('textbox', { name: 'Search environments' })).toHaveValue('payments');
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goto('/missing-page');
  await expect(page.getByRole('heading', { name: 'This page isn’t here' })).toBeVisible();
});

test('creation retains fields and idempotency key after failure', async ({ page }) => {
  const state = await mockPlatform(page, true);
  state.failCreate = true;
  await page.goto('/environments/new');
  await page.getByLabel('Environment name').fill('pr-new');
  await page.getByLabel('Image digest').fill(digest);
  await page.getByLabel('Git revision').fill('abcdef123');
  await page.getByRole('button', { name: 'Review preview' }).click();
  await page.getByRole('button', { name: 'Create preview', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Preview capacity reached');
  await page.getByRole('button', { name: 'Edit details' }).click();
  await expect(page.getByLabel('Environment name')).toHaveValue('pr-new');
  await page.getByRole('button', { name: 'Review preview' }).click();
  state.failCreate = false;
  await page.getByRole('button', { name: 'Create preview', exact: true }).click();
  await expect(page).toHaveURL(/\/environments\/pr-new$/);
  const requests = state.requests.filter((r) => r.path === '/environments' && r.method === 'POST');
  expect(requests).toHaveLength(2);
  expect(requests[0].key).toBeTruthy();
  expect(requests[1].key).toBe(requests[0].key);
});

test('detail actions use refreshed generations and server deletion confirmation', async ({
  page,
}) => {
  const state = await mockPlatform(page);
  await page.goto(`/environments/${environment.id}`);
  await page.getByRole('button', { name: 'Extend expiry' }).click();
  await expect(page.getByRole('status')).toContainText('expiry extended');
  await page.getByRole('button', { name: 'Retry deployment' }).click();
  await expect(page.getByRole('status')).toContainText('retry requested');
  expect(state.requests.find((r) => r.path.endsWith('/redeploy'))?.body.generation).toBe(2);
  await page.getByRole('button', { name: 'Delete preview', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete preview', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Delete preview', exact: true }).click();
  await page.getByRole('button', { name: 'Request deletion confirmation' }).click();
  expect(state.requests.filter((r) => r.path.endsWith('/destroy'))).toHaveLength(0);
  state.failDestroy = true;
  await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirmation expired');
  state.failDestroy = false;
  await page.getByRole('button', { name: 'Request deletion confirmation' }).click();
  await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(state.requests.find((r) => r.path.endsWith('/destroy'))?.body).toEqual({
    confirmation: 'server-confirmation',
  });
  await expect(page.getByRole('button', { name: 'Extend expiry' })).toBeDisabled();
});

test('release review and linked workflow; readable policy and tool pages', async ({ page }) => {
  await mockPlatform(page);
  await page.goto('/releases');
  await page.getByLabel('Target environment').selectOption('prod');
  await page.getByLabel('Image digest').fill(digest);
  await page.getByLabel('Git revision').fill('abcdef123');
  await page.getByRole('button', { name: 'Review promotion' }).click();
  await page.getByRole('button', { name: 'Request promotion', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Follow workflow' })).toHaveAttribute(
    'href',
    'https://github.com/example/platform/actions/runs/42',
  );
  await page.getByRole('navigation').getByRole('link', { name: 'Policies', exact: true }).click();
  await expect(page.getByText('60 min', { exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open Argo CD' })).toBeVisible();
  await expect(page.getByText('Not installed in this cluster')).toBeVisible();
});

test('assistant failures preserve drafts, conversation survives navigation, provider resets', async ({
  page,
}) => {
  const state = await mockPlatform(page);
  await page.goto('/assistant');
  state.failAgent = true;
  await page.getByLabel('Your request').fill('Check my preview');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('alert')).toContainText('Inference provider unavailable');
  await expect(page.getByLabel('Your request')).toHaveValue('Check my preview');
  state.failAgent = false;
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('log')).toContainText('Your preview is ready');
  await page.reload();
  await expect(page.getByRole('log')).toContainText('Your preview is ready');
  await page.getByLabel('Inference provider').selectOption('vertex');
  await expect(page.getByRole('log')).not.toContainText('Your preview is ready');
  await page.getByLabel('Your request').fill('Explain my policy');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('log')).toContainText('Your preview is ready');
  const requests = state.requests.filter((r) => r.path === '/agent');
  expect(requests.at(-1)?.body.provider).toBe('vertex');
  expect(requests.at(-1)?.body.conversation).not.toBe(requests[0].body.conversation);
});

test('empty, unavailable and stale data states remain distinct; account linking', async ({
  page,
}) => {
  const state = await mockPlatform(page, true);
  await page.goto('/environments');
  await expect(page.getByRole('heading', { name: 'Your next idea starts here' })).toBeVisible();
  state.environments.push(environment);
  await page.reload();
  await expect(page.getByRole('link', { name: environment.id, exact: true })).toBeVisible();
  state.failReads = true;
  await expect(page.getByRole('alert')).toContainText('Showing previously loaded data', {
    timeout: 12000,
  });
  await expect(page.getByRole('link', { name: environment.id, exact: true })).toBeVisible();
  state.failReads = false;
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.getByRole('alert')).not.toBeVisible();
  await page.getByRole('button', { name: 'Open account settings' }).click();
  await page.getByRole('button', { name: 'Generate link code' }).click();
  await expect(page.getByRole('dialog')).toContainText('/link test-code');
});

test('mobile navigation and layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockPlatform(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Environments', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Environments', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.goto(`/environments/${environment.id}`);
  await expect(page.getByRole('heading', { name: environment.id, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('all routes render in both themes and responsive sizes', async ({ page }) => {
  test.setTimeout(90000);
  await mockPlatform(page);
  const routes = [
    '/',
    '/environments',
    '/environments/new',
    `/environments/${environment.id}`,
    '/releases',
    '/tools',
    '/policies',
    '/assistant',
  ];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const theme of ['light', 'dark']) {
    for (const [size, width] of [
      ['desktop', 1440],
      ['tablet', 820],
      ['mobile', 390],
    ] as const) {
      await page.setViewportSize({ width, height: size === 'desktop' ? 1080 : 900 });
      for (const path of routes) {
        await page.goto(path);
        await page.evaluate((value) => {
          localStorage.setItem('stack.theme', value);
        }, theme);
        await page.reload();
        await expect(page.locator('.workspace-bar')).toContainText('Updated');
        await expect(page.locator('main h1')).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          `${path} ${theme} ${size} overflow`,
        ).toBe(true);
        if (size !== 'tablet')
          await page.screenshot({
            path: `../../.stack/portal-review/${theme}-${size}-${path.replaceAll('/', '_') || 'overview'}.png`,
            fullPage: true,
            animations: 'disabled',
          });
      }
    }
  }
  expect(errors).toEqual([]);
});

test('local sign-in errors retain Stack identity and retry', async ({ page }) => {
  await page.route('http://127.0.0.1:4707/**', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { name: 'Unavailable', message: 'Local authentication unavailable' } },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to your workspace.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry local sign-in' })).toBeVisible();
  await expect(page.getByText('Powered by Backstage')).toBeVisible();
  await page.screenshot({ path: '../../.stack/portal-review/sign-in.png', fullPage: true });
});
