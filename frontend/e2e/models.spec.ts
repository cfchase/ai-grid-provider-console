import { expect, test, type APIRequestContext } from '@playwright/test';
import { callBackend as call } from './backend';

// The backend's own Models API on its fakes (the backend's fixtures/poc), through the BFF's
// Connect relay. site1 is an Available member, Compliant with the ready Policy; the fixtures give
// no cluster an ai-grid/role, so Models/ListPlacementClusters offers none until one serves models.
// This spec gives site1 the inference role for its run, as Add to AI Grid writes it, and puts its
// labels back afterwards: its project in playwright.config.ts runs one test at a time.
const CLUSTER = 'site1';

type Labels = Record<string, string>;

type Cluster = { object: { metadata: { labels?: Labels; version?: number } } };

/** Writes the cluster's labels whole, at the version read (Clusters/Update with lock). */
const writeLabels = async (request: APIRequestContext, change: (labels: Labels) => Labels) => {
  const { object } = await call<Cluster>(request, 'Clusters/Get', { id: CLUSTER });
  await call(request, 'Clusters/Update', {
    object: {
      id: CLUSTER,
      metadata: { labels: change({ ...object.metadata.labels }), version: object.metadata.version },
    },
    updateMask: 'metadata.labels',
    lock: true,
  });
};

let originalRole: string | undefined;

test.beforeAll(async ({ request }) => {
  await writeLabels(request, (labels) => {
    originalRole = labels['ai-grid/role'];
    return { ...labels, 'ai-grid/role': 'inference' };
  });
});

test.afterAll(async ({ request }) => {
  await writeLabels(request, (labels) => {
    const next = { ...labels };
    if (originalRole === undefined) delete next['ai-grid/role'];
    else next['ai-grid/role'] = originalRole;
    return next;
  });
});

test('deploys a model to a cluster, edits it in the same wizard, and deletes it', async ({ page }) => {
  const unique = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/models');
  await page.getByRole('link', { name: 'Deploy model' }).click();

  // Source
  await page.getByRole('textbox', { name: /^Model URI/ }).fill(`hf://e2e/${unique}`);
  await page.getByRole('button', { name: 'Next' }).click();

  // Deployment: the name starts from the model URI's last segment.
  await expect(page.getByRole('textbox', { name: /^Model name/ })).toHaveValue(unique);
  await page.getByRole('textbox', { name: /^Runtime image/ }).fill('quay.io/example/runtime:latest');
  // The model server has no default.
  await page.getByRole('combobox', { name: 'Model server' }).selectOption({ label: 'vLLM CPU' });
  await page.getByRole('button', { name: 'Next' }).click();

  // Locations: options read "<site name> (<cluster>)", from Models/ListPlacementClusters.
  await page.getByRole('combobox', { name: 'Locations' }).click();
  await page.getByRole('option', { name: CLUSTER }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Next' }).click();

  // Review: users call the model by its resource name.
  await expect(page.getByText(CLUSTER).first()).toBeVisible();
  await expect(page.getByTestId('model-review')).toContainText(`Model name in requests${unique}`);
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await expect(page.getByText('Model deployed')).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: unique });
  await expect(row).toBeVisible();
  // The backend saved it to Git; no cluster has reported it yet.
  await expect(row.getByTestId('model-phase')).toHaveText('Saved to Git');
  await expect(row.getByTestId(`model-locations-${unique}`)).toContainText(CLUSTER);

  // The model's page, at /models/<id>.
  await row.getByRole('link', { name: unique, exact: true }).click();
  await expect(page).toHaveURL(`/models/${unique}`);
  await expect(page.getByRole('heading', { name: unique })).toBeVisible();
  await expect(page.getByTestId('model-locations')).toContainText(CLUSTER);

  // Edit in the deploy wizard: the source is read-only, every step opens directly, and Save sends
  // Models/Update with the changed path and the version the page loaded.
  await page.getByRole('button', { name: `Actions for ${unique}` }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: `Edit ${unique}` })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Model URI' })).toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: 'Deployment', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Replicas' }).fill('2');
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Model updated')).toBeVisible();
  await expect(page.getByRole('heading', { name: unique })).toBeVisible();
  await expect(page.getByLabel('Deployment', { exact: true })).toContainText(/Replicas\s*2/);

  // Delete from its Actions menu.
  await page.getByRole('button', { name: `Actions for ${unique}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByLabel(/^Type .* to confirm/).fill(unique);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Model deleted')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: unique })).toHaveCount(0);
});

test('says when a model page has no model', async ({ page }) => {
  await page.goto('/models/no-such-model');
  await expect(page.getByText('Model not found')).toBeVisible();
});
