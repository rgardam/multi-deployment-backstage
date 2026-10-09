import { test, expect } from '@playwright/test';

// Both plugins live in plugins/ in this repository and reach the app through
// feature discovery; their backends run in backend-core and in a deployment
// of their own (backend-scorecards).

test('the sidebar links to both local plugins', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Enter' }).click();

  const nav = page.getByRole('navigation', { name: 'sidebar nav' });
  await expect(nav.getByRole('link', { name: 'Noticeboard' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Scorecards' })).toBeVisible();
});

test('the noticeboard posts and lists notices', async ({ page }) => {
  await page.goto('/noticeboard');
  await page.getByRole('button', { name: 'Enter' }).click();

  const title = `Notice from Playwright ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  await page
    .getByRole('textbox', { name: 'Notice', exact: true })
    .fill('Posted by the e2e tests');
  await page.getByRole('button', { name: 'Post' }).click();

  await expect(page.getByText(title)).toBeVisible();
});

test('a component page shows its scorecard', async ({ page }) => {
  await page.goto('/catalog/payments/component/ledger');
  await page.getByRole('button', { name: 'Enter' }).click();

  await expect(page.getByText('Scorecard', { exact: true })).toBeVisible();
  await expect(page.getByText('Has an owner')).toBeVisible();
  await expect(page.getByText('50%')).toBeVisible();
});

test('the scorecards page summarizes every catalog shard', async ({ page }) => {
  await page.goto('/scorecards');
  await page.getByRole('button', { name: 'Enter' }).click();

  await expect(page.getByText(/6 components, average score/)).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'payments' })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'default' })).toBeVisible();
});
