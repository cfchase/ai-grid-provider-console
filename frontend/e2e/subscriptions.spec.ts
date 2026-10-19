import { expect, test } from '@playwright/test';

// Fixture organization and model (mock/fixtures-poc/tenants.json, models.json).
const ORGANIZATION = 'acme-robotics';
const MODEL = 'granite-3-8b';

const unique = `e2e-${Math.random().toString(36).slice(2, 8)}`;
const group = `${unique}-team`;

test('creates, views, edits and deletes a subscription', async ({ page }) => {
  await page.goto('/subscriptions');
  await page.getByTestId('create-subscription-button').click();

  await page.getByTestId('subscription-name-desc-name').fill(unique);
  // Leaving the organization unset marks it invalid, so a disabled Create says why.
  await page.getByTestId('subscription-organization').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('subscription-organization')).toHaveAttribute('aria-invalid', 'true');
  await page.getByTestId('subscription-organization').selectOption({ label: ORGANIZATION });
  await page.getByTestId('subscription-groups').click();
  await page.getByRole('combobox', { name: 'Enter groups' }).fill(group);
  await page.getByRole('option', { name: `Add group "${group}"` }).click();
  await page.keyboard.press('Escape');

  await page.getByTestId('add-models-button').click();
  await page.getByTestId(`toggle-model-${MODEL}`).click();
  await page.getByTestId('confirm-add-models').click();
  await page.getByTestId('add-token-limit-0').click();
  await page.getByRole('spinbutton', { name: 'Token count' }).fill('5000');
  await page.getByTestId('save-rate-limits').click();
  await page.getByTestId('create-subscription-button').click();
  await expect(page.getByText('Subscription created')).toBeVisible();

  // The MaaS controller's phases: no phase (shown as Unknown) until the first reconcile,
  // Degraded until the TokenRateLimitPolicy is accepted (10 s at speed 1), then Active, which
  // the label shows as Ready.
  const label = page.getByTestId('subscription-row').filter({ hasText: unique }).getByTestId('phase-label');
  await expect(label).toHaveText(/Unknown|Degraded/);
  await expect(async () => {
    await page.reload();
    await expect(label).toHaveText('Ready');
  }).toPass({ timeout: 20_000 });

  // The view page opens directly and survives a reload.
  await page.goto(`/subscriptions/view/${unique}`);
  await expect(page.getByRole('heading', { name: unique })).toBeVisible();
  await expect(page.getByText(ORGANIZATION).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: unique })).toBeVisible();
  await expect(page.getByTestId('subscription-models-table')).toContainText('5,000');
  // The Details tab bar keeps its height on a page that scrolls (style.css).
  expect((await page.locator('.pf-v6-c-tabs').boundingBox())?.height).toBeGreaterThan(20);

  // Edit the priority.
  await page.getByTestId('subscription-actions-toggle').click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(page).toHaveURL(new RegExp(`/subscriptions/edit/${unique}$`));
  await page.getByRole('spinbutton', { name: 'Priority' }).fill('42');
  await page.getByTestId('update-subscription-button').click();
  await expect(page.getByText('Subscription updated')).toBeVisible();

  // Delete from the list with the typed confirmation.
  const row = page.getByTestId('subscription-row').filter({ hasText: unique });
  await expect(row).toContainText('42');
  await row.getByRole('button', { name: 'Kebab toggle' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByLabel('Delete modal input').fill(unique);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('subscription-row').filter({ hasText: unique })).toHaveCount(0);
});
