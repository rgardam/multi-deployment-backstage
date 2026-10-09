import { test, expect } from '@playwright/test';

// The catalog page is one list, but its rows come from two catalog shards
// (payments and default), merged and sorted by the catalog router.
test('catalog lists components from every shard as one sorted list', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Enter' }).click();

  await page.getByTestId('user-picker-all').click();
  const table = page.locator('table');
  await expect(table.getByText('payments/ledger')).toBeVisible();
  await expect(table.getByText('example-website')).toBeVisible();

  const names = await table.locator('tbody tr td:first-child').allInnerTexts();
  const bare = names.map(name => name.split('/').pop()!);
  expect(bare).toEqual([...bare].sort());
});

// Ownership lives in another shard than the team: the org shard serves the
// group, the payments shard serves what it owns.
test('a team page shows ownership across shards', async ({ page }) => {
  await page.goto('/catalog/default/group/team-payments');
  await page.getByRole('button', { name: 'Enter' }).click();

  await expect(page.getByRole('heading', { name: 'Ownership' })).toBeVisible();
  await expect(page.getByText('SERVICES', { exact: true })).toBeVisible();
});
