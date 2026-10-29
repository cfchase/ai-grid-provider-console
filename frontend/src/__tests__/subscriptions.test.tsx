// Ported from krisv/ai-grid-cloud-provider-poc src/app/__tests__/subscriptions.test.tsx at 62319b8.
// The pages read and write the backend's Subscriptions API over Connect; here it is
// connectSubscriptions.ts's in-memory fake, which answers as the backend's git mode does, with the
// models and organizations of a MockConsoleService.
// Rulings and scope:
// - "preserves user input on update conflict" is renamed "keeps input on conflict" (B8, D7).
// - The create case also picks an organization, which the console requires.
// - The PoC's failNext becomes a one-shot `before` hook on the fake.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { clone } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import { ServiceError } from '../api/ConsoleService';
import { MockConsoleService } from '../api/MockConsoleService';
import { ConditionStatus } from '../gen/ai_grid/v1/condition_type_pb';
import { SubscriptionSchema, type Subscription } from '../gen/ai_grid/v1/subscription_type_pb';
import { ANNOTATION_DISPLAY_NAME } from '../pages/subscriptions/subscriptionText';
import { serviceOnBffExamples } from './bffExamples';
import { ACME_ID, seedSubscriptions, SUBSCRIPTION_NAMESPACE, subscriptionsOf } from './connectSubscriptions';
import { deferred, renderAt } from './render';
// The routes load these pages lazily; loaded here, their import does not run inside a test's findBy.
import '../pages/subscriptions/CreateSubscriptionPage';
import '../pages/subscriptions/EditSubscriptionPage';
import '../pages/subscriptions/SubscriptionsPage';
import '../pages/subscriptions/ViewSubscriptionPage';
import { TestApp } from './TestApp';

/** A user the console couldn't load: the pages show, but without write actions. A viewer
 * (isProviderAdmin false) sees no pages at all (App.test.tsx). */
const unknownUser = () => {
  const service = new MockConsoleService();
  service.getUser = () => Promise.reject(new ServiceError(500, 'unavailable'));
  return service;
};

type User = ReturnType<typeof userEvent.setup>;

/** The stored subscription, as the fake backend has it. */
const stored = (service: MockConsoleService, id: string): Subscription =>
  subscriptionsOf(service).subscriptions.find((s) => s.id === id)!;

/** Replaces the fake's subscriptions (and drops its policies). */
const onlySubscriptions = (service: MockConsoleService, ...subscriptions: Subscription[]) => {
  const fake = subscriptionsOf(service);
  fake.subscriptions = subscriptions;
  fake.policies = [];
};

/** A copy of the engineering seed. */
const engineering = () => clone(SubscriptionSchema, seedSubscriptions()[0]);

/** Fails the method's next call with `error`. */
const failNext = (
  service: MockConsoleService,
  method: 'list' | 'get' | 'create' | 'update' | 'delete',
  error: Error,
) => {
  const fake = subscriptionsOf(service);
  fake.before[method] = () => {
    delete fake.before[method];
    throw error;
  };
};

/** Picks an organization in the create form's Organization select. */
const pickOrganization = async (user: User, name: string) => {
  await user.click(await screen.findByRole('combobox', { name: 'Organization' }));
  await user.click(screen.getByRole('option', { name }));
};

/** Fills the create form for "Test team" with one group and granite-3-8b at the default limit. */
const fillNewSubscription = async (user: User) => {
  const name = await screen.findByTestId('subscription-name-desc-name');
  await user.click(name);
  await user.paste('Test team');
  await user.click(screen.getByRole('combobox', { name: 'Enter groups' }));
  await user.paste('engineering');
  const option = await screen.findByRole('option', { name: 'Add group "engineering"' });
  await user.click(option.querySelector('button') ?? option);
  await user.keyboard('{Escape}');
  await user.click(screen.getByTestId('add-models-button'));
  await user.click(screen.getByTestId('toggle-model-granite-3-8b'));
  await user.click(screen.getByTestId('confirm-add-models'));
  await user.click(screen.getByTestId('add-token-limit-0'));
  await user.click(screen.getByTestId('save-rate-limits'));
};

describe('administrator subscription flows', () => {
  it('renders the list with its groups, filters and shows details', async () => {
    const user = userEvent.setup();
    renderAt('/subscriptions', new MockConsoleService());
    const table = await screen.findByTestId('subscriptions-table');
    expect(within(table).getByRole('link', { name: 'Engineering' })).toBeVisible();
    const row = within(table).getByRole('link', { name: 'Engineering' }).closest('tr')!;
    // The description sits under the name; groups and models are counts that expand the row.
    expect(within(row).getByTestId('subscription-description')).toHaveTextContent(
      'Production models for the engineering team.',
    );
    expect(within(row).getByTestId('subscription-groups')).toHaveTextContent('1');
    expect(within(row).getByTestId('subscription-models')).toHaveTextContent('1');
    await user.click(screen.getByTestId('subscriptions-filter-input').querySelector('input')!);
    await user.paste('production');
    expect(within(table).queryByRole('link', { name: 'Research' })).not.toBeInTheDocument();
    await user.click(within(table).getByRole('link', { name: 'Engineering' }));
    expect(await screen.findByRole('heading', { name: 'Engineering', level: 1 })).toBeVisible();
    // One view: no single "Details" tab, and no Name row repeating the title.
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    const details = screen.getByTestId('subscription-details-section');
    expect(details).not.toHaveTextContent(/^Name/);
    expect(within(details).getByTestId('subscription-priority')).toHaveTextContent('100');
    // The backend lists every policy covering one of its models, so the term says so; a policy's
    // phase reads as itself (Active), not as a subscription's Ready.
    const policies = within(details).getByTestId('subscription-auth-policies');
    expect(policies).toHaveTextContent('Engineering policy');
    expect(policies).toHaveTextContent('Active');
    expect(policies).not.toHaveTextContent('Ready');
    expect(within(details).getByText('Policies for its models')).toBeVisible();
    // The ref's limits, and its model's registration (model_registrations).
    expect(screen.getByTestId('subscription-models-table')).toHaveTextContent('100,000 / 1 hour');
    expect(screen.getByTestId('subscription-models-table')).toHaveTextContent('Ready');
  });

  it("expands a row's models, with their locations and token limits, or its groups, one at a time", async () => {
    const user = userEvent.setup();
    renderAt('/subscriptions', new MockConsoleService());
    const table = await screen.findByTestId('subscriptions-table');
    const row = within(table).getByRole('link', { name: 'Engineering' }).closest('tr')!;
    const modelsToggle = within(within(row).getByTestId('subscription-models')).getByRole('button', { name: '1' });
    expect(modelsToggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(modelsToggle);
    expect(modelsToggle).toHaveAttribute('aria-expanded', 'true');
    const models = screen.getByTestId('subscription-models-expanded-panel');
    const model = within(models).getByTestId('expanded-subscription-model-row');
    // The display name the backend joined to the ref (SubscriptionModelRef.display_name).
    expect(model).toHaveTextContent('Granite 3.3 8B Instruct');
    expect(model).toHaveTextContent('granite-3-8b');
    // Where the model's placement put it (its locations), named by its site as on the Models page,
    // and every limit on one line.
    expect(within(model).getByTestId('expanded-subscription-model-locations')).toHaveTextContent(
      'San Francisco (site1)',
    );
    expect(within(model).getByTestId('expanded-subscription-model-token-limits')).toHaveTextContent(
      '100,000 / 1 hour, 10,000 / 1 minute',
    );
    // The description is behind the help icon by the name.
    await user.click(within(model).getByRole('button', { name: 'About Granite 3.3 8B Instruct' }));
    expect(await screen.findByText('Enterprise language model')).toBeVisible();

    // Opening Groups closes Models.
    const groupsToggle = within(within(row).getByTestId('subscription-groups')).getByRole('button', { name: '1' });
    await user.click(groupsToggle);
    expect(groupsToggle).toHaveAttribute('aria-expanded', 'true');
    expect(modelsToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('subscription-models-expanded-panel')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('subscription-groups-expanded-panel')).getByRole('cell', { name: 'engineering' }),
    ).toBeVisible();

    await user.click(groupsToggle);
    expect(screen.queryByTestId('subscription-groups-expanded-panel')).not.toBeInTheDocument();
  });

  it('shows a ref the backend joined to no model without locations, and an unlimited model as Unlimited', async () => {
    const user = userEvent.setup();
    const service = new MockConsoleService();
    const seed = stored(service, 'engineering');
    seed.spec!.modelRefs = [
      { ...seed.spec!.modelRefs[0], unlimited: true, tokenRateLimits: [] },
      clone(SubscriptionSchema, seedSubscriptions()[2]).spec!.modelRefs[0],
    ];
    renderAt('/subscriptions', service);
    const table = await screen.findByTestId('subscriptions-table');
    const row = within(table).getByRole('link', { name: 'Engineering' }).closest('tr')!;
    await user.click(within(within(row).getByTestId('subscription-models')).getByRole('button', { name: '2' }));
    const [granite, retired] = within(screen.getByTestId('subscription-models-expanded-panel')).getAllByTestId(
      'expanded-subscription-model-row',
    );
    expect(within(granite).getByTestId('expanded-subscription-model-token-limits')).toHaveTextContent('Unlimited');
    expect(retired).toHaveTextContent('retired-llm');
    expect(within(retired).getByTestId('expanded-subscription-model-locations')).toHaveTextContent('—');
    expect(within(retired).queryByRole('button', { name: /^About/ })).not.toBeInTheDocument();
  });

  it('filters by model name, ID or description, and shows each filter as a label', async () => {
    const user = userEvent.setup();
    renderAt('/subscriptions', new MockConsoleService());
    const table = await screen.findByTestId('subscriptions-table');
    await user.click(screen.getByTestId('subscriptions-filter-attribute'));
    await user.click(await screen.findByRole('option', { name: 'Model' }));
    const input = screen.getByTestId('subscriptions-model-filter-input').querySelector('input')!;
    expect(input).toHaveAttribute('placeholder', 'Filter by model name, ID, or description');

    // By the model's description: only subscriptions with Llama remain.
    await user.click(input);
    await user.paste('general purpose');
    expect(within(table).getByRole('link', { name: 'Data science' })).toBeVisible();
    expect(within(table).queryByRole('link', { name: 'Engineering' })).not.toBeInTheDocument();
    // By the model's ID.
    await user.clear(input);
    await user.paste('granite-3-8b');
    expect(within(table).getByRole('link', { name: 'Engineering' })).toBeVisible();
    expect(within(table).queryByRole('link', { name: 'Research' })).not.toBeInTheDocument();

    // The model filter stays, as a label, while the search box filters by subscription.
    await user.click(screen.getByTestId('subscriptions-filter-attribute'));
    await user.click(await screen.findByRole('option', { name: 'Subscription' }));
    await user.click(screen.getByTestId('subscriptions-filter-input').querySelector('input')!);
    await user.paste('shared');
    expect(within(table).getByRole('link', { name: 'Data science' })).toBeVisible();
    expect(within(table).queryByRole('link', { name: 'Engineering' })).not.toBeInTheDocument();
    expect(screen.getByText('granite-3-8b')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(within(table).getByRole('link', { name: 'Research' })).toBeVisible();
  });

  it('filters by group name', async () => {
    const user = userEvent.setup();
    renderAt('/subscriptions', new MockConsoleService());
    const table = await screen.findByTestId('subscriptions-table');
    // The Subscription filter searches the name, ID or description.
    expect(screen.getByTestId('subscriptions-filter-input').querySelector('input')).toHaveAttribute(
      'placeholder',
      'Filter by name, ID, or description',
    );
    await user.click(screen.getByTestId('subscriptions-filter-attribute'));
    await user.click(await screen.findByRole('option', { name: 'Group' }));
    await user.click(screen.getByTestId('subscriptions-group-filter-input').querySelector('input')!);
    await user.paste('platform');
    expect(within(table).getByRole('link', { name: 'Data science' })).toBeVisible();
    expect(within(table).queryByRole('link', { name: 'Engineering' })).not.toBeInTheDocument();
  });

  it('names the row each count opens, for assistive technology', async () => {
    const user = userEvent.setup();
    renderAt('/subscriptions', new MockConsoleService());
    const table = await screen.findByTestId('subscriptions-table');
    const row = within(table).getByRole('link', { name: 'Engineering' }).closest('tr')!;
    for (const panel of ['groups', 'models']) {
      const toggle = within(within(row).getByTestId(`subscription-${panel}`)).getByRole('button');
      await user.click(toggle);
      const controlled = document.getElementById(toggle.getAttribute('aria-controls')!);
      expect(controlled).toContainElement(screen.getByTestId(`subscription-${panel}-expanded-panel`));
    }
  });

  it("names each row's actions menu after its subscription, as the other lists do", async () => {
    const user = userEvent.setup();
    const service = new MockConsoleService();
    stored(service, 'research').metadata!.deletionTimestamp = timestampFromDate(new Date('2026-10-27T10:00:00Z'));
    renderAt('/subscriptions', service);
    const table = await screen.findByTestId('subscriptions-table');
    const row = within(table).getByRole('link', { name: 'Engineering' }).closest('tr')!;
    const actions = within(row).getByRole('button', { name: 'Actions for Engineering' });
    expect(within(table).queryByRole('button', { name: 'Kebab toggle' })).not.toBeInTheDocument();
    await user.click(actions);
    expect(actions).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
    // A subscription being deleted can still be viewed; Edit and Delete stay, disabled.
    await user.keyboard('{Escape}');
    await user.click(within(table).getByRole('button', { name: 'Actions for Research' }));
    expect(screen.getByRole('menuitem', { name: 'View details' })).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps keyboard focus on the filter menu after choosing what to filter by', async () => {
    const user = userEvent.setup();
    renderAt('/subscriptions', new MockConsoleService());
    await screen.findByTestId('subscriptions-table');
    const menu = screen.getByTestId('subscriptions-filter-attribute');
    menu.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('option', { name: 'Model' });
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(menu).toHaveTextContent('Model');
    expect(menu).toHaveFocus();
  });

  it('says when the models are still loading, or could not be loaded', async () => {
    const user = userEvent.setup();
    const service = new MockConsoleService();
    let fail: (e: Error) => void = () => {};
    vi.spyOn(service, 'listModels').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    renderAt('/subscriptions', service);
    const table = await screen.findByTestId('subscriptions-table');
    const row = within(table).getByRole('link', { name: 'Engineering' }).closest('tr')!;
    await user.click(within(within(row).getByTestId('subscription-models')).getByRole('button'));
    expect(screen.getByTestId('expanded-subscription-model-locations')).toHaveTextContent('Loading locations');

    act(() => fail(new ServiceError(503, 'backend down')));
    expect(await screen.findByTestId('subscriptions-models-unavailable')).toHaveTextContent('Unable to load models');
    expect(screen.getByTestId('expanded-subscription-model-locations')).toHaveTextContent('Unavailable');
    // The ref's own name still filters.
    await user.click(screen.getByTestId('subscriptions-filter-attribute'));
    await user.click(await screen.findByRole('option', { name: 'Model' }));
    await user.click(screen.getByTestId('subscriptions-model-filter-input').querySelector('input')!);
    await user.paste('granite-3-8b');
    expect(within(table).getByRole('link', { name: 'Engineering' })).toBeVisible();
  });

  it('creates a subscription using the group and model selectors and token-limit modal', async () => {
    const service = new MockConsoleService();
    const user = userEvent.setup();
    renderAt('/subscriptions/create', service);
    await screen.findByTestId('subscription-name-desc-name');
    expect(screen.queryByTestId('subscription-create-auth-policy')).not.toBeInTheDocument();
    expect(screen.getByTestId('create-subscription-button')).toBeDisabled();
    await pickOrganization(user, 'acme-robotics');
    await user.click(screen.getByTestId('subscription-name-desc-name'));
    await user.paste('Test team');
    await user.click(screen.getByRole('combobox', { name: 'Enter groups' }));
    await user.paste('engineering');
    const option = await screen.findByRole('option', { name: 'Add group "engineering"' });
    await user.click(option.querySelector('button') ?? option);
    await user.keyboard('{Escape}');
    await user.click(screen.getByTestId('add-models-button'));
    const modelsTable = screen.getByTestId('add-models-table');
    expect(within(modelsTable).getByRole('columnheader', { name: /Model name/ })).toBeVisible();
    for (const heading of ['Project', 'Model ID', 'Subscriptions', 'Policies']) {
      expect(within(modelsTable).queryByRole('columnheader', { name: heading })).not.toBeInTheDocument();
    }
    await user.click(screen.getByTestId('toggle-model-granite-3-8b'));
    await user.click(screen.getByTestId('confirm-add-models'));
    expect(screen.getByTestId('create-subscription-button')).toBeDisabled();
    await user.click(screen.getByTestId('add-token-limit-0'));
    await user.click(screen.getByTestId('save-rate-limits'));
    await user.click(screen.getByTestId('create-subscription-button'));
    await screen.findByTestId('subscriptions-table');
    expect(await screen.findByRole('link', { name: 'Test team' })).toBeVisible();
    expect(await screen.findByText('Subscription created')).toBeVisible();
    // Subscriptions/Create: the id, the display name annotation, the organization, bare groups,
    // and the model by its id with no namespace (SubscriptionModelRef.model_id).
    const [{ object }] = subscriptionsOf(service).sent('create');
    expect(object).toMatchObject({
      id: 'test-team',
      metadata: { name: 'test-team', annotations: { [ANNOTATION_DISPLAY_NAME]: 'Test team' } },
      spec: {
        owner: { groups: ['engineering'] },
        organization: { id: ACME_ID },
        modelRefs: [{ name: 'granite-3-8b', namespace: '', tokenRateLimits: [{ limit: 1000n, window: '1h' }] }],
      },
    });
    expect(subscriptionsOf(service).policies.some((p) => p.id === 'test-team-policy')).toBe(true);
    // Before a cluster reports, a subscription has no phase.
    expect(stored(service, 'test-team').status).toBeUndefined();
  });

  it('edits without losing billing or metering configuration', async () => {
    const service = new MockConsoleService();
    const user = userEvent.setup();
    renderAt('/subscriptions/edit/engineering', service);
    const name = await screen.findByTestId('subscription-name-desc-name');
    expect(screen.queryByTestId('subscription-create-auth-policy')).not.toBeInTheDocument();
    await user.clear(name);
    await user.paste('Engineering updated');
    await user.click(screen.getByTestId('update-subscription-button'));
    expect(await screen.findByRole('link', { name: 'Engineering updated' })).toBeVisible();
    const saved = stored(service, 'engineering');
    expect(saved.spec?.modelRefs[0].billingRate?.perToken).toBe('0.000002');
    expect(saved.spec?.tokenMetadata?.costCenter).toBe('engineering');
    expect(saved.spec?.organization?.id).toBe(ACME_ID);
  });

  it('writes the whole spec and annotations it loaded, at the version it read', async () => {
    const service = new MockConsoleService();
    stored(service, 'engineering').metadata!.annotations.team = 'platform';
    const user = userEvent.setup();
    renderAt('/subscriptions/edit/engineering', service);
    const description = await screen.findByTestId('subscription-name-desc-description');
    await user.clear(description);
    await user.paste('Changed');
    await user.click(screen.getByTestId('update-subscription-button'));
    await screen.findByTestId('subscriptions-table');
    // An Update replaces a map whole (FieldMask), so the map goes back with the change in it.
    const [request] = subscriptionsOf(service).sent('update');
    expect(request.updateMask?.paths).toEqual(['spec', 'metadata.annotations']);
    expect(request.lock).toBe(true);
    expect(request.object?.metadata?.version).toBe(1);
    expect(request.object?.metadata?.annotations).toEqual({
      [ANNOTATION_DISPLAY_NAME]: 'Engineering',
      'openshift.io/description': 'Changed',
      team: 'platform',
    });
    expect(stored(service, 'engineering').metadata?.version).toBe(2);
  });

  it('requires typed confirmation and retains the dialog on delete failure', async () => {
    const service = new MockConsoleService();
    const user = userEvent.setup();
    renderAt('/subscriptions/view/engineering', service);
    await screen.findByTestId('subscription-details-section');
    await user.click(screen.getByTestId('subscription-actions-toggle'));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const modal = await screen.findByTestId('delete-subscription-modal');
    expect(within(modal).getByRole('button', { name: 'Delete' })).toBeDisabled();
    await user.click(screen.getByTestId('delete-modal-input'));
    await user.paste('Engineering');
    failNext(service, 'delete', new ConnectError('Permission denied.', Code.PermissionDenied));
    await user.click(within(modal).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByTestId('delete-model-error-message-alert')).toHaveTextContent('Permission denied.');
    expect(stored(service, 'engineering')).toBeDefined();
    await user.click(within(modal).getByRole('button', { name: 'Delete' }));
    await screen.findByTestId('subscriptions-table');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Engineering' })).not.toBeInTheDocument());
    expect(await screen.findByText('Subscription deleted')).toBeVisible();
    // The delete sends the version read (zero would skip the backend's check).
    expect(subscriptionsOf(service).sent('delete').at(-1)).toMatchObject({ id: 'engineering', resourceVersion: 1 });
  });

  it('edits an unlimited model without dropping controller-specific fields', async () => {
    const seed = engineering();
    seed.spec!.owner!.users = ['alice'];
    seed.spec!.inferencePriority = -5;
    seed.spec!.guardrails = [{ $typeName: 'ai_grid.v1.GuardrailAttachment', refName: 'safety', checks: [] }];
    seed.spec!.modelRefs[0].unlimited = true;
    seed.spec!.modelRefs[0].tokenRateLimits = [];
    seed.spec!.modelRefs[0].guardrails = [
      { $typeName: 'ai_grid.v1.GuardrailAttachment', refName: 'model-safety', checks: [] },
    ];
    const service = new MockConsoleService();
    onlySubscriptions(service, seed);
    const user = userEvent.setup();
    renderAt('/subscriptions/edit/engineering', service);
    const description = await screen.findByTestId('subscription-name-desc-description');
    expect(screen.getByTestId('subscription-models-table')).toHaveTextContent('Unlimited');
    await user.clear(description);
    await user.paste('Changed description');
    await user.click(screen.getByTestId('update-subscription-button'));
    await screen.findByTestId('subscriptions-table');
    const saved = stored(service, 'engineering').spec!;
    expect(saved.owner?.users).toEqual(['alice']);
    expect(saved.inferencePriority).toBe(-5);
    expect(saved.guardrails.map((g) => g.refName)).toEqual(['safety']);
    expect(saved.modelRefs[0]).toMatchObject({ unlimited: true, tokenRateLimits: [] });
    expect(saved.modelRefs[0].guardrails.map((g) => g.refName)).toEqual(['model-safety']);
  });

  it('keeps the list under a warning when a reload fails', async () => {
    const service = new MockConsoleService();
    const user = userEvent.setup();
    renderAt('/subscriptions', service);
    expect(await screen.findByRole('link', { name: 'Engineering' })).toBeVisible();
    subscriptionsOf(service).before.list = () => {
      throw new ConnectError('Service unavailable.', Code.Unavailable);
    };
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByTestId('stale-data-alert')).toHaveTextContent(
      'Showing the last loaded subscriptionsthe AI Grid backend is unavailable; try again',
    );
    expect(screen.getByRole('link', { name: 'Engineering' })).toBeVisible();
  });

  it('renders load failures and allows retry', async () => {
    const service = new MockConsoleService();
    failNext(service, 'list', new ConnectError('stored subscription is broken', Code.Internal));
    const user = userEvent.setup();
    renderAt('/subscriptions', service);
    expect(await screen.findByRole('heading', { name: 'Unable to load subscriptions' })).toBeVisible();
    // A server-side failure shows the console's words, not the backend's (describeError).
    expect(screen.getByTestId('error-state')).toHaveTextContent('the AI Grid backend failed to process the request');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('subscriptions-table')).toBeVisible();
  });

  it('keeps input on conflict', async () => {
    const service = new MockConsoleService();
    const user = userEvent.setup();
    renderAt('/subscriptions/edit/engineering', service);
    const description = await screen.findByTestId('subscription-name-desc-description');
    await user.clear(description);
    await user.paste('Unsaved description');
    // Someone else saves it meanwhile.
    stored(service, 'engineering').metadata!.version = 2;
    await user.click(screen.getByTestId('update-subscription-button'));
    expect(
      await screen.findByText(
        'update Subscription "engineering": the subscription changed since it was read; reload and retry',
      ),
    ).toBeVisible();
    expect(description).toHaveValue('Unsaved description');
    expect(stored(service, 'engineering').metadata?.annotations['openshift.io/description']).toBe(
      'Production models for the engineering team.',
    );
  });
});

it('requires an organization and shows it in the table', async () => {
  const service = new MockConsoleService();
  stored(service, 'data-science').spec!.organization = {
    $typeName: 'ai_grid.v1.SubscriptionOrganization',
    id: 'retired-org',
  };
  const user = userEvent.setup();
  renderAt('/subscriptions/create', service);
  await fillNewSubscription(user);
  const create = screen.getByTestId('create-subscription-button');
  expect(create).toBeDisabled();
  // Tabbing past the empty select says why Create is disabled.
  const organization = screen.getByRole('combobox', { name: 'Organization' });
  expect(screen.queryByText('Select an organization')).not.toBeInTheDocument();
  organization.focus();
  await user.tab();
  expect(organization).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('Select an organization')).toBeVisible();
  await pickOrganization(user, 'globex-research');
  expect(organization).toHaveAttribute('aria-invalid', 'false');
  expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue('globex-research');
  expect(create).toBeEnabled();
  await user.click(create);

  const table = await screen.findByTestId('subscriptions-table');
  const rowOf = async (name: string) => (await within(table).findByRole('link', { name })).closest('tr')!;
  expect(within(table).getByRole('columnheader', { name: /Organization/ })).toBeVisible();
  expect(await rowOf('Test team')).toHaveTextContent('globex-research');
  expect(await rowOf('Engineering')).toHaveTextContent('acme-robotics');
  // An organization the backend doesn't list shows its raw id.
  expect(await rowOf('Data science')).toHaveTextContent('retired-org');
  expect(stored(service, 'test-team').spec?.organization?.id).toBe('8d2e7b31-0c4f-4a9d-b5e6-7f8a9b0c1d2e');
});

it('hides write actions until it knows the user is a provider admin', async () => {
  const service = unknownUser();
  const { unmount } = renderAt('/subscriptions', service);
  await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('User could not be loaded'));
  const table = await screen.findByTestId('subscriptions-table');
  expect(within(table).getByRole('link', { name: 'Engineering' })).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Create subscription' })).not.toBeInTheDocument();
  // No row menu, as on the other lists: a viewer opens a subscription from its name.
  expect(within(table).queryByRole('button', { name: 'Actions for Engineering' })).not.toBeInTheDocument();
  expect(within(table).queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
  unmount();

  renderAt('/subscriptions/view/engineering', service);
  await screen.findByTestId('subscription-details-section');
  await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('User could not be loaded'));
  expect(screen.queryByTestId('subscription-actions-toggle')).not.toBeInTheDocument();
});

it('shows the not-available state when the backend has no subscriptions yet', async () => {
  const service = new MockConsoleService();
  failNext(service, 'list', new ConnectError('unimplemented', Code.Unimplemented));
  renderAt('/subscriptions', service);
  expect(await screen.findByText('Subscriptions are not available on this backend yet')).toBeVisible();
  expect(screen.queryByTestId('subscriptions-table')).not.toBeInTheDocument();
});

it('says creating is not available on a backend without subscriptions', async () => {
  const service = new MockConsoleService();
  failNext(service, 'create', new ConnectError('unimplemented', Code.Unimplemented));
  const user = userEvent.setup();
  renderAt('/subscriptions/create', service);
  await fillNewSubscription(user);
  await pickOrganization(user, 'acme-robotics');
  await user.click(screen.getByTestId('create-subscription-button'));
  expect(await screen.findByText('Creating subscriptions is not available on this backend yet.')).toBeVisible();
  expect(screen.getByText('Unable to create subscription')).toBeVisible();
});

it('shows one pagination, in the toolbar, for a single page', async () => {
  renderAt('/subscriptions', new MockConsoleService());
  expect(await screen.findByTestId('subscriptions-table')).toBeVisible();
  expect(screen.getAllByRole('navigation', { name: /pagination/i })).toHaveLength(1);
});

describe('a failed background poll', () => {
  // Only the 30-second polls are faked; user-event and findBy keep real timeouts.
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  it.each([
    ['/subscriptions/create', 'subscription-name-desc-name'],
    ['/subscriptions/edit/engineering', 'subscription-name-desc-description'],
  ])('keeps the input on %s', async (path, testId) => {
    const service = new MockConsoleService();
    const user = userEvent.setup();
    renderAt(path, service);
    const field = await screen.findByTestId(testId);
    await user.clear(field);
    await user.paste('Unsaved input');
    const failed = vi.fn(async () => {
      throw new ServiceError(503, 'Service unavailable.');
    });
    service.listModels = failed;
    service.listOrganizations = failed;
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    await waitFor(() => expect(failed).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText('Unable to load subscriptions')).not.toBeInTheDocument();
    expect(screen.queryByText('Unable to load subscription')).not.toBeInTheDocument();
    expect(screen.getByTestId(testId)).toHaveValue('Unsaved input');
  });
});

/** A copy of the engineering seed named `name`, with the phase and Ready condition the backend reports. */
const withPhase = (
  name: string,
  phase: string,
  ready?: { status: ConditionStatus; reason: string; message?: string },
): Subscription => {
  const sub = engineering();
  sub.id = name;
  sub.metadata!.name = name;
  sub.metadata!.annotations[ANNOTATION_DISPLAY_NAME] = name;
  sub.status = {
    $typeName: 'ai_grid.v1.SubscriptionStatus',
    phase,
    conditions: ready ? [{ $typeName: 'ai_grid.v1.Condition', type: 'Ready', observedGeneration: 0n, ...ready }] : [],
    modelRefStatuses: [],
    tokenRateLimitStatuses: [],
  };
  return sub;
};

describe('subscription phases', () => {
  it('shows the phases as the backend reports them', async () => {
    const service = new MockConsoleService();
    onlySubscriptions(
      service,
      withPhase('unreported-sub', ''),
      withPhase('pending-sub', 'Pending'),
      withPhase('active-sub', 'Active'),
      // A phase git mode doesn't report reads as it is.
      withPhase('degraded-sub', 'Degraded', { status: ConditionStatus.FALSE, reason: 'PartialFailure' }),
    );
    renderAt('/subscriptions', service);
    const table = await screen.findByTestId('subscriptions-table');
    const label = (name: string) =>
      within(within(table).getByRole('link', { name }).closest('tr')!).getByTestId('phase-label');
    // No phase yet (no cluster has reported) reads Unknown, as in odh-dashboard's MaaS screens.
    expect(label('unreported-sub')).toHaveTextContent('Unknown');
    expect(label('pending-sub')).toHaveTextContent('Pending');
    // Active, as its policy's phase reads beside it. Every status is an outline label that opens nothing.
    expect(label('active-sub')).toHaveTextContent('Active');
    expect(label('degraded-sub')).toHaveTextContent('Degraded');
    for (const name of ['active-sub', 'degraded-sub']) {
      expect(label(name)).toHaveClass('pf-m-outline');
      expect(within(label(name)).queryByRole('button')).not.toBeInTheDocument();
    }
  });

  it("shows a subscription's Ready message under a Degraded label", async () => {
    const message = '1 of 1 TokenRateLimitPolicies not accepted';
    const service = new MockConsoleService();
    onlySubscriptions(
      service,
      withPhase('degraded-sub', 'Degraded', { status: ConditionStatus.FALSE, reason: 'PartialFailure', message }),
    );
    const user = userEvent.setup();
    renderAt('/subscriptions', service);
    expect(await screen.findByTestId('phase-label-subtext')).toHaveTextContent(message);
    // The condition's message is the label's tooltip too.
    await user.hover(within(screen.getByTestId('phase-label')).getByText('Degraded'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(message);
  });
});

it('shows Saved to Git, not Pending, for a model no cluster has reported', async () => {
  const service = new MockConsoleService();
  // Without a report the backend's registration has no phase and a Ready condition of reason
  // SavedToGit (gitModelRegistrations).
  subscriptionsOf(service).registrations = [];
  renderAt('/subscriptions/view/engineering', service);
  const models = await screen.findByTestId('subscription-models-table');
  expect(models).toHaveTextContent('Saved to Git');
  expect(models).not.toHaveTextContent('Pending');
});

it("shows a policy's Ready message on its status label", async () => {
  const user = userEvent.setup();
  renderAt('/subscriptions/view/engineering', new MockConsoleService());
  const policies = await screen.findByTestId('subscription-auth-policies');
  const active = within(policies).getByText('Active');
  await user.hover(active);
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Ready on site1');
  expect(active.closest('[aria-describedby]')).toHaveAccessibleDescription('Ready on site1');
});

describe("model refs on the BFF's example models", () => {
  it('offers the example models and sends the picked model by its id', async () => {
    const service = serviceOnBffExamples();
    const user = userEvent.setup();
    renderAt('/subscriptions/create', service);
    await pickOrganization(user, 'acme-robotics');
    await user.click(screen.getByTestId('subscription-name-desc-name'));
    await user.paste('Test team');
    await user.click(screen.getByRole('combobox', { name: 'Enter groups' }));
    await user.paste('engineering');
    const option = await screen.findByRole('option', { name: 'Add group "engineering"' });
    await user.click(option.querySelector('button') ?? option);
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('no-models-warning')).not.toBeInTheDocument();
    await user.click(await screen.findByTestId('add-models-button'));
    await user.click(screen.getByTestId('toggle-model-granite-8b-instruct'));
    await user.click(screen.getByTestId('confirm-add-models'));
    await user.click(screen.getByTestId('add-token-limit-0'));
    await user.click(screen.getByTestId('save-rate-limits'));
    await user.click(screen.getByTestId('create-subscription-button'));
    await waitFor(() => expect(subscriptionsOf(service).sent('create')).toHaveLength(1));
    expect(subscriptionsOf(service).sent('create')[0].object?.spec?.modelRefs).toEqual([
      expect.objectContaining({
        name: 'granite-8b-instruct',
        namespace: '',
        tokenRateLimits: [expect.objectContaining({ limit: 1000n, window: '1h' })],
      }),
    ]);
  });
});

it('joins a ref to its model by model_id, not by its name', async () => {
  const service = new MockConsoleService();
  const seed = engineering();
  // A MaaSModelRef in another namespace that the Models API didn't write: the backend joins it to
  // no model, however it is named.
  seed.spec!.modelRefs[0].namespace = 'team-models';
  onlySubscriptions(service, seed);
  const user = userEvent.setup();
  renderAt(`/subscriptions/edit/${seed.id}`, service);
  const models = await screen.findByTestId('subscription-models-table');
  expect(models).not.toHaveTextContent('Granite 3.3 8B Instruct');
  expect(models).toHaveTextContent('Not found');
  await user.click(screen.getByTestId('add-models-button'));
  expect(screen.getByRole('checkbox', { name: 'Select Granite 3.3 8B Instruct' })).not.toBeChecked();
  await user.keyboard('{Escape}');
  // An unchanged edit can't be saved; change something besides the models.
  await user.click(screen.getByTestId('subscription-name-desc-description'));
  await user.paste(' (edited)');
  await user.click(screen.getByTestId('update-subscription-button'));
  await waitFor(() => expect(subscriptionsOf(service).sent('update')).toHaveLength(1));
  // The ref goes back as loaded.
  expect(subscriptionsOf(service).sent('update')[0].object?.spec?.modelRefs).toEqual([
    expect.objectContaining({ name: 'granite-3-8b', namespace: 'team-models' }),
  ]);
});

it('sends a re-added unlimited model with its new limits only', async () => {
  const seed = engineering();
  seed.spec!.modelRefs[0].unlimited = true;
  seed.spec!.modelRefs[0].tokenRateLimits = [];
  const service = new MockConsoleService();
  onlySubscriptions(service, seed);
  const user = userEvent.setup();
  renderAt('/subscriptions/edit/engineering', service);
  const models = await screen.findByTestId('subscription-models-table');
  await user.click(within(models).getByRole('button', { name: /^Remove / }));
  await user.click(screen.getByTestId('add-models-button'));
  await user.click(screen.getByTestId('toggle-model-granite-3-8b'));
  await user.click(screen.getByTestId('confirm-add-models'));
  await user.click(screen.getByTestId('add-token-limit-0'));
  await user.click(screen.getByTestId('save-rate-limits'));
  await user.click(screen.getByTestId('update-subscription-button'));
  await waitFor(() => expect(subscriptionsOf(service).sent('update')).toHaveLength(1));
  const [ref] = subscriptionsOf(service).sent('update')[0].object?.spec?.modelRefs ?? [];
  expect(ref).toMatchObject({ name: 'granite-3-8b', namespace: '', unlimited: false });
  expect(ref?.tokenRateLimits).toEqual([expect.objectContaining({ limit: 1000n, window: '1h' })]);
  await screen.findByTestId('subscriptions-table');
});

it('leaves the create form out of history once the subscription is created, so Back skips it', async () => {
  let navigate: NavigateFunction = () => undefined;
  const Navigator = () => {
    navigate = useNavigate();
    return null;
  };
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/clusters', '/subscriptions/create']} initialIndex={1}>
      <Navigator />
      <TestApp service={new MockConsoleService()} />
    </MemoryRouter>,
  );
  await pickOrganization(user, 'acme-robotics');
  await fillNewSubscription(user);
  await user.click(screen.getByTestId('create-subscription-button'));
  expect(await screen.findByText('Subscription created')).toBeVisible();
  await act(async () => navigate(-1));
  expect(await screen.findByRole('heading', { level: 1, name: 'Clusters' })).toBeVisible();
});

it.each(['view', 'edit'])('loads the other subscription when the name in /subscriptions/%s changes', async (page) => {
  let navigate: NavigateFunction = () => undefined;
  const Navigator = () => {
    navigate = useNavigate();
    return null;
  };
  render(
    <MemoryRouter initialEntries={[`/subscriptions/${page}/engineering`]}>
      <Navigator />
      <TestApp service={new MockConsoleService()} />
    </MemoryRouter>,
  );
  const shows = (name: string) =>
    waitFor(() =>
      page === 'edit'
        ? expect(screen.getByTestId('subscription-name-desc-name')).toHaveValue(name)
        : expect(screen.getByTestId('subscription-details-section')).toHaveTextContent(name),
    );
  await shows('Engineering');
  await act(async () => navigate(`/subscriptions/${page}/data-science`));
  await shows('Data science');
});

it('hints that a new model needs a token limit, and labels the limit fields', async () => {
  const user = userEvent.setup();
  renderAt('/subscriptions/create', new MockConsoleService());
  expect(await screen.findByText(/^Give groups of an organization's users access to models/)).toBeVisible();
  await user.click(await screen.findByTestId('add-models-button'));
  await user.click(screen.getByTestId('toggle-model-granite-3-8b'));
  await user.click(screen.getByTestId('confirm-add-models'));
  // A hint, not an error, before the user has done anything with the model.
  const hint = screen.getByTestId('token-limit-required-0');
  expect(hint).toHaveTextContent('Required: add at least one.');
  expect(hint).not.toHaveClass('pf-m-error');
  await user.click(screen.getByTestId('add-token-limit-0'));
  expect(screen.getByRole('dialog', { name: 'Edit token limits' })).toHaveTextContent(
    /^Edit token limitsLimit how many tokens each member of this subscription can use with/,
  );
  expect(screen.getByRole('spinbutton', { name: 'Tokens' })).toHaveValue(1000);
  expect(screen.getByRole('spinbutton', { name: 'Per' })).toHaveValue(1);
  expect(screen.getByRole('button', { name: 'Add token limit' })).toBeVisible();
});

it('says straight away that a subscription saved without an organization needs one', async () => {
  const service = new MockConsoleService();
  renderAt('/subscriptions/edit/data-science', service);
  const organization = await screen.findByRole('combobox', { name: 'Organization' });
  expect(organization).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('Select an organization')).toBeVisible();
});

it('keeps a set organization read-only when editing', async () => {
  renderAt('/subscriptions/edit/engineering', new MockConsoleService());
  const organization = await screen.findByTestId('subscription-organization');
  expect(organization).toHaveAttribute('readonly');
  // Its name, once Tenants/List has answered.
  await waitFor(() => expect(organization).toHaveValue('acme-robotics'));
  expect(screen.getByText('The organization can’t be changed once it is set.')).toBeVisible();
});

it('shows Not found for a referenced model the backend has no registration for', async () => {
  const service = new MockConsoleService();
  const seed = engineering();
  seed.spec!.modelRefs[0].name = 'gone';
  seed.spec!.modelRefs[0].namespace = SUBSCRIPTION_NAMESPACE;
  onlySubscriptions(service, seed);
  renderAt(`/subscriptions/view/${seed.id}`, service);
  expect(await screen.findByTestId('subscription-models-table')).toHaveTextContent('Not found');
});

it('reloads a subscription after a stale delete, keeping the typed name, so a retry succeeds', async () => {
  const service = new MockConsoleService();
  const user = userEvent.setup();
  renderAt('/subscriptions/view/engineering', service);
  await screen.findByTestId('subscription-details-section');
  await user.click(screen.getByTestId('subscription-actions-toggle'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const modal = await screen.findByTestId('delete-subscription-modal');
  await user.click(within(modal).getByTestId('delete-modal-input'));
  await user.paste('Engineering');
  // Someone else saves the subscription while the dialog is open.
  stored(service, 'engineering').metadata!.version += 1;
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  expect(
    await within(modal).findByText('This subscription changed since you opened this dialog. Check it and try again.'),
  ).toBeVisible();
  expect(within(modal).getByTestId('delete-modal-input')).toHaveValue('Engineering');
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('Subscription deleted')).toBeVisible();
  expect(subscriptionsOf(service).subscriptions.some((s) => s.id === 'engineering')).toBe(false);
});

it('keeps the delete dialog busy until the reloaded version is in, and says when the reload fails', async () => {
  const service = new MockConsoleService();
  const fake = subscriptionsOf(service);
  const user = userEvent.setup();
  renderAt('/subscriptions/view/engineering', service);
  await screen.findByTestId('subscription-details-section');
  await user.click(screen.getByTestId('subscription-actions-toggle'));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  const modal = await screen.findByTestId('delete-subscription-modal');
  await user.click(within(modal).getByTestId('delete-modal-input'));
  await user.paste('Engineering');
  stored(service, 'engineering').metadata!.version += 1;
  const reload = deferred<void>();
  const getCalls = () => fake.sent('get').length;
  const before = getCalls();
  fake.before.get = () => reload.promise;
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(getCalls()).toBe(before + 1));
  // The reload is still out: Delete stays busy, so no retry with the stale version.
  expect(within(modal).getByRole('button', { name: /Delete/ })).toBeDisabled();
  await user.type(within(modal).getByTestId('delete-modal-input'), '{Enter}');
  expect(fake.sent('delete')).toHaveLength(1);
  await act(async () => reload.resolve());
  expect(within(modal).getByRole('button', { name: 'Delete' })).toBeEnabled();

  // A second stale delete whose reload fails says so.
  stored(service, 'engineering').metadata!.version += 1;
  fake.before.get = () => {
    throw new ConnectError('down', Code.Unavailable);
  };
  await user.click(within(modal).getByRole('button', { name: 'Delete' }));
  expect(
    await within(modal).findByText(/could not be loaded again: the AI Grid backend is unavailable; try again/),
  ).toBeVisible();
  expect(within(modal).getByRole('button', { name: 'Delete' })).toBeEnabled();
});

it('asks before Cancel discards the subscription form’s input', async () => {
  const user = userEvent.setup();
  renderAt('/subscriptions/create', new MockConsoleService());
  // Nothing typed yet: Cancel leaves at once.
  await user.click(await screen.findByTestId('cancel-subscription-button'));
  expect(await screen.findByTestId('subscriptions-table')).toBeVisible();
  await user.click(screen.getByRole('link', { name: 'Create subscription' }));
  await user.click(await screen.findByTestId('subscription-name-desc-name'));
  await user.paste('Test team');
  await user.click(screen.getByTestId('cancel-subscription-button'));
  const discard = await screen.findByTestId('discard-changes-modal');
  await user.click(within(discard).getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByTestId('subscription-name-desc-name')).toHaveValue('Test team');
  await user.click(screen.getByTestId('cancel-subscription-button'));
  await user.click(within(await screen.findByTestId('discard-changes-modal')).getByRole('button', { name: 'Discard' }));
  expect(await screen.findByTestId('subscriptions-table')).toBeVisible();
});

it('shows a window the form cannot read as it is, and saves it only once a new time is entered', async () => {
  const seed = engineering();
  seed.spec!.modelRefs[0].tokenRateLimits = [
    { $typeName: 'ai_grid.v1.TokenRateLimit', limit: 5000n, window: '1h' },
    { $typeName: 'ai_grid.v1.TokenRateLimit', limit: 100n, window: '2d' },
  ];
  const service = new MockConsoleService();
  onlySubscriptions(service, seed);
  const user = userEvent.setup();
  renderAt(`/subscriptions/edit/${seed.id}`, service);
  const models = await screen.findByTestId('subscription-models-table');
  await user.click(within(models).getByRole('button', { name: /^5,000 \/ 1 hour\s*100 \/ 2d$/ }));
  const dialog = screen.getByRole('dialog', { name: 'Edit token limits' });
  const readable = within(dialog).getByTestId('edit-token-limit-0');
  const unreadable = within(dialog).getByTestId('edit-token-limit-1');
  const message = 'Saved as "2d", which MaaS doesn\'t accept. Enter a time from 1 to 9999.';
  // From the moment the dialog opens, the row with "2d" warns, with its time empty; the other row says nothing.
  expect(within(readable).getByRole('spinbutton', { name: 'Per' })).toHaveValue(1);
  expect(within(readable).getByTestId('edit-token-limit-0-helper-text')).toHaveTextContent(/^$/);
  const time = within(unreadable).getByRole('spinbutton', { name: 'Per' });
  expect(time).toHaveValue(null);
  expect(time).not.toBeInvalid();
  expect(within(unreadable).getByTestId('edit-token-limit-1-helper-text')).toHaveTextContent(
    `${message}: warning status;`,
    { normalizeWhitespace: false },
  );
  // Save turns the same message into the time's error.
  await user.click(within(dialog).getByTestId('save-rate-limits'));
  expect(dialog).toBeInTheDocument();
  expect(time).toBeInvalid();
  expect(within(unreadable).getByTestId('edit-token-limit-1-helper-text')).toHaveTextContent(
    `${message}: error status;`,
    { normalizeWhitespace: false },
  );
  expect(within(readable).getByTestId('edit-token-limit-0-helper-text')).toHaveTextContent(/^$/);
  // A valid time clears it.
  await user.type(time, '48');
  expect(time).not.toBeInvalid();
  expect(within(unreadable).getByTestId('edit-token-limit-1-helper-text')).toHaveTextContent(/^$/);
  await user.click(within(dialog).getByTestId('save-rate-limits'));
  expect(dialog).not.toBeInTheDocument();
  await user.click(screen.getByTestId('update-subscription-button'));
  await waitFor(() => expect(subscriptionsOf(service).sent('update')).toHaveLength(1));
  expect(subscriptionsOf(service).sent('update')[0].object?.spec?.modelRefs?.[0].tokenRateLimits).toEqual([
    expect.objectContaining({ limit: 5000n, window: '1h' }),
    expect.objectContaining({ limit: 100n, window: '48h' }),
  ]);
});

it('refuses a token limit window over 8784 hours as it is typed, and takes 8784', async () => {
  const user = userEvent.setup();
  renderAt('/subscriptions/create', new MockConsoleService());
  await user.click(await screen.findByTestId('add-models-button'));
  await user.click(screen.getByTestId('toggle-model-granite-3-8b'));
  await user.click(screen.getByTestId('confirm-add-models'));
  await user.click(screen.getByTestId('add-token-limit-0'));
  const dialog = screen.getByRole('dialog', { name: 'Edit token limits' });
  const row = within(dialog).getByTestId('edit-token-limit-0');
  const time = within(row).getByRole('spinbutton', { name: 'Per' });
  await user.clear(time);
  await user.type(time, '8785');
  expect(time).toBeInvalid();
  expect(within(row).getByTestId('edit-token-limit-0-helper-text')).toHaveTextContent(
    'At most 8784 hours (366 days): error status;',
    { normalizeWhitespace: false },
  );
  expect(within(dialog).getByTestId('save-rate-limits')).toBeDisabled();
  await user.type(time, '{Backspace}4');
  expect(time).not.toBeInvalid();
  expect(within(row).getByTestId('edit-token-limit-0-helper-text')).toHaveTextContent(/^$/);
  await user.click(within(dialog).getByTestId('save-rate-limits'));
  expect(dialog).not.toBeInTheDocument();
  expect(screen.getByTestId('subscription-models-table')).toHaveTextContent('1,000 / 8,784 hours');
});

it('keeps Save disabled on an edit until something changes', async () => {
  const user = userEvent.setup();
  renderAt('/subscriptions/edit/engineering', new MockConsoleService());
  const description = await screen.findByTestId('subscription-name-desc-description');
  const save = screen.getByTestId('update-subscription-button');
  expect(save).toBeDisabled();
  // An unchanged form leaves without asking.
  await user.click(description);
  await user.paste(' more');
  expect(save).toBeEnabled();
  await user.type(description, '{Backspace>5}');
  expect(save).toBeDisabled();
  await user.click(screen.getByTestId('cancel-subscription-button'));
  expect(screen.queryByTestId('discard-changes-modal')).not.toBeInTheDocument();
});

it('names the priority buttons and the groups menu for what they change', async () => {
  renderAt('/subscriptions/create', new MockConsoleService());
  await screen.findByTestId('subscription-name-desc-name');
  expect(screen.getByRole('button', { name: 'Decrease priority' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Increase priority' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Groups options' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Organization options' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Menu toggle' })).not.toBeInTheDocument();
});

it('caps a new subscription id at the backend maximum, leaving room for -policy', async () => {
  const user = userEvent.setup();
  renderAt('/subscriptions/create', new MockConsoleService());
  await user.click(await screen.findByTestId('subscription-name-desc-name'));
  await user.paste('a'.repeat(70));
  await user.click(screen.getByTestId('subscription-name-desc-editResourceLink'));
  expect(screen.getByTestId('subscription-name-desc-resourceName')).toHaveValue('a'.repeat(56));
});
