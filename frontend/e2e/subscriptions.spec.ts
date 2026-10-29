import { expect, test, type APIRequestContext } from '@playwright/test';

// On the backend's own fakes (playwright.config.ts, "backend fakes"): the subscription pages read
// and write the backend's Subscriptions API over Connect, through the BFF's relay. The PoC
// organization acme-robotics is in the backend's fake Keycloak (fixtures/poc/organizations.json);
// the Git catalog starts empty, so the spec commits a model of its own first and removes it after.
const ORGANIZATION = 'acme-robotics';

/** One Connect unary call through the console's origin, as the pages make it. */
const call = async (request: APIRequestContext, procedure: string, body: unknown) => {
  const response = await request.post(`/ai_grid.v1.${procedure}`, {
    data: body,
    headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
  });
  expect(response.ok(), `${procedure}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
};

test('creates, views, edits and deletes a subscription', async ({ page }) => {
  const unique = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  const group = `${unique}-team`;
  const modelId = `${unique}-model`;
  const modelName = `E2E model ${unique}`;
  // The UI_API_REFERENCE's minimal model, in the backend's Git catalog. Git mode requires a
  // placement, by cluster name; the backend checks only that the cluster is a ManagedCluster
  // (checkPlacementClusters), and the spec reads no model status, so any fixture cluster will do.
  const { items } = await call(page.request, 'Clusters/List', {});
  const cluster: string = items[0].id;
  await call(page.request, 'Models/Create', {
    object: {
      id: modelId,
      metadata: { name: modelId, annotations: { 'openshift.io/display-name': modelName } },
      spec: {
        model: { uri: 'hf://facebook/opt-125m', name: 'facebook/opt-125m' },
        replicas: 1,
        main: { image: 'quay.io/example/vllm:latest', requests: { cpu: '100m', memory: '1Gi' } },
        placement: {
          labelSelector: { matchExpressions: [{ key: 'name', operator: 'In', values: [cluster] }] },
        },
      },
    },
  });

  try {
    await page.goto('/subscriptions');
    await page.getByRole('link', { name: 'Create subscription' }).click();

    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(unique);
    await page.getByRole('combobox', { name: 'Organization' }).click();
    await page.getByRole('option', { name: ORGANIZATION }).click();
    await page.getByRole('combobox', { name: 'Enter groups' }).fill(group);
    await page.getByRole('option', { name: `Add group "${group}"` }).click();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Add models' }).click();
    const addModels = page.getByRole('dialog');
    await addModels.getByRole('checkbox', { name: `Select ${modelName}` }).check();
    await addModels.getByRole('button', { name: 'Add models' }).click();
    await page.getByRole('button', { name: 'Add token limit' }).click();
    const limits = page.getByRole('dialog', { name: 'Edit token limits' });
    await limits.getByRole('spinbutton', { name: 'Tokens' }).fill('5000');
    await limits.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Create subscription' }).click();
    await expect(page.getByText('Subscription created')).toBeVisible();

    // The fake hub's ingress clusters report subscriptions but not this new one, so the backend
    // says Pending (withSubscriptionPhase, internal/servers/subscriptions_git.go).
    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: unique, exact: true }) });
    await expect(row.getByTestId('phase-label')).toHaveText('Pending');
    await expect(row).toContainText(ORGANIZATION);

    // The view page opens directly and survives a reload; the backend joined the ref to the model.
    await page.goto(`/subscriptions/view/${unique}`);
    await expect(page.getByRole('heading', { name: unique })).toBeVisible();
    await expect(page.getByText(ORGANIZATION).first()).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: unique })).toBeVisible();
    const models = page.getByRole('grid', { name: 'subscription models' });
    await expect(models).toContainText('5,000');
    await expect(models).toContainText(modelName);
    await expect(page.getByTestId('subscription-priority')).toHaveText('0');

    // Edit the priority.
    await page.getByRole('button', { name: `Actions for ${unique}` }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    await expect(page).toHaveURL(new RegExp(`/subscriptions/edit/${unique}$`));
    await page.getByRole('spinbutton', { name: 'Priority' }).fill('42');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Subscription updated')).toBeVisible();

    // Delete from the list with the typed confirmation.
    await expect(row).toContainText('42');
    await row.getByRole('button', { name: `Actions for ${unique}` }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByLabel(/^Type .* to confirm/).fill(unique);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(row).toHaveCount(0);
  } finally {
    // Whatever step failed, leave the catalog as it was: the subscription (if the test didn't
    // delete it; zero skips the version check), then its model.
    await page.request.post('/ai_grid.v1.Subscriptions/Delete', {
      data: { id: unique },
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    });
    await call(page.request, 'Models/Delete', { id: modelId });
  }
});
