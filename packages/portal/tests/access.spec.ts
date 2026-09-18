import { test, expect } from '@playwright/test';
import { approvedRequest, bob, mockPlatform, pendingRequest } from './fixtures';

test('my access: identity banner, active grant with tsh command, effective access', async ({
  page,
}) => {
  await mockPlatform(page);
  await page.goto('/access');
  await expect(
    page.getByRole('heading', { name: 'You are alice · alice@example.test' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'dev-ssh', exact: true })).toBeVisible();
  await expect(page.getByText('Expires in')).toBeVisible();
  await expect(page.getByLabel('tsh login for dev-ssh', { exact: true })).toHaveText(
    approvedRequest.tsh_login_command!,
  );
  await expect(page.getByRole('navigation', { name: 'Access sections' })).not.toContainText(
    'Approvals',
  );
  await expect(page.locator('tbody tr')).toHaveCount(2);
});

test('roles: filter, decision prediction, detail with approvers', async ({ page }) => {
  await mockPlatform(page);
  await page.goto('/access/roles');
  await expect(page.locator('tbody tr')).toHaveCount(4);
  await page.getByLabel('Requestable only').check();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page).toHaveURL(/requestable=1/);
  await page.getByRole('textbox', { name: 'Search roles' }).fill('prod');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText('Needs an approver');
  await page.getByRole('link', { name: 'prod-ssh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'prod-ssh', exact: true })).toBeVisible();
  await expect(page.getByText('bob', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Request this role' }).click();
  await expect(page).toHaveURL(/\/access\/request\?roles=prod-ssh/);
  await expect(page.getByRole('checkbox', { name: /prod-ssh/ })).toBeChecked();
});

test('request flow: client validation, preview prediction and cap, idempotent submit, success', async ({
  page,
}) => {
  const state = await mockPlatform(page);
  await page.goto('/access/request');
  const review = page.getByRole('button', { name: 'Review request' });
  await expect(review).toBeDisabled();
  await page.getByRole('checkbox', { name: /dev-ssh/ }).check();
  await page.getByLabel('Reason').fill('short');
  await expect(review).toBeDisabled();
  await page.getByLabel('Reason').fill('poking around the dev boxes');
  await page.getByLabel('How long').selectOption('4h');
  await review.click();
  await expect(page.getByText('Approved automatically')).toBeVisible();
  await expect(page.getByText('will be capped to 1h0m0s')).toBeVisible();
  await expect(page.getByLabel('equivalent tsh command', { exact: true })).toContainText(
    'tsh request create --roles dev-ssh',
  );
  state.failCreate = true;
  await page.getByRole('button', { name: 'Submit request' }).click();
  await expect(page.getByRole('alert')).toContainText('too many access requests');
  state.failCreate = false;
  await page.getByRole('button', { name: 'Submit request' }).click();
  await expect(page.getByRole('heading', { name: 'Access granted' })).toBeVisible();
  await expect(page.getByLabel('tsh login', { exact: true })).toContainText(
    'tsh login --request-id=c0ffee00',
  );
  const posts = state.requests.filter((r) => r.path === '/access/requests' && r.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[0].key).toBeTruthy();
  expect(posts[1].key).toBe(posts[0].key);
  expect(posts[0].body).toEqual({
    roles: ['dev-ssh'],
    reason: 'poking around the dev boxes',
    ttl: '4h',
  });
  await page.getByRole('link', { name: 'View request' }).click();
  await expect(page).toHaveURL(/\/access\/requests\/c0ffee00/);
  await expect(page.getByRole('heading', { name: /dev-ssh/ })).toBeVisible();
});

test('my requests: state filter in the URL and detail with decision evidence', async ({ page }) => {
  await mockPlatform(page);
  await page.goto('/access/requests');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByLabel('State').selectOption('pending');
  await expect(page).toHaveURL(/state=pending/);
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('link', { name: 'prod-ssh', exact: true }).click();
  await expect(page.getByText(pendingRequest.reason, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await page.goto(`/access/requests/${approvedRequest.id}`);
  await expect(page.locator('dd', { hasText: 'rule auto-approve-low-risk' })).toContainText('auto');
  await expect(page.getByLabel('tsh login', { exact: true })).toContainText(approvedRequest.id);
});

test('approvals: hidden for requesters, queue and two-phase decision for approvers, broker refusals surface', async ({
  page,
}) => {
  const state = await mockPlatform(page);
  await page.goto('/access/approvals');
  await expect(page.getByRole('heading', { name: 'Approvals are for approvers' })).toBeVisible();
  state.access.me = structuredClone(bob);
  await page.goto('/access/approvals');
  await expect(page.getByRole('navigation', { name: 'Access sections' })).toContainText(
    'Approvals',
  );
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Decide' }).click();
  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByRole('button', { name: 'Confirm denial' })).toBeDisabled();
  await page.getByLabel('Reason (required)').fill('not during the freeze');
  state.access.failApprove = 'not_pending';
  await page.getByRole('button', { name: 'Confirm denial' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('not pending');
  state.access.failApprove = '';
  await page.getByRole('button', { name: 'Confirm denial' }).click();
  await expect(page.getByRole('status')).toContainText('Request denied');
  await expect(page.getByRole('heading', { name: 'Nothing to approve' })).toBeVisible();
  const decision = state.requests.find((r) => r.path.endsWith('/deny') && r.method === 'POST');
  expect(decision?.body).toEqual({ reason: 'not during the freeze' });
  await page.goto(`/access/requests/${pendingRequest.id}`);
  await expect(page.locator('.review-list')).toContainText('not during the freeze');
});

test('access pages degrade when Teleport is not configured', async ({ page }) => {
  const state = await mockPlatform(page);
  state.access.configured = false;
  await page.goto('/access');
  await expect(
    page.getByRole('heading', { name: 'Teleport access is not set up here' }),
  ).toBeVisible();
});
