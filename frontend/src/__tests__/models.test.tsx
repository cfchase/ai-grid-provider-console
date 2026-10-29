// Ported from krisv/ai-grid-cloud-provider-poc src/app/__tests__/deployments.test.tsx at 62319b8.
// The PoC drives its Git-backed API; here the same cases run on MockConsoleService, and the
// BFF and fake backend rules are covered by bff/internal/api and bff/internal/fakebackend tests.
// Rulings and scope:
// - The Git file assertions (deployment, MaaSModelRef, Placement, ManifestWorkReplicaSet) become
//   assertions on the saved model; the console's backend owns those resources.
// - The new model in the subscription model picker is covered by subscriptions.test.tsx, which
//   picks models from the same list.
// - "persists deployment management in mock storage…" keeps only its location and stale-version
//   assertions (A5, D3); a referenced model is the blocked-delete case.
// - "explains a 200 response from an outdated backend" tests a PoC-only legacy payload and is
//   not ported.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import getModels from '../../../mock/examples/get-models.json';
import { ServiceError } from '../api/ConsoleService';
import { consolePlacement } from '../api/adapters';
import { HttpConsoleService } from '../api/HttpConsoleService';
import { MockConsoleService } from '../api/MockConsoleService';
import { create } from '@bufbuild/protobuf';
import { ConnectError, Code } from '@connectrpc/connect';
import { SubscriptionSchema } from '../gen/ai_grid/v1/subscription_type_pb';
import { ACME_ID, SUBSCRIPTION_NAMESPACE, subscriptionsOf } from './connectSubscriptions';
import type { CreateModelRequest, ManagedModel } from '../api/types';
import { serviceOnBffExamples } from './bffExamples';
import { deferred, renderAt } from './render';
// The routes load these pages lazily; loaded here, their import does not run inside a test's findBy.
import '../pages/models/ModelDetailsPage';
import '../pages/models/ModelEditPage';
import '../pages/models/ModelWizard';
import '../pages/models/ModelsPage';
import { TestApp } from './TestApp';

const input: CreateModelRequest = {
  name: 'widget',
  displayName: 'Widget',
  modelUri: 'hf://org/widget',
  modelName: 'org/widget',
  runtimeImage: 'registry.example/runtime:test',
  replicas: 1,
  cpu: '2',
  memory: '4Gi',
  gpuCount: 0,
  locations: ['site1', 'site2'],
  runtimeArgs: [],
  baseRefs: [],
};

/** A user the console couldn't load: the pages show, but without write actions. A viewer
 * (isProviderAdmin false) sees no pages at all (App.test.tsx). */
const unknownUser = () => {
  const service = new MockConsoleService();
  service.getUser = () => Promise.reject(new ServiceError(500, 'unavailable'));
  return service;
};

type User = ReturnType<typeof userEvent.setup>;

/** Names the deployment, replacing the name the wizard starts from the model's. */
const nameDeployment = async (user: User, name: string) => {
  const field = await screen.findByTestId('model-name-desc-name');
  await user.clear(field);
  await user.paste(name);
};

/** Picks the Deployment step's model server, which has no default. */
const chooseServer = async (user: User, label = 'vLLM on CPU') =>
  user.selectOptions(screen.getByRole('combobox', { name: 'Model server' }), label);

/** Fills the source and deployment steps and moves on to Locations. */
const fillModel = async (user: User) => {
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('textbox', { name: /^Model name/ }));
  await user.paste('org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await nameDeployment(user, 'Widget');
  await user.click(screen.getByRole('textbox', { name: /Runtime image/ }));
  await user.paste('registry.example/runtime:test');
  await chooseServer(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
};

/** The mock's locations, as the wizard names them: the site, then the location key. */
const site1 = 'San Francisco (site1)';
const site2 = 'New York (site2)';
const site3 = 'Brussels (site3)';

it('walks the deployment wizard, selects locations and saves the model', async () => {
  const service = new MockConsoleService();
  const user = userEvent.setup();
  renderAt('/models', service);
  expect(await screen.findByTestId('model-deployments-table')).toBeVisible();
  await user.click(screen.getByRole('link', { name: 'Deploy model' }));
  expect(await screen.findByRole('button', { name: 'Next' })).toBeDisabled();
  await fillModel(user);
  expect(screen.queryByLabelText('Publish as MaaS')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  const reviewNav = within(screen.getByRole('navigation', { name: 'Wizard steps' })).getByRole('button', {
    name: /Review/,
  });
  expect(reviewNav).toBeVisible();
  expect(reviewNav).toBeDisabled();
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  await user.click(screen.getByRole('option', { name: site1 }));
  await user.click(screen.getByRole('option', { name: site2 }));
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  const review = await screen.findByTestId('model-review');
  expect(review).toHaveTextContent(`${site1}, ${site2}`);
  // Empty optional fields are left out of the review.
  expect(review).not.toHaveTextContent('Additional runtime arguments');
  await user.click(await screen.findByRole('button', { name: 'Deploy' }));

  const table = await screen.findByTestId('model-deployments-table');
  expect(table).toHaveTextContent('Widget');
  expect(await screen.findByText('Model deployed')).toBeVisible();
  // Up to five locations show as labels in the row.
  const locationsCell = screen.getByTestId('model-locations-widget');
  expect(within(locationsCell).getByText(site1)).toBeVisible();
  expect(within(locationsCell).getByText(site2)).toBeVisible();
  const saved = (await service.listModels()).find((m) => m.name === 'widget');
  expect(saved).toMatchObject({
    namespace: 'ai-grid-models',
    modelUri: 'hf://org/widget',
    modelName: 'org/widget',
    modelRef: { kind: 'LLMInferenceService', name: 'widget' },
    locations: ['site1', 'site2'],
  });
});

it('removes a model after its name is typed', async () => {
  const service = new MockConsoleService();
  await service.createModel(input);
  const user = userEvent.setup();
  renderAt('/models', service);
  await user.click(await screen.findByTestId('model-actions-widget'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const dialog = await screen.findByTestId('delete-deployment-modal');
  expect(dialog).toHaveTextContent('Delete model deployment?');
  // The backend also refuses while an authorization policy references the model.
  expect(dialog).toHaveTextContent('Remove references from subscriptions and authorization policies first.');
  expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeDisabled();
  await user.click(within(dialog).getByTestId('delete-modal-input'));
  await user.paste('Widget');
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByTestId('model-actions-widget')).not.toBeInTheDocument());
  expect((await service.listModels()).some((m) => m.name === 'widget')).toBe(false);
});

it('leaves the deploy form out of history once the model is deployed, so Back skips it', async () => {
  let navigate: NavigateFunction = () => undefined;
  const CaptureNavigate = () => {
    navigate = useNavigate();
    return null;
  };
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/clusters', '/models/deploy']} initialIndex={1}>
      <CaptureNavigate />
      <TestApp service={new MockConsoleService()} />
    </MemoryRouter>,
  );
  await fillModel(user);
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  await user.click(screen.getByRole('option', { name: site1 }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(await screen.findByRole('button', { name: 'Deploy' }));
  expect(await screen.findByText('Model deployed')).toBeVisible();
  await act(async () => navigate(-1));
  expect(await screen.findByRole('heading', { level: 1, name: 'Clusters' })).toBeVisible();
});

/** Subscription "widget-users", whose ref the backend joins to model "widget" (Subscriptions/List). */
const widgetUsers = (service: MockConsoleService) =>
  subscriptionsOf(service).subscriptions.push(
    create(SubscriptionSchema, {
      id: 'widget-users',
      metadata: { name: 'widget-users', version: 1 },
      spec: {
        owner: { groups: ['widget-users'] },
        organization: { id: ACME_ID },
        modelRefs: [
          { name: 'widget', namespace: SUBSCRIPTION_NAMESPACE, tokenRateLimits: [{ limit: 1000n, window: '1h' }] },
        ],
      },
    }),
  );

/** A model "widget" that subscription "widget-users" uses. */
const referencedModel = async (service: MockConsoleService) => {
  const result = await service.createModel(input);
  widgetUsers(service);
  // The backend refuses to delete a model a subscription names (models_server.go, FailedPrecondition).
  service.deleteModel = () =>
    Promise.reject(
      new ServiceError(412, 'Remove this model from its subscriptions and authorization policies before deleting it.'),
    );
  return result;
};

it('disables Delete while subscriptions use the model, and says why', async () => {
  const service = new MockConsoleService();
  const remove = vi.spyOn(service, 'deleteModel');
  await referencedModel(service);
  const user = userEvent.setup();
  renderAt('/models', service);
  await user.click(await screen.findByTestId('model-actions-widget'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  // The dialog names the subscriptions that still use the model.
  const references = await screen.findByTestId('model-references');
  expect(within(references).getByRole('link', { name: 'widget-users' })).toHaveAttribute(
    'href',
    '/subscriptions/view/widget-users',
  );
  await user.type(screen.getByTestId('delete-modal-input'), 'Widget{Enter}');
  const button = within(screen.getByTestId('delete-deployment-modal')).getByRole('button', { name: 'Delete' });
  expect(button).toHaveAttribute('aria-disabled', 'true');
  await user.click(button);
  await user.hover(button);
  expect(await screen.findByText('Remove this model from its subscriptions first')).toBeInTheDocument();
  expect(remove).not.toHaveBeenCalled();
});

it('leaves Delete to the backend when the subscriptions fail to load, and keeps the dialog when it refuses', async () => {
  const service = new MockConsoleService();
  const result = await referencedModel(service);
  subscriptionsOf(service).listError = new ConnectError('Service unavailable.', Code.Unavailable);
  const user = userEvent.setup();
  renderAt('/models', service);
  await user.click(await screen.findByTestId('model-actions-widget'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  await user.click(await screen.findByTestId('delete-modal-input'));
  await user.paste('Widget');
  await user.click(within(screen.getByTestId('delete-deployment-modal')).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByTestId('delete-model-error-message-alert')).toHaveTextContent('Remove this model');
  expect(screen.getByTestId('delete-deployment-modal')).toBeVisible();
  expect((await service.listModels()).find((m) => m.name === 'widget')?.resourceVersion).toBe(result.resourceVersion);
});

it('offers Ready, provisioned locations and protects models from stale versions', async () => {
  const service = new MockConsoleService();
  expect(await service.listLocations()).toEqual(['site1', 'site2', 'site3']);
  const before = (await service.listModels()).length;
  await expect(service.createModel({ ...input, locations: ['site4'] })).rejects.toMatchObject({
    status: 422,
    fieldErrors: { locations: 'Select locations from the available location catalog.' },
  });
  const result = await service.createModel(input);
  expect((await service.listModels()).find((m) => m.name === 'widget')?.locations).toEqual(['site1', 'site2']);
  expect(await service.listModels()).toHaveLength(before + 1);
  await expect(service.createModel(input)).rejects.toMatchObject({
    status: 409,
    message: 'A model with this resource name already exists.',
  });
  await expect(service.deleteModel('ai-grid-models', 'widget', `${result.resourceVersion}0`)).rejects.toMatchObject({
    status: 409,
    message: 'This model changed. Reload it before deleting.',
  });
  await service.deleteModel('ai-grid-models', 'widget', result.resourceVersion);
  expect(await service.listModels()).toHaveLength(before);
  expect((await service.listModels()).some((m) => m.name === 'widget')).toBe(false);
});

it('keeps the wizard usable after a location failure and retries', async () => {
  const service = new MockConsoleService();
  const list = service.listLocations.bind(service);
  // Fails when the wizard opens and again when the Locations step reloads; Retry succeeds.
  let failures = 2;
  service.listLocations = async () => {
    if (failures-- > 0) throw new ServiceError(503, 'Location catalog unavailable.');
    return list();
  };
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  expect(await screen.findByText('Location catalog unavailable.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  await user.click(screen.getByRole('option', { name: site1 }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByText('hf://org/widget')).toBeVisible();
  expect(screen.getByText(site1)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled();
});

it('loads the locations again when the Locations step opens', async () => {
  const service = new MockConsoleService();
  const list = service.listLocations.bind(service);
  // When the wizard opens only site1 is available; by the Locations step all three are.
  let calls = 0;
  service.listLocations = async () => (calls++ === 0 ? ['site1'] : list());
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  expect(await screen.findByRole('option', { name: site3 })).toBeVisible();
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([site1, site2, site3]);
});

it('keeps a chosen location the reload no longer offers, and says to remove it', async () => {
  const service = new MockConsoleService();
  const list = service.listLocations.bind(service);
  // site2 drops out after the first visit to the Locations step.
  let calls = 0;
  service.listLocations = async () => (calls++ < 2 ? list() : ['site1', 'site3']);
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  await user.click(screen.getByRole('option', { name: site1 }));
  await user.click(screen.getByRole('option', { name: site2 }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(await screen.findByText(`${site2} is no longer available. Remove it to continue.`)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: `Remove ${site2}` }));
  expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  // An exact match: the review lists site1 alone.
  expect(within(await screen.findByTestId('model-review')).getByText(site1)).toBeVisible();
});

it('keeps Next disabled until the Locations reload answers', async () => {
  const service = new MockConsoleService();
  const list = service.listLocations.bind(service);
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  // The reload on entering the step waits for the test.
  service.listLocations = async () => {
    if (calls++ === 1) await held;
    return list();
  };
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  await user.click(screen.getByRole('option', { name: site1 }));
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await act(async () => release());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
});

it('keeps chosen locations visible when the reload offers none', async () => {
  const service = new MockConsoleService();
  const list = service.listLocations.bind(service);
  let calls = 0;
  service.listLocations = async () => (calls++ < 2 ? list() : []);
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  await user.click(screen.getByRole('option', { name: site1 }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(await screen.findByText(`${site1} is no longer available. Remove it to continue.`)).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Locations' })).toHaveAttribute('aria-invalid', 'true');
  await user.click(screen.getByRole('button', { name: `Remove ${site1}` }));
  expect(await screen.findByText('No locations available')).toBeVisible();
});

describe('the hint about AI Grid clusters the Locations step leaves out', () => {
  const hint = /AI Grid clusters? (isn’t|aren’t) listed/;

  it('counts members whose location label is not offered, when locations are labels (fake backend)', async () => {
    const service = new MockConsoleService();
    service.clusters[2] = { ...service.clusters[2], status: 'Offline' };
    const user = userEvent.setup();
    renderAt('/models/deploy', service);
    await fillModel(user);
    await screen.findByRole('combobox', { name: 'Locations' });
    expect(await screen.findByText(hint)).toHaveTextContent('1 AI Grid cluster isn’t listed');
  });

  it('counts members whose name is not offered, when locations are cluster names (real backend)', async () => {
    const service = new MockConsoleService();
    // The real backend offers the enabled clusters' names; their location labels are regions.
    service.clusters = service.clusters.map((c) => ({ ...c, location: c.region }));
    service.listLocations = async () => ['site1', 'site2'];
    const user = userEvent.setup();
    renderAt('/models/deploy', service);
    await fillModel(user);
    await screen.findByRole('combobox', { name: 'Locations' });
    expect(await screen.findByText(hint)).toHaveTextContent('1 AI Grid cluster isn’t listed');
    service.listLocations = async () => ['site1', 'site2', 'site3'];
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('combobox', { name: 'Locations' });
    await waitFor(() => expect(screen.queryByText(hint)).not.toBeInTheDocument());
  });
});

it('keeps input when saving fails', async () => {
  const service = new MockConsoleService();
  await service.createModel(input);
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await fillModel(user);
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  await user.click(screen.getByRole('option', { name: site3 }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Deploy' }));
  expect(await screen.findByText('A model with this resource name already exists.')).toBeVisible();
  expect(screen.getByText('Unable to deploy model')).toBeVisible();
  expect(screen.getByText('hf://org/widget')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled();
  expect((await service.listModels()).find((m) => m.name === 'widget')?.locations).toEqual(['site1', 'site2']);
});

it('hides write actions until it knows the user is a provider admin', async () => {
  const service = unknownUser();
  renderAt('/models', service);
  await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('User could not be loaded'));
  const table = await screen.findByTestId('model-deployments-table');
  expect(table).toHaveTextContent('Granite 3.3 8B Instruct');
  expect(screen.queryByRole('link', { name: 'Deploy model' })).not.toBeInTheDocument();
  expect(screen.queryByTestId('model-actions-granite-3-8b')).not.toBeInTheDocument();
});

it('shows the not-available state when the backend has no models yet', async () => {
  const service = new MockConsoleService();
  service.listModels = async () => {
    throw new ServiceError(501, 'the AI Grid backend does not support this operation yet');
  };
  renderAt('/models', service);
  expect(await screen.findByText('Models are not available on this backend yet')).toBeVisible();
  expect(screen.queryByTestId('model-deployments-table')).not.toBeInTheDocument();
});

it('shows one pagination, in the toolbar, for a single page', async () => {
  renderAt('/models', new MockConsoleService());
  expect(await screen.findByTestId('model-deployments-table')).toBeVisible();
  expect(screen.getAllByRole('navigation', { name: /pagination/i })).toHaveLength(1);
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * A MockConsoleService whose model calls go through HttpConsoleService to the BFF's model JSON
 * (mock/examples/get-models.json), as the BFF answers over the fake's fixtures (mock/fixtures).
 */
const serviceOnModelJson = (fetchFn: ReturnType<typeof vi.fn>) => {
  const service = new MockConsoleService();
  const http = new HttpConsoleService(fetchFn as unknown as typeof fetch);
  service.listModels = () => http.listModels();
  service.getModel = (namespace, name) => http.getModel(namespace, name);
  service.listLocations = () => http.listLocations();
  service.createModel = (value) => http.createModel(value);
  service.deleteModel = (namespace, name, version) => http.deleteModel(namespace, name, version);
  service.updateModel = (namespace, name, update, version) => http.updateModel(namespace, name, update, version);
  return service;
};

/** The BFF's GET /models/{namespace}/{name}: that model from the list, or a 404. */
const oneModelJson = (url: string) => {
  const [namespace, name] = url
    .replace(/^.*\/models\//, '')
    .split('/')
    .map(decodeURIComponent);
  const model = getModels.body.data.find((m) => m.namespace === namespace && m.name === name);
  return model
    ? jsonResponse(200, { data: model })
    : jsonResponse(404, { error: { code: '404', message: `object with identifier '${namespace}/${name}' not found` } });
};

const isOneModel = (url: string, init?: RequestInit) =>
  (init?.method ?? 'GET') === 'GET' && /\/models\/[^/]+\/[^/]+$/.test(url);

const modelJsonFetch = () =>
  vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith('/locations')) return jsonResponse(200, { data: ['paris'] });
    if (isOneModel(url, init)) return oneModelJson(url);
    return jsonResponse(200, { data: getModels.body.data });
  });

it("lists the BFF's example models with their locations", async () => {
  renderAt('/models', serviceOnModelJson(modelJsonFetch()));
  const table = await screen.findByTestId('model-deployments-table');
  expect(table).toHaveTextContent('Granite 8B Instruct');
  expect(table).toHaveTextContent('Tiny LLM (CPU)');
  expect(screen.getByTestId('model-locations-granite-8b-instruct')).toHaveTextContent(/^paris$/);
  // No locations reads as a dash, with nothing to open.
  const none = screen.getByTestId('model-locations-tiny-llm');
  expect(none).toHaveTextContent('—');
  expect(within(none).queryByRole('button')).not.toBeInTheDocument();
});

it('shows the phase', async () => {
  const user = userEvent.setup();
  renderAt('/models', serviceOnModelJson(modelJsonFetch()));
  const row = async (name: string) =>
    (await screen.findByTestId(`model-locations-${name}`)).closest('tr') as HTMLElement;
  expect(within(await row('granite-8b-instruct')).getByTestId('model-phase')).toHaveTextContent('Ready');
  expect(within(await row('codellama-13b')).getByTestId('model-phase')).toHaveTextContent('Pending');
  const failed = within(await row('llama-3-70b')).getByTestId('model-phase');
  expect(failed).toHaveTextContent('Failed');
  expect(screen.queryByText(/Git/)).not.toBeInTheDocument();
  // An outline label that opens nothing, with the backend's message in its tooltip.
  const ready = within(await row('granite-8b-instruct')).getByTestId('model-phase');
  for (const phase of [ready, failed]) {
    expect(phase.querySelector('.pf-v6-c-label')).toHaveClass('pf-m-outline');
    expect(within(phase).queryByRole('button')).not.toBeInTheDocument();
  }
  await user.hover(within(failed).getByText('Failed'));
  expect(await screen.findByRole('tooltip')).toHaveTextContent(/v3-6-0-kserve-config-llm-template-tpu" not found/);
});

it('shows Saved to Git, not Pending, for a model the backend saved to Git', async () => {
  const saved = {
    ...getModels.body.data.find((m) => m.name === 'granite-8b-instruct')!,
    phase: undefined,
    reason: 'SavedToGit',
    message: 'Saved to Git; git mode doesn’t read the model’s status from the clusters',
  };
  const fetchFn = vi.fn(async (url: string) =>
    /\/models\/[^/]+\/[^/]+$/.test(url) ? jsonResponse(200, { data: saved }) : jsonResponse(200, { data: [saved] }),
  );
  renderAt('/models', serviceOnModelJson(fetchFn));
  const phase = within(
    (await screen.findByTestId('model-locations-granite-8b-instruct')).closest('tr') as HTMLElement,
  ).getByTestId('model-phase');
  expect(phase).toHaveTextContent(/^Saved to Git$/);
  // Neutral (grey, PatternFly's default), not Pending's in-progress info status.
  expect(phase.querySelector('.pf-v6-c-label')).not.toHaveClass('pf-m-info');
  // An outline label that opens nothing; the backend's git-mode message is its tooltip.
  expect(phase.querySelector('.pf-v6-c-label')).toHaveClass('pf-m-outline');
  expect(within(phase).queryByRole('button')).not.toBeInTheDocument();
  await userEvent.setup().hover(within(phase).getByText('Saved to Git'));
  expect(await screen.findByRole('tooltip')).toHaveTextContent(/^Saved to Git; git mode/);
  renderAt(`/models/${saved.namespace}/granite-8b-instruct`, serviceOnModelJson(fetchFn));
  expect(await screen.findByTestId('model-phase')).toHaveTextContent(/^Saved to Git$/);
  // The label says it all: no alert repeats the backend's git-mode message.
  expect(screen.queryByTestId('model-status-alert')).not.toBeInTheDocument();
  expect(screen.queryByText('Pending')).not.toBeInTheDocument();
});

it('offers only eligible locations', async () => {
  const fetchFn = modelJsonFetch();
  const user = userEvent.setup();
  renderAt('/models/deploy', serviceOnModelJson(fetchFn));
  await fillModel(user);
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['paris']);
  expect(fetchFn).toHaveBeenCalledWith('/api/v1/locations', expect.objectContaining({ method: 'GET' }));
});

it('deletes by namespace and name with If-Match', async () => {
  const fetchFn = modelJsonFetch();
  const user = userEvent.setup();
  renderAt('/models', serviceOnModelJson(fetchFn));
  await user.click(await screen.findByTestId('model-actions-granite-8b-instruct'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  await user.click(screen.getByTestId('delete-modal-input'));
  await user.paste('Granite 8B Instruct');
  await user.click(within(screen.getByTestId('delete-deployment-modal')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByTestId('delete-deployment-modal')).not.toBeInTheDocument());
  const call = fetchFn.mock.calls.find(([, init]) => init?.method === 'DELETE');
  // A delete from the list says so, as one from the model's page does.
  expect(await screen.findByText('Model deployment deleted')).toBeVisible();
  expect(call?.[0]).toBe('/api/v1/models/ai-grid-models/granite-8b-instruct');
  expect(call?.[1]?.headers).toMatchObject({ 'If-Match': '"48760230"' });
});

it("shows the Model URI rule's message once the user leaves an invalid URI", async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  const uri = await screen.findByRole('textbox', { name: /Model URI/ });
  await user.click(screen.getByRole('textbox', { name: /^Model name/ }));
  await user.paste('org/widget');
  await user.click(uri);
  await user.paste('https:///123.com');
  expect(screen.queryByText('Enter a model URI using hf, oci, s3 or pvc.')).not.toBeInTheDocument();
  await user.tab();
  expect(screen.getByText('Enter a model URI using hf, oci, s3 or pvc.')).toBeVisible();
  expect(uri).toHaveAttribute('aria-invalid', 'true');
  expect(uri).toHaveAccessibleDescription(/^Enter a model URI using hf, oci, s3 or pvc\./);
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await user.clear(uri);
  await user.paste('hf://org/widget');
  expect(screen.queryByText('Enter a model URI using hf, oci, s3 or pvc.')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
});

it('says a required field is required once the user leaves it empty', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  const uri = await screen.findByRole('textbox', { name: /Model URI/ });
  const name = screen.getByRole('textbox', { name: /^Model name/ });
  await user.click(name);
  await user.paste('org/widget');
  await user.clear(name);
  await user.tab();
  expect(name).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getAllByText('Required.')).toHaveLength(1);
  expect(uri).not.toHaveAttribute('aria-invalid', 'true');
});

it('says why the deployment step cannot continue when the CPU is invalid', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('textbox', { name: /^Model name/ }));
  await user.paste('org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await nameDeployment(user, 'Widget');
  await user.click(screen.getByRole('textbox', { name: /Runtime image/ }));
  await user.paste('registry.example/runtime:test');
  await chooseServer(user);
  const cpu = screen.getByRole('textbox', { name: /^CPU/ });
  await user.clear(cpu);
  await user.paste('2 cores');
  await user.tab();
  expect(screen.getByText('Enter positive CPU cores or millicores, for example 2 or 500m.')).toBeVisible();
  expect(cpu).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});

it('shows the Locations error only after the user clears a selection', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  await fillModel(user);
  const combobox = await screen.findByRole('combobox', { name: 'Locations' });
  expect(screen.queryByText('Select at least one location.')).not.toBeInTheDocument();
  await user.click(combobox);
  await user.click(screen.getByRole('option', { name: site1 }));
  await user.click(screen.getByRole('option', { name: site1 }));
  await user.keyboard('{Escape}');
  expect(screen.getByText('Select at least one location.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});

it("takes only the fake backend's URI schemes and sends the URI trimmed", async () => {
  const service = new MockConsoleService();
  const create = vi.spyOn(service, 'createModel');
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  const uri = await screen.findByRole('textbox', { name: /Model URI/ });
  await user.click(screen.getByRole('textbox', { name: /^Model name/ }));
  await user.paste('org/widget');
  await user.click(uri);
  await user.paste('https://models.example.com/widget');
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await user.clear(uri);
  await user.paste(' hf://org/widget ');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await nameDeployment(user, 'Widget');
  await user.click(screen.getByRole('textbox', { name: /Runtime image/ }));
  await user.paste('registry.example/runtime:test');
  await chooseServer(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  await user.click(screen.getByRole('option', { name: site1 }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Deploy' }));
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0][0].modelUri).toBe('hf://org/widget');
});

it.each(['/models/ai-grid-models/granite-research', '/models/ai-grid-models/granite-research/edit'])(
  'offers Retry when a model fails to load: %s',
  async (path) => {
    const service = new MockConsoleService();
    const get = service.getModel;
    service.getModel = async () => {
      service.getModel = get;
      throw new ServiceError(503, 'Service unavailable.');
    };
    const user = userEvent.setup();
    renderAt(path, service);
    expect(await screen.findByRole('heading', { name: 'Unable to load model' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: /Granite research endpoint|granite-research/ }),
    ).toBeVisible();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  },
);

describe('a failed background poll', () => {
  // Only the 30-second polls are faked; user-event and findBy keep real timeouts.
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  it("keeps a model's page under a warning, so stale data doesn't look current", async () => {
    const service = new MockConsoleService();
    renderAt('/models/ai-grid-models/granite-research', service);
    expect(await screen.findByRole('heading', { level: 1, name: 'Granite research endpoint' })).toBeVisible();
    vi.spyOn(service, 'getModel').mockRejectedValue(new ServiceError(503, 'Service unavailable.'));
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(await screen.findByTestId('stale-data-alert')).toHaveTextContent(
      'Showing the last loaded modelService unavailable.',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Granite research endpoint' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Deployment' })).toBeVisible();
  });

  it('keeps the list and shows the error above it', async () => {
    const service = new MockConsoleService();
    renderAt('/models', service);
    expect(await screen.findByTestId('model-deployments-table')).toHaveTextContent('Granite 3.3 8B Instruct');
    const failed = vi.spyOn(service, 'listModels').mockRejectedValue(new ServiceError(503, 'Service unavailable.'));
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    await waitFor(() => expect(failed).toHaveBeenCalled());
    expect(await screen.findByText('Showing the last loaded models')).toBeVisible();
    expect(screen.getByTestId('model-deployments-table')).toHaveTextContent('Granite 3.3 8B Instruct');
  });
});

describe('a background poll during the delete dialog', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  it('deletes the version the user confirmed, not one a poll loaded while the dialog was open', async () => {
    const service = new MockConsoleService();
    const user = userEvent.setup();
    renderAt('/models', service);
    await user.click(await screen.findByTestId('model-actions-granite-research'));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByTestId('delete-deployment-modal');
    await user.click(within(dialog).getByTestId('delete-modal-input'));
    await user.paste('Granite research endpoint');
    service.models[2] = { ...service.models[2], resourceVersion: `${service.models[2].resourceVersion}1` };
    const poll = vi.spyOn(service, 'listModels');
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    await waitFor(() => expect(poll).toHaveBeenCalled());
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('This model changed. Reload it before deleting.')).toBeVisible();
    expect(service.models.some((m) => m.name === 'granite-research')).toBe(true);
  });
});

it('reloads the model after a stale delete, so a retry succeeds', async () => {
  // granite-research is in no seed subscription or policy, so nothing else blocks its delete.
  const service = new MockConsoleService();
  const user = userEvent.setup();
  renderAt('/models', service);
  await user.click(await screen.findByTestId('model-actions-granite-research'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const dialog = await screen.findByTestId('delete-deployment-modal');
  await user.click(within(dialog).getByTestId('delete-modal-input'));
  await user.paste('Granite research endpoint');
  service.models[2] = { ...service.models[2], resourceVersion: `${service.models[2].resourceVersion}1` };
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('This model changed. Reload it before deleting.')).toBeVisible();
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByTestId('delete-deployment-modal')).not.toBeInTheDocument());
  expect(service.models.some((m) => m.name === 'granite-research')).toBe(false);
});

it('keeps the delete dialog busy until the reloaded model is in, and says when the reload fails', async () => {
  const service = new MockConsoleService();
  const user = userEvent.setup();
  renderAt('/models', service);
  await user.click(await screen.findByTestId('model-actions-granite-research'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const dialog = await screen.findByTestId('delete-deployment-modal');
  await user.click(within(dialog).getByTestId('delete-modal-input'));
  await user.paste('Granite research endpoint');
  service.models[2] = { ...service.models[2], resourceVersion: `${service.models[2].resourceVersion}1` };
  const deleteSpy = vi.spyOn(service, 'deleteModel');
  const reload = deferred<ManagedModel>();
  const reloadSpy = vi.spyOn(service, 'getModel').mockReturnValueOnce(reload.promise);
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1));
  // The reload is still out: Delete stays busy, so no retry with the stale version.
  expect(within(dialog).getByRole('button', { name: /Delete/ })).toBeDisabled();
  await user.type(within(dialog).getByTestId('delete-modal-input'), '{Enter}');
  expect(deleteSpy).toHaveBeenCalledTimes(1);
  await act(async () => {
    reload.resolve(service.models[2]);
  });
  expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled();

  // A second stale delete whose reload fails says so.
  service.models[2] = { ...service.models[2], resourceVersion: `${service.models[2].resourceVersion}1` };
  reloadSpy.mockRejectedValueOnce(new ServiceError(503, 'Service unavailable.'));
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  expect(await within(dialog).findByText(/could not be loaded again: Service unavailable\./)).toBeVisible();
  expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled();
});

it('takes a display name longer than a resource name', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('textbox', { name: /^Model name/ }));
  await user.paste('org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await nameDeployment(user, 'W'.repeat(70));
  await user.click(screen.getByRole('textbox', { name: /Runtime image/ }));
  await user.paste('registry.example/runtime:test');
  await chooseServer(user);
  expect(screen.getByText('w'.repeat(63))).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
});

it('starts the deployment name from the model name, and keeps a name the user typed', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  expect(await screen.findByRole('button', { name: 'Back' })).toBeDisabled();
  await user.click(screen.getByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('textbox', { name: /^Model name/ }));
  await user.paste('org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByTestId('model-name-desc-name')).toHaveValue('widget');
  await nameDeployment(user, 'My widget');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByTestId('model-name-desc-name')).toHaveValue('My widget');
});

it('folds the runtime arguments away under Advanced settings, with no dead controls', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('textbox', { name: /^Model name/ }));
  await user.paste('org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  const args = await screen.findByTestId('runtime-args-textarea');
  expect(args).not.toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Advanced settings' }));
  expect(args).toBeVisible();
  expect(screen.queryByRole('button', { name: 'View predefined arguments' })).not.toBeInTheDocument();
});

it('asks before Cancel discards the wizard input', async () => {
  const service = new MockConsoleService();
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  // Nothing typed yet: Cancel leaves at once.
  await user.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(await screen.findByTestId('model-deployments-table')).toBeVisible();
  await user.click(screen.getByRole('link', { name: 'Deploy model' }));
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  const discard = await screen.findByTestId('discard-changes-modal');
  await user.click(within(discard).getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByRole('textbox', { name: /Model URI/ })).toHaveValue('hf://org/widget');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(within(await screen.findByTestId('discard-changes-modal')).getByRole('button', { name: 'Discard' }));
  expect(await screen.findByTestId('model-deployments-table')).toBeVisible();
});

it('opens a model page with its configuration, locations by site, and a failure explained', async () => {
  const user = userEvent.setup();
  renderAt('/models', serviceOnModelJson(modelJsonFetch()));
  await user.click(await screen.findByRole('link', { name: 'Llama 3 70B' }));
  expect(await screen.findByRole('heading', { name: 'Llama 3 70B' })).toBeVisible();
  const alert = screen.getByTestId('model-status-alert');
  expect(alert).toHaveTextContent('Deployment failed');
  expect(alert).toHaveTextContent('Install the template on the hub, or deploy the model with another runtime.');
  expect(screen.getByText('hf://example-org/llama-3-70b')).toBeVisible();
  expect(screen.getByText('The placement hasn’t chosen any locations yet.')).toBeVisible();
});

it('deletes a model from its page and returns to the list', async () => {
  const service = new MockConsoleService();
  const user = userEvent.setup();
  renderAt('/models/ai-grid-models/granite-research', service);
  await user.click(await screen.findByTestId('model-actions'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const dialog = await screen.findByTestId('delete-deployment-modal');
  await user.click(within(dialog).getByTestId('delete-modal-input'));
  await user.paste('Granite research endpoint');
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('Model deployment deleted')).toBeVisible();
  expect(await screen.findByTestId('model-deployments-table')).not.toHaveTextContent('Granite research endpoint');
});

it('says when a model page has no model', async () => {
  renderAt('/models/ai-grid-models/nope', new MockConsoleService());
  expect(await screen.findByText('Model deployment not found')).toBeVisible();
});

it('loads only the one model on its page and its edit page', async () => {
  const service = new MockConsoleService();
  const listModels = vi.spyOn(service, 'listModels');
  const getModel = vi.spyOn(service, 'getModel');
  const { name } = service.models[0];
  const page = renderAt(`/models/ai-grid-models/${name}`, service);
  expect(await screen.findByRole('heading', { level: 1, name: service.models[0].displayName })).toBeVisible();
  page.unmount();
  renderAt(`/models/ai-grid-models/${name}/edit`, service);
  expect(await screen.findByRole('navigation', { name: 'Wizard steps' })).toBeVisible();
  expect(getModel).toHaveBeenCalledWith('ai-grid-models', name);
  expect(listModels).not.toHaveBeenCalled();
});

it('takes only whole numbers in the number fields, so the shown and sent counts agree', async () => {
  const service = new MockConsoleService();
  const create = vi.spyOn(service, 'createModel');
  const user = userEvent.setup();
  renderAt('/models/deploy', service);
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('textbox', { name: /^Model name/ }));
  await user.paste('org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('textbox', { name: /Runtime image/ }));
  await user.paste('registry.example/runtime:test');
  await chooseServer(user);
  const replicas = screen.getByRole('spinbutton', { name: 'Replicas' });
  // 1e1 and 1.5 would show as 1 but parse as 10 and 1.5: they're refused.
  fireEvent.change(replicas, { target: { value: '1e1' } });
  expect(replicas).toHaveValue(1);
  fireEvent.change(replicas, { target: { value: '1.5' } });
  expect(replicas).toHaveValue(1);
  fireEvent.change(replicas, { target: { value: '3' } });
  expect(replicas).toHaveValue(3);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
  await user.click(screen.getByRole('option', { name: site1 }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByTestId('model-review')).toHaveTextContent('Replicas3');
  await user.click(screen.getByRole('button', { name: 'Deploy' }));
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0][0].replicas).toBe(3);
});

it('keeps an emptied Replicas or GPUs field empty and says it is required', async () => {
  const user = userEvent.setup();
  renderAt('/models/deploy', new MockConsoleService());
  await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
  await user.paste('hf://org/widget');
  await user.click(screen.getByRole('textbox', { name: /^Model name/ }));
  await user.paste('org/widget');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Model server' }), 'vLLM on NVIDIA GPU');
  for (const name of ['Replicas', 'GPUs']) {
    const field = screen.getByRole('spinbutton', { name });
    expect(field).toHaveAccessibleDescription(name === 'Replicas' ? 'Between 1 and 99.' : 'Between 1 and 64.');
    await user.clear(field);
    await user.tab();
    // NumberInput would turn the empty field into 0 on blur.
    expect(field).toHaveValue(null);
    // PatternFly adds ": error status;" for screen readers.
    expect(field).toHaveAccessibleDescription(/^Required\./);
  }
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});

it('names only the subscriptions whose refs the backend joins to this model', async () => {
  const service = new MockConsoleService();
  await service.createModel(input);
  widgetUsers(service);
  const user = userEvent.setup();
  const other = renderAt('/models/ai-grid-models/granite-research', service);
  await user.click(await screen.findByTestId('model-actions'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(await screen.findByTestId('delete-deployment-modal')).toBeVisible();
  // Let the subscriptions load before checking nothing is named.
  await act(async () => {});
  expect(screen.queryByTestId('model-references')).not.toBeInTheDocument();
  other.unmount();
  renderAt('/models/ai-grid-models/widget', service);
  await user.click(await screen.findByTestId('model-actions'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(await screen.findByTestId('model-references')).toHaveTextContent('widget-users');
});

describe('the model server', () => {
  const cpuPreset = 'v3-6-0-kserve-config-llm-template-cpu';

  /** Fills the source step, opens Deployment, and returns the createModel spy. */
  const openDeployment = async (user: User, service = new MockConsoleService()) => {
    const create = vi.spyOn(service, 'createModel');
    renderAt('/models/deploy', service);
    await user.type(await screen.findByRole('textbox', { name: /Model URI/ }), 'hf://org/widget');
    await user.type(screen.getByRole('textbox', { name: /^Model name/ }), 'org/widget');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    return create;
  };

  /** Picks one location if none is picked yet, opens Review and, unless told not to, deploys. */
  const deploy = async (user: User, { submit = true } = {}) => {
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const locations = await screen.findByRole('combobox', { name: 'Locations' });
    if (!screen.queryByText(site1)) {
      await user.click(locations);
      await user.click(screen.getByRole('option', { name: site1 }));
      await user.keyboard('{Escape}');
    }
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const review = await screen.findByTestId('model-review');
    if (submit) await user.click(screen.getByRole('button', { name: 'Deploy' }));
    return review;
  };

  it('has no default server: the step waits for a choice, then deploys on the CPU preset with no GPUs', async () => {
    const user = userEvent.setup();
    const create = await openDeployment(user);
    const server = screen.getByRole('combobox', { name: 'Model server' });
    expect(server).toHaveValue('');
    expect(screen.queryByRole('spinbutton', { name: 'GPUs' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /Runtime image/ }), 'registry.example/vllm-cpu:test');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    server.focus();
    await user.tab();
    expect(server).toHaveAccessibleDescription(/Required\./);
    await chooseServer(user);
    expect(screen.queryByRole('spinbutton', { name: 'GPUs' })).not.toBeInTheDocument();
    const review = await deploy(user);
    expect(review).toHaveTextContent('Model servervLLM on CPU');
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({
      baseRefs: [cpuPreset],
      runtimeImage: 'registry.example/vllm-cpu:test',
      gpuCount: 0,
    });
  });

  it('warns on Review when a chosen location doesn’t match the server’s hardware', async () => {
    const user = userEvent.setup();
    await openDeployment(user);
    await user.type(screen.getByRole('textbox', { name: /Runtime image/ }), 'registry.example/vllm-cpu:test');
    await chooseServer(user);
    // The mock's member clusters each report 16 GPUs.
    await deploy(user, { submit: false });
    expect(await screen.findByTestId('model-server-mismatch')).toHaveTextContent(/GPUs that vLLM on CPU doesn.t use/);
    await user.click(
      within(screen.getByRole('navigation', { name: 'Wizard steps' })).getByRole('button', { name: 'Deployment' }),
    );
    await chooseServer(user, 'vLLM on NVIDIA GPU');
    await deploy(user, { submit: false });
    await screen.findByTestId('model-review');
    expect(screen.queryByTestId('model-server-mismatch')).not.toBeInTheDocument();
  });

  it('refuses a GPU server with no GPUs, and sends no presets for KServe’s default', async () => {
    const user = userEvent.setup();
    const create = await openDeployment(user);
    await user.type(screen.getByRole('textbox', { name: /Runtime image/ }), 'registry.example/vllm-cuda:test');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model server' }), 'vLLM on NVIDIA GPU');
    const gpus = screen.getByRole('spinbutton', { name: 'GPUs' });
    // Switching to a GPU server starts it at one GPU.
    expect(gpus).toHaveValue(1);
    await user.clear(gpus);
    await user.type(gpus, '0');
    await user.tab();
    expect(gpus).toHaveAccessibleDescription(/A GPU model server needs at least 1 GPU\./);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.change(gpus, { target: { value: '2' } });
    await deploy(user);
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ baseRefs: [], gpuCount: 2 });
  });

  it('sends no GPUs after switching back to CPU, even from an emptied GPUs field', async () => {
    const user = userEvent.setup();
    const create = await openDeployment(user);
    await user.type(screen.getByRole('textbox', { name: /Runtime image/ }), 'registry.example/vllm-cpu:test');
    const server = screen.getByRole('combobox', { name: 'Model server' });
    await user.selectOptions(server, 'vLLM on NVIDIA GPU');
    await user.clear(screen.getByRole('spinbutton', { name: 'GPUs' }));
    await user.selectOptions(server, 'vLLM on CPU');
    // The hidden field can't hold the step back.
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    await deploy(user);
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ baseRefs: [cpuPreset], gpuCount: 0 });
  });

  it('still refuses an image with spaces', async () => {
    const user = userEvent.setup();
    await openDeployment(user);
    await user.type(screen.getByRole('textbox', { name: /Runtime image/ }), 'bad image');
    await user.tab();
    expect(screen.getByRole('textbox', { name: /Runtime image/ })).toHaveAccessibleDescription(
      /Enter a container image without spaces\./,
    );
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('shows the server a deployed model runs on, read-only, and presets the console doesn’t offer by name', async () => {
    const service = new MockConsoleService();
    service.models[0] = { ...service.models[0], baseRefs: ['custom-preset'] };
    const user = userEvent.setup();
    renderAt(`/models/ai-grid-models/${service.models[0].name}/edit`, service);
    await user.click(
      within(await screen.findByRole('navigation', { name: 'Wizard steps' })).getByRole('button', {
        name: 'Deployment',
      }),
    );
    expect(await screen.findByRole('textbox', { name: 'Model server' })).toHaveValue('custom-preset');
    expect(screen.getByRole('textbox', { name: 'Model server' })).toHaveAttribute('readonly');
  });

  it("names the model's server on its page", async () => {
    const service = new MockConsoleService();
    renderAt(`/models/ai-grid-models/${service.models[0].name}`, service);
    expect(await screen.findByText('vLLM on CPU')).toBeVisible();
  });
});

describe('editing a model deployment', () => {
  /** Opens a step from the wizard's navigation: every step is open from the start when editing. */
  const openStep = async (user: User, name: 'Source' | 'Deployment' | 'Locations' | 'Review') =>
    user.click(within(await screen.findByRole('navigation', { name: 'Wizard steps' })).getByRole('button', { name }));

  it('reuses the deploy wizard: fixed fields read-only, every step open, and only the changes sent', async () => {
    const service = new MockConsoleService();
    const update = vi.spyOn(service, 'updateModel');
    const user = userEvent.setup();
    renderAt('/models/ai-grid-models/granite-3-8b', service);
    await user.click(await screen.findByRole('button', { name: 'Actions for Granite 3.3 8B Instruct' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

    expect(await screen.findByRole('heading', { name: 'Edit Granite 3.3 8B Instruct' })).toBeVisible();
    // Source: the model a deployment serves can't change.
    expect(screen.getByRole('textbox', { name: 'Model URI' })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: 'Model name' })).toHaveAttribute('readonly');
    // Nothing changed yet, so Review can't save.
    await openStep(user, 'Review');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await openStep(user, 'Deployment');
    // The resource name and resources are fixed once deployed.
    expect(screen.queryByTestId('model-name-desc-name')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'CPU' })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: 'Memory' })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: 'GPUs' })).toHaveAttribute('readonly');
    const replicas = screen.getByRole('spinbutton', { name: 'Replicas' });
    await user.clear(replicas);
    await user.paste('3');

    await openStep(user, 'Locations');
    await user.click(await screen.findByRole('combobox', { name: 'Locations' }));
    await user.click(screen.getByRole('option', { name: site2 }));
    await user.keyboard('{Escape}');

    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Model deployment updated')).toBeVisible();
    expect(update).toHaveBeenCalledWith(
      'ai-grid-models',
      'granite-3-8b',
      { replicas: 3, placement: consolePlacement(['site1', 'site2']) },
      '1',
    );
    // Back on the model's page, with the new values.
    expect(await screen.findByRole('heading', { name: 'Granite 3.3 8B Instruct' })).toBeVisible();
    expect(within(screen.getByTestId('model-locations')).getByText(site2)).toBeVisible();
  });

  it('sends the display name, description and runtime arguments in their whole maps', async () => {
    const service = new MockConsoleService();
    service.models[0].annotations = { ...service.models[0].annotations, team: 'research' };
    service.models[0].env = [{ name: 'VLLM_CPU_KVCACHE_SPACE', value: '8' }];
    const update = vi.spyOn(service, 'updateModel');
    const user = userEvent.setup();
    renderAt(`/models/ai-grid-models/${service.models[0].name}/edit`, service);
    await openStep(user, 'Deployment');
    const description = await screen.findByRole('textbox', { name: 'Description' });
    await user.clear(description);
    await user.paste('Updated description');
    await user.click(screen.getByRole('button', { name: 'Advanced settings' }));
    await user.click(screen.getByRole('textbox', { name: 'Additional runtime arguments' }));
    await user.paste('--enforce-eager');
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const [, , sent] = update.mock.calls[0];
    // Other annotations and env vars go back as loaded.
    expect(sent.annotations).toEqual({
      'openshift.io/display-name': 'Granite 3.3 8B Instruct',
      'openshift.io/description': 'Updated description',
      team: 'research',
    });
    expect(sent.env).toEqual([
      { name: 'VLLM_CPU_KVCACHE_SPACE', value: '8' },
      { name: 'VLLM_ADDITIONAL_ARGS', value: '--enforce-eager' },
    ]);
    expect(Object.keys(sent).sort()).toEqual(['annotations', 'env']);
  });

  it('leaves the display name alone when only the description changes on a model without one', async () => {
    const service = new MockConsoleService();
    const model = service.models[0];
    const annotations = { ...model.annotations };
    delete annotations['openshift.io/display-name'];
    service.models[0] = { ...model, annotations, displayName: undefined };
    const update = vi.spyOn(service, 'updateModel');
    const user = userEvent.setup();
    renderAt(`/models/ai-grid-models/${model.name}/edit`, service);
    await openStep(user, 'Deployment');
    const description = await screen.findByRole('textbox', { name: 'Description' });
    await user.clear(description);
    await user.paste('new');
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    // The name field started from the resource name; keeping it writes no display name.
    expect(update.mock.calls[0][2].annotations).not.toHaveProperty('openshift.io/display-name');
    expect(update.mock.calls[0][2].annotations).toHaveProperty('openshift.io/description', 'new');
    // As the BFF: no display name without the annotation.
    expect(service.models[0].displayName).toBeUndefined();
  });

  it('says a resource the model was deployed without is not set', async () => {
    const service = new MockConsoleService();
    service.models[0] = { ...service.models[0], cpu: undefined, memory: undefined };
    const user = userEvent.setup();
    renderAt(`/models/ai-grid-models/${service.models[0].name}/edit`, service);
    await openStep(user, 'Deployment');
    expect(await screen.findByRole('textbox', { name: 'CPU' })).toHaveValue('Not set');
    expect(screen.getByRole('textbox', { name: 'Memory' })).toHaveValue('Not set');
  });

  it('treats spaces around a runtime argument as no change', async () => {
    const service = new MockConsoleService();
    service.models[0].env = [{ name: 'VLLM_ADDITIONAL_ARGS', value: '--enforce-eager' }];
    const user = userEvent.setup();
    renderAt(`/models/ai-grid-models/${service.models[0].name}/edit`, service);
    await openStep(user, 'Deployment');
    await user.click(await screen.findByRole('button', { name: 'Advanced settings' }));
    // A space at the end of the argument's own line (the textarea ends with a blank line).
    const end = '--enforce-eager'.length;
    await user.type(screen.getByRole('textbox', { name: 'Additional runtime arguments' }), ' ', {
      initialSelectionStart: end,
      initialSelectionEnd: end,
    });
    expect(screen.getByRole('textbox', { name: 'Additional runtime arguments' })).toHaveValue('--enforce-eager \n');
    await openStep(user, 'Review');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('shows a placement written outside the console read-only and leaves it alone', async () => {
    const service = new MockConsoleService();
    service.models[0].placementSpec = { clusterSets: ['global'], matchLabels: { 'ai-grid/enabled': 'true' } };
    const update = vi.spyOn(service, 'updateModel');
    const user = userEvent.setup();
    renderAt(`/models/ai-grid-models/${service.models[0].name}/edit`, service);
    await openStep(user, 'Locations');
    expect(await screen.findByRole('textbox', { name: 'Locations' })).toHaveAttribute('readonly');
    expect(screen.getByText(/selects clusters by more than location/)).toBeVisible();
    await openStep(user, 'Deployment');
    const replicas = screen.getByRole('spinbutton', { name: 'Replicas' });
    await user.clear(replicas);
    await user.paste('2');
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][2]).toEqual({ replicas: 2 });
  });

  it('says the deployment changed when the version it opened is stale', async () => {
    const service = new MockConsoleService();
    const user = userEvent.setup();
    renderAt(`/models/ai-grid-models/${service.models[0].name}/edit`, service);
    await openStep(user, 'Deployment');
    const replicas = await screen.findByRole('spinbutton', { name: 'Replicas' });
    await user.clear(replicas);
    await user.paste('4');
    // Another tab saves first.
    service.models[0].resourceVersion = '9';
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText(
        'This model deployment changed since you opened it. Reload the page to edit the current version.',
      ),
    ).toBeVisible();
  });

  it('saves an unrelated change while a kept location is not offered, or the locations fail to load', async () => {
    const service = new MockConsoleService();
    const update = vi.spyOn(service, 'updateModel');
    // site1, where the model runs, is no longer offered, and the next load fails.
    let calls = 0;
    service.listLocations = async () => {
      if (calls++ === 0) return ['site2'];
      throw new ServiceError(503, 'Location catalog unavailable.');
    };
    const user = userEvent.setup();
    renderAt('/models/ai-grid-models/granite-3-8b/edit', service);
    await openStep(user, 'Locations');
    await openStep(user, 'Deployment');
    const description = await screen.findByRole('textbox', { name: 'Description' });
    await user.clear(description);
    await user.paste('Still on site1');
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][2]).not.toHaveProperty('placement');
  });

  it.each([
    ['no stored count', undefined],
    ['a count outside the deploy wizard’s limits', 0],
  ])('leaves the replicas alone when the model has %s', async (_, replicas) => {
    const service = new MockConsoleService();
    service.models[0].replicas = replicas;
    const update = vi.spyOn(service, 'updateModel');
    const user = userEvent.setup();
    renderAt(`/models/ai-grid-models/${service.models[0].name}/edit`, service);
    await openStep(user, 'Deployment');
    const description = await screen.findByRole('textbox', { name: 'Description' });
    await user.click(description);
    await user.paste(' (edited)');
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][2]).not.toHaveProperty('replicas');
  });

  it('shows an autoscaled model’s replicas as Autoscaled, on its step and in Review', async () => {
    const service = new MockConsoleService();
    service.models[0].autoscaled = true;
    service.models[0].replicas = undefined;
    const user = userEvent.setup();
    renderAt(`/models/ai-grid-models/${service.models[0].name}/edit`, service);
    await openStep(user, 'Deployment');
    expect(await screen.findByRole('textbox', { name: 'Replicas' })).toHaveValue('Autoscaled');
    await openStep(user, 'Review');
    expect(within(await screen.findByTestId('model-review')).getByText('Autoscaled')).toBeVisible();
  });

  it('sends the edit through the BFF, keeping other annotations and env, and keeps input on a 422', async () => {
    const fetchFn = modelJsonFetch();
    const json = getModels.body.data.find((m) => m.name === 'tiny-llm')!;
    fetchFn.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return jsonResponse(422, { error: { code: '422', message: 'spec.main.image: Invalid value' } });
      }
      if (url.endsWith('/locations')) return jsonResponse(200, { data: ['paris'] });
      if (isOneModel(url, init)) return oneModelJson(url);
      return jsonResponse(200, { data: getModels.body.data });
    });
    const user = userEvent.setup();
    renderAt('/models/ai-grid-models/tiny-llm/edit', serviceOnModelJson(fetchFn));
    await openStep(user, 'Deployment');
    await user.clear(await screen.findByRole('textbox', { name: 'Description' }));
    await user.click(screen.getByRole('button', { name: 'Advanced settings' }));
    await user.click(screen.getByRole('textbox', { name: 'Additional runtime arguments' }));
    await user.paste('--enforce-eager');
    await openStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('spec.main.image: Invalid value')).toBeVisible();
    const patch = fetchFn.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patch?.[0]).toBe('/api/v1/models/ai-grid-models/tiny-llm');
    expect(patch?.[1]?.headers).toMatchObject({ 'If-Match': `"${json.resourceVersion}"` });
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      // The description is cleared; the display name and the other variable stay as loaded.
      annotations: { 'openshift.io/display-name': 'Tiny LLM (CPU)' },
      env: [
        { name: 'VLLM_CPU_KVCACHE_SPACE', value: '8' },
        { name: 'VLLM_ADDITIONAL_ARGS', value: '--enforce-eager' },
      ],
    });
    // The input is still there to fix and save again.
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await openStep(user, 'Deployment');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('');
  });

  it('offers Edit from the list, next to the details and Delete', async () => {
    const service = new MockConsoleService();
    const user = userEvent.setup();
    renderAt('/models', service);
    await user.click(await screen.findByRole('button', { name: 'Actions for Granite 3.3 8B Instruct' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['View details', 'Edit', 'Delete']);
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(await screen.findByRole('heading', { name: 'Edit Granite 3.3 8B Instruct' })).toBeVisible();
  });
});

it('shows the loading spinner until the models arrive, then the list in its place', async () => {
  const service = new MockConsoleService();
  const list = service.listModels.bind(service);
  let release: () => void = () => undefined;
  service.listModels = () =>
    new Promise((resolve, reject) => {
      release = () => void list().then(resolve, reject);
    });
  renderAt('/models', service);
  const spinner = await screen.findByRole('progressbar', { name: 'Loading models' });
  // The spinner fills the content section on its own; the table isn't there yet.
  expect(spinner.closest('.pf-v6-c-page__main-section')).toHaveClass('pf-m-fill');
  expect(screen.queryByRole('grid', { name: 'Model deployments' })).not.toBeInTheDocument();
  act(() => release());
  expect(await screen.findByRole('grid', { name: 'Model deployments' })).toBeVisible();
  expect(screen.queryByRole('progressbar', { name: 'Loading models' })).not.toBeInTheDocument();
});

describe('each location of a placed model (proposal P13)', () => {
  const at = '2026-10-26T12:00:00Z';
  // Mistral as the backend answers once it serves on two of its three clusters: site1 Ready,
  // site2 failed to apply, site3 still starting.
  const partialJson = () => {
    const data = structuredClone(getModels.body.data) as unknown as Record<string, unknown>[];
    const mistral = data.find((m) => m.name === 'mistral-7b-instruct')!;
    mistral.phase = 'partiallyavailable';
    mistral.reason = 'PartiallyAvailable';
    mistral.message = '1 of 3 clusters are serving the model.';
    (mistral.placement as { locations: string[] }).locations = ['site1', 'site2', 'site3'];
    (mistral.rollout as { works: unknown[] }).works = [
      {
        cluster: 'site1',
        phase: 'ready',
        feedback: { ready: 'True' },
        conditions: [
          { type: 'Applied', status: 'True', reason: 'AppliedManifestWorkComplete', lastTransitionTime: at },
          { type: 'Available', status: 'True', reason: 'ResourcesAvailable', lastTransitionTime: at },
          { type: 'Progressing', status: 'False', reason: 'ConditionRulesAggregated', lastTransitionTime: at },
          { type: 'Degraded', status: 'False', reason: 'ConditionRulesAggregated', lastTransitionTime: at },
        ],
      },
      {
        cluster: 'site2',
        phase: 'failed',
        reason: 'AppliedManifestWorkFailed',
        message: 'Failed to apply manifest work',
        conditions: [
          {
            type: 'Applied',
            status: 'False',
            reason: 'AppliedManifestWorkFailed',
            message: 'Failed to apply manifest work',
            lastTransitionTime: at,
          },
          {
            type: 'Available',
            status: 'Unknown',
            reason: 'ResourcesStatusUnknown',
            message: '1 of 2 resources have unknown status',
            lastTransitionTime: at,
          },
        ],
      },
      { cluster: 'site3', phase: 'pending', conditions: [] },
    ];
    return data;
  };
  const partialFetch = () =>
    vi.fn(async (url: string, init?: RequestInit) => {
      const data = partialJson();
      if (isOneModel(url, init)) {
        const name = decodeURIComponent(url.split('/').pop()!);
        return jsonResponse(200, { data: data.find((m) => m.name === name) });
      }
      return jsonResponse(200, { data });
    });
  const mistralRow = async () =>
    (await screen.findByTestId('model-locations-mistral-7b-instruct')).closest('tr') as HTMLElement;

  it('expands a model to each cluster, named by its location, with the status the backend derived', async () => {
    const user = userEvent.setup();
    renderAt('/models', serviceOnModelJson(partialFetch()));
    const row = await mistralRow();
    // A hub model expands too, to say it isn't placed on any cluster.
    const tiny = (await screen.findByTestId('model-locations-tiny-llm')).closest('tr') as HTMLElement;
    expect(within(tiny).getByRole('button', { name: 'Details' })).toBeInTheDocument();

    expect(within(row).getByTestId('model-phase')).toHaveTextContent('Partially available');
    await user.click(within(row).getByRole('button', { name: 'Details' }));
    const works = screen.getAllByTestId('model-work-row');
    expect(works.map((w) => w.textContent)).toEqual([
      expect.stringContaining('San Francisco (site1)'),
      expect.stringContaining('New York (site2)'),
      expect.stringContaining('Brussels (site3)'),
    ]);
    // The cluster isn't a second line: a screen reader reads it with the location, and hovering the
    // location shows it.
    const location = within(works[0]).getByTestId('model-work-location');
    expect(location).toHaveTextContent('San Francisco (site1), cluster site1');
    await user.hover(location);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Cluster: site1');
    expect(works.map((w) => within(w).getByTestId('model-work-phase').textContent)).toEqual([
      'Ready at San Francisco (site1)',
      'Failed at New York (site2)',
      'Pending at Brussels (site3)',
    ]);
  });

  it('says how many clusters serve a partially available model, and shows its locations in its row', async () => {
    const user = userEvent.setup();
    renderAt('/models', serviceOnModelJson(partialFetch()));
    const row = await mistralRow();
    await user.hover(within(row).getByText('Partially available'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('1 of 3 clusters are serving the model.');
    expect(screen.queryByTestId('model-works-mistral-7b-instruct')).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Details' }));
    expect(await screen.findByTestId('model-works-mistral-7b-instruct')).toBeVisible();
  });

  it("opens a failed location's progress from what its cluster reported, and offers Edit deployment", async () => {
    const user = userEvent.setup();
    const service = serviceOnModelJson(partialFetch());
    renderAt('/models', service);
    await user.click(within(await mistralRow()).getByRole('button', { name: 'Details' }));
    await user.click(screen.getByRole('button', { name: 'Failed at New York (site2)' }));
    const modal = await screen.findByTestId('deployment-status-modal');
    expect(within(modal).getByRole('heading', { name: /Mistral 7B Instruct status/ })).toBeVisible();
    expect(modal).toHaveTextContent('New York (site2)');
    expect(modal).toHaveTextContent('on cluster site2');
    const applied = within(modal).getByTestId('deployment-step-applied');
    expect(applied).toHaveClass('pf-m-danger');
    expect(applied).toHaveTextContent('Failed to apply manifest work');
    expect(within(applied).getByText(/2026/)).toBeInTheDocument();
    // Unknown shows its message; steps the cluster never reported are pending, with no time.
    expect(within(modal).getByTestId('deployment-step-available')).toHaveTextContent(
      '1 of 2 resources have unknown status',
    );
    for (const id of ['workload', 'ready']) {
      const step = within(modal).getByTestId(`deployment-step-${id}`);
      expect(step).toHaveClass('pf-m-pending');
      expect(within(step).queryByText(/2026/)).not.toBeInTheDocument();
    }
    expect(within(modal).queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument();
    await user.click(within(modal).getByRole('button', { name: 'Edit deployment' }));
    expect(await screen.findByRole('heading', { name: /Edit/ })).toBeVisible();
  });

  it("keeps an open location's status current as the list refreshes, and closes it when the location goes", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const user = userEvent.setup();
      // What the next poll answers for site3: still starting, then serving, then gone.
      let site3: 'pending' | 'ready' | 'gone' = 'pending';
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        const data = partialJson();
        const mistral = data.find((m) => m.name === 'mistral-7b-instruct')!;
        const rollout = mistral.rollout as { works: { cluster: string; phase: string; feedback?: unknown }[] };
        if (site3 === 'gone') {
          rollout.works = rollout.works.filter((w) => w.cluster !== 'site3');
        } else if (site3 === 'ready') {
          Object.assign(
            rollout.works.find((w) => w.cluster === 'site3')!,
            { phase: 'ready', feedback: { ready: 'True' } },
          );
        }
        if (isOneModel(url, init)) {
          const name = decodeURIComponent(url.split('/').pop()!);
          return jsonResponse(200, { data: data.find((m) => m.name === name) });
        }
        return jsonResponse(200, { data });
      });
      renderAt('/models', serviceOnModelJson(fetchFn));
      await user.click(within(await mistralRow()).getByRole('button', { name: 'Details' }));
      await user.click(screen.getByRole('button', { name: 'Pending at Brussels (site3)' }));
      const modal = await screen.findByTestId('deployment-status-modal');
      expect(within(modal).getByRole('heading', { name: /status/ })).toHaveTextContent('Pending');

      site3 = 'ready';
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      await waitFor(() => expect(within(modal).getByRole('heading', { name: /status/ })).toHaveTextContent('Ready'));

      site3 = 'gone';
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      await waitFor(() => expect(screen.queryByTestId('deployment-status-modal')).not.toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a ready location with every step done, on the model page too', async () => {
    const user = userEvent.setup();
    const service = serviceOnModelJson(partialFetch());
    renderAt('/models/ai-grid-models/mistral-7b-instruct', service);
    // The details page lists the same locations, in its Locations section (model-locations, as
    // before the clusters reported: e2e/models.spec.ts reads it there).
    const table = await screen.findByTestId('model-works-mistral-7b-instruct');
    expect(screen.getByTestId('model-locations')).toContainElement(table);
    expect(screen.getByTestId('model-locations')).toHaveTextContent('site1');
    // The site name comes with the clusters, which answer after the model.
    await user.click(await within(table).findByRole('button', { name: 'Ready at San Francisco (site1)' }));
    const modal = await screen.findByTestId('deployment-status-modal');
    for (const id of ['applied', 'available', 'workload', 'ready']) {
      expect(within(modal).getByTestId(`deployment-step-${id}`)).toHaveClass('pf-m-success');
    }
    // The ready feedback carries no time of its own.
    expect(within(within(modal).getByTestId('deployment-step-ready')).queryByText(/2026/)).not.toBeInTheDocument();
  });
});

describe('the Models list expands every row', () => {
  /** The row of a model in the list, by its resource name. */
  const rowOf = async (name: string) =>
    (await screen.findByTestId(`model-locations-${name}`)).closest('tr') as HTMLElement;

  it('gives every row the expand toggle, named Details, collapsed until clicked', async () => {
    const user = userEvent.setup();
    const service = new MockConsoleService();
    renderAt('/models', service);
    for (const model of service.models) {
      const toggle = within(await rowOf(model.name)).getByRole('button', { name: 'Details' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }
    const toggle = within(await rowOf('llama-3-70b')).getByRole('button', { name: 'Details' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('expands a model without locations to say so, with Edit locations for a provider admin', async () => {
    const user = userEvent.setup();
    renderAt('/models', new MockConsoleService());
    await user.click(within(await rowOf('llama-3-70b')).getByRole('button', { name: 'Details' }));
    const empty = await screen.findByTestId('model-not-placed-llama-3-70b');
    expect(within(empty).getByRole('heading', { name: 'Not placed on any cluster yet' })).toBeVisible();
    expect(empty).toHaveTextContent('This model has no locations.');
    await user.click(within(empty).getByRole('button', { name: 'Edit locations' }));
    expect(await screen.findByRole('heading', { name: /^Edit / })).toBeVisible();
  });

  it("shows the placement's reason and message when the backend says it chose no cluster", async () => {
    const user = userEvent.setup();
    renderAt('/models', serviceOnBffExamples());
    await user.click(within(await rowOf('codellama-13b')).getByRole('button', { name: 'Details' }));
    expect(await screen.findByTestId('model-not-placed-codellama-13b')).toHaveTextContent(
      'NoManagedClusterMatched: No ManagedCluster matches any of the cluster predicate',
    );
  });

  it('lists the clusters a git-mode model was placed on, without calling it unplaced', async () => {
    const user = userEvent.setup();
    // As the real hub answers it: placed on site-b by name, the placement not reported satisfied,
    // and no works, because the backend saves the model to Git and Argo CD delivers it.
    const granite = getModels.body.data.find((m) => m.name === 'granite-8b-instruct')!;
    const placed = {
      ...granite,
      name: 'granite-4-tiny',
      phase: 'ready',
      placement: {
        matchExpressions: [{ key: 'name', operator: 'In', values: ['site-b'] }],
        selectedClusters: ['site-b'],
        locations: ['us-east'],
        satisfied: false,
        conditions: [],
      },
      rollout: { strategy: 'All', rolledOut: false, applied: false, conditions: [], works: [] },
    };
    const service = serviceOnModelJson(
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [placed] }), { headers: { 'Content-Type': 'application/json' } }),
      ),
    );
    const [cluster] = service.clusters;
    service.clusters = [{ ...cluster, name: 'site-b', location: 'us-east', siteName: undefined }];
    renderAt('/models', service);
    await user.click(within(await rowOf('granite-4-tiny')).getByRole('button', { name: 'Details' }));
    const selected = await screen.findByTestId('model-selected-clusters-granite-4-tiny');
    expect(selected).toHaveTextContent("Status per location isn't reported for this model yet.");
    expect(
      within(selected)
        .getAllByTestId('model-selected-cluster-row')
        .map((r) => r.textContent),
    ).toEqual(['us-east · site-b']);
    // The line above says it once; no Status column repeats it on every row.
    expect(within(selected).queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.queryByText('Not placed on any cluster yet')).not.toBeInTheDocument();
  });

  it('offers no Edit locations to a user the console could not load', async () => {
    const user = userEvent.setup();
    const service = new MockConsoleService();
    service.getUser = () => Promise.reject(new ServiceError(500, 'unavailable'));
    renderAt('/models', service);
    await user.click(within(await rowOf('llama-3-70b')).getByRole('button', { name: 'Details' }));
    const empty = await screen.findByTestId('model-not-placed-llama-3-70b');
    expect(within(empty).queryByRole('button', { name: 'Edit locations' })).not.toBeInTheDocument();
  });
});
