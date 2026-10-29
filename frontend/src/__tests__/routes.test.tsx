import { act, render, screen, waitFor, within } from '@testing-library/react';
import { TestApp } from './TestApp';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { InitialEntry, NavigateFunction } from 'react-router-dom';
import { ServiceError } from '../api/ConsoleService';
import { MockConsoleService } from '../api/MockConsoleService';
import { fakeClients } from '../api/connect/testing';
import { clustersBackend } from './connectClusters';
// The routes load these pages lazily; loaded here, their import does not run inside a test's findBy.
import '../pages/grid/GridPage';
import '../pages/models/ModelDetailsPage';
import '../pages/models/ModelEditPage';
import '../pages/models/ModelWizard';
import '../pages/models/ModelsPage';
import '../pages/monitoring/MonitoringPage';
import '../pages/organizations/OrganizationDetailsPage';
import '../pages/organizations/OrganizationListPage';
import '../pages/organizations/OrganizationWizardPage';
import '../pages/subscriptions/CreateSubscriptionPage';
import '../pages/subscriptions/EditSubscriptionPage';
import '../pages/subscriptions/SubscriptionsPage';
import '../pages/subscriptions/ViewSubscriptionPage';

const at = (path: InitialEntry, service = new MockConsoleService()) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <TestApp service={service} />
    </MemoryRouter>,
  );

describe('routes', () => {
  it('lands on the AI Grid map', async () => {
    at('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'AI Grid' })).toBeInTheDocument();
  });

  it('deep-links to every route', async () => {
    for (const path of [
      '/ai-grid',
      '/monitoring',
      '/clusters',
      '/organizations',
      '/organizations/create',
      '/models',
      '/models/deploy',
      '/subscriptions',
      '/subscriptions/create',
      '/organizations/org-1',
      '/organizations/org-1/edit',
      '/subscriptions/view/engineering',
      '/subscriptions/edit/engineering',
    ]) {
      const { unmount } = at(path);
      expect(await screen.findByRole('main')).toBeInTheDocument();
      expect(screen.queryByText('Page not found')).not.toBeInTheDocument();
      unmount();
    }
  });

  // Each /user is a hub access review: the shell loads the user and the config, and pages read them.
  it.each([
    '/ai-grid',
    '/clusters',
    '/organizations',
    '/organizations/org-1',
    '/models',
    '/models/ai-grid-models/granite-3-8b',
    '/subscriptions',
    '/subscriptions/view/engineering',
  ])('asks for the user and the config once: %s', async (path) => {
    const service = new MockConsoleService();
    const getUser = vi.spyOn(service, 'getUser');
    const getConfig = vi.spyOn(service, 'getConfig');
    at(path, service);
    await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('dev-user'));
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(getConfig).toHaveBeenCalledTimes(1);
  });

  // Review focus 1 (A33/C10): on the real backend, which has only Ping, ListManagedClusters and
  // ListTenants, every page that needs a missing RPC says so instead of showing an error.
  const orgs = 'Organizations are not available on this backend yet';
  const subs = 'Subscriptions are not available on this backend yet';
  /** The deploy wizard loads locations up front but shows them on its third step. */
  const toLocationsStep = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('textbox', { name: /Model URI/ }));
    await user.paste('hf://org/widget');
    await user.click(screen.getByRole('textbox', { name: /^Model name/ }));
    await user.paste('org/widget');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByTestId('model-name-desc-name'));
    await user.paste('Widget');
    await user.click(screen.getByRole('textbox', { name: /Runtime image/ }));
    await user.paste('registry.example/runtime:test');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model server' }), 'vLLM on CPU');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
  };
  it.each<[path: string, methods: string, text: string, open?: typeof toLocationsStep]>([
    ['/organizations', 'listOrganizations', orgs],
    ['/organizations/org-1', 'getOrganization', orgs],
    ['/organizations/org-1/edit', 'getOrganization', orgs],
    ['/models', 'listModels', 'Models are not available on this backend yet'],
    ['/models/deploy', 'listLocations', 'Locations are not available on this backend yet.', toLocationsStep],
    ['/ai-grid', 'listClusters', 'AI Grid is not available on this backend yet'],
    ['/monitoring', 'getGridOverview', 'Monitoring is not available on this backend yet'],
  ])('renders not-available pages: %s without %s', async (path, methods, text, open) => {
    const service = new MockConsoleService();
    // `methods` lists the service calls that answer 501, joined with +.
    for (const name of methods.split('+') as (keyof MockConsoleService)[]) {
      vi.spyOn(service, name as 'listModels').mockRejectedValue(
        new ServiceError(501, 'the AI Grid backend does not support this operation yet'),
      );
    }
    const user = userEvent.setup();
    at(path, service);
    // Let the shell's own loads (user, config) settle first, so none lands outside act.
    await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('dev-user'));
    await open?.(user);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
    expect(screen.queryByText('the AI Grid backend does not support this operation yet')).not.toBeInTheDocument();
  });

  // The subscription pages call the backend over Connect: one without the Subscriptions and
  // Models RPCs answers Unimplemented.
  it.each([
    '/subscriptions',
    '/subscriptions/view/engineering',
    '/subscriptions/create',
    '/subscriptions/edit/engineering',
  ])('renders the not-available page: %s on a backend without Subscriptions', async (path) => {
    const service = new MockConsoleService();
    render(
      <MemoryRouter initialEntries={[path]}>
        <TestApp
          service={service}
          transport={(interceptors) => fakeClients({ clusters: clustersBackend(service) }, { interceptors }).transport}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('dev-user'));
    expect(await screen.findByText(subs)).toBeInTheDocument();
    expect(screen.queryByText('the AI Grid backend does not support this operation yet')).not.toBeInTheDocument();
  });

  it.each([
    ['/models/ai-grid-models/nope', 'Models', 'Model deployment not found', 'Go to Models', '/models'],
    ['/models/ai-grid-models/nope/edit', 'Models', 'Model deployment not found', 'Go to Models', '/models'],
    [
      '/organizations/does-not-exist',
      'Organizations',
      'Organization not found',
      'Go to Organizations',
      '/organizations',
    ],
    [
      '/organizations/does-not-exist/edit',
      'Organizations',
      'Organization not found',
      'Go to Organizations',
      '/organizations',
    ],
    ['/subscriptions/view/nope', 'Subscriptions', 'Subscription not found', 'Go to Subscriptions', '/subscriptions'],
    ['/subscriptions/edit/nope', 'Subscriptions', 'Subscription not found', 'Go to Subscriptions', '/subscriptions'],
  ])('says a missing object is not found, the same way: %s', async (path, h1, title, back, href) => {
    at(path);
    const state = await screen.findByTestId('not-found-state');
    // The page's heading names the list, not the id that doesn't exist.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(h1);
    expect(within(state).getByRole('heading', { name: title })).toBeVisible();
    expect(within(state).getByRole('link', { name: back })).toHaveAttribute('href', href);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(document.querySelector('.pf-v6-c-alert.pf-m-danger')).toBeNull();
    expect(screen.queryByText(/object with identifier/)).not.toBeInTheDocument();
  });

  it('shows the not-found page with a way back', async () => {
    at('/nowhere');
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Clusters' })).toHaveAttribute('href', '/clusters');
    expect(document.title).toBe('Page not found · Cloud Provider Admin Console');
  });

  it('orders the navigation like the PoC, with organization wording', async () => {
    at('/clusters');
    const nav = await screen.findByRole('navigation', { name: 'Console sections' });
    const names = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent);
    expect(names).toEqual(['AI Grid', 'Monitoring', 'Clusters', 'Organizations', 'Models', 'Subscriptions']);
  });

  it('collapses and expands the navigation from the masthead, as the PoC does', async () => {
    const user = userEvent.setup();
    at('/clusters', new MockConsoleService());
    await user.click(await screen.findByRole('button', { name: 'Collapse navigation' }));
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the navigation over a narrow window, and closes it after a section is chosen', async () => {
    window.innerWidth = 400;
    try {
      const user = userEvent.setup();
      at('/clusters', new MockConsoleService());
      const toggle = await screen.findByRole('button', { name: 'Expand navigation' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await user.click(toggle);
      expect(screen.getByRole('button', { name: 'Collapse navigation' })).toHaveAttribute('aria-expanded', 'true');
      await user.click(screen.getByRole('link', { name: 'Models' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute('aria-expanded', 'false');
    } finally {
      window.innerWidth = 1280;
    }
  });

  it('shows the fake-backend banner only in fake mode', async () => {
    const fake = new MockConsoleService();
    fake.config = { ...fake.config, fakeBackend: true };
    const { unmount } = at('/clusters', fake);
    // Neutral about the fixture directory: the browser tests load mock/fixtures-poc.
    expect(await screen.findByText(/fake backend/i)).not.toHaveTextContent('mock/fixtures');
    unmount();

    const real = new MockConsoleService();
    const getConfig = vi.spyOn(real, 'getConfig');
    at('/clusters', real);
    await screen.findByRole('heading', { name: 'Clusters' });
    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    await getConfig.mock.results[0].value;
    expect(screen.queryByText(/fake backend/i)).not.toBeInTheDocument();
  });

  it.each([
    '/clusters',
    '/organizations',
    '/organizations/create',
    '/models',
    '/models/deploy',
    '/subscriptions',
    '/ai-grid',
    '/monitoring',
    '/nowhere',
  ])('fills the page height with the content section: %s', async (path) => {
    at(path);
    await waitFor(() => expect(screen.getByTestId('masthead-user')).toHaveTextContent('dev-user'));
    // PatternFly's Page isContentFilled plus a PageSection isFilled: the white panel reaches the bottom.
    // A wizard's is PatternFly's wizard section, so its footer stays in view and only the step scrolls.
    const section = ['/models/deploy', '/organizations/create'].includes(path) ? 'wizard' : 'section';
    expect(document.querySelector('.pf-v6-c-page__main-container.pf-m-fill')).not.toBeNull();
    await waitFor(() => expect(document.querySelector(`.pf-v6-c-page__main-${section}.pf-m-fill`)).not.toBeNull());
  });

  it('shows a success toast for a notice passed through navigation state', async () => {
    at({ pathname: '/clusters', state: { notice: 'Organization saved' } });
    expect(await screen.findByText('Organization saved')).toBeInTheDocument();
  });

  it('clears a success toast when the user moves on to another page', async () => {
    const user = userEvent.setup();
    at({ pathname: '/clusters', state: { notice: 'Organization saved' } });
    expect(await screen.findByText('Organization saved')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Models' }));
    await screen.findByRole('heading', { level: 1, name: 'Models' });
    expect(screen.queryByText('Organization saved')).not.toBeInTheDocument();
  });

  it('does not show a notice again when Back returns to its page', async () => {
    let navigate!: NavigateFunction;
    const CaptureNavigate = () => {
      navigate = useNavigate();
      return null;
    };
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[{ pathname: '/clusters', state: { notice: 'Organization saved' } }]}>
        <CaptureNavigate />
        <TestApp service={new MockConsoleService()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Organization saved')).toBeInTheDocument();
    // Taking the notice out of the history entry doesn't close the toast.
    await act(async () => {});
    expect(screen.getByText('Organization saved')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Models' }));
    await screen.findByRole('heading', { level: 1, name: 'Models' });
    await act(async () => {
      await navigate(-1);
    });
    await screen.findByRole('heading', { level: 1, name: 'Clusters' });
    expect(screen.queryByText('Organization saved')).not.toBeInTheDocument();
  });

  it('times a success toast out', async () => {
    vi.useFakeTimers();
    try {
      at({ pathname: '/clusters', state: { notice: 'Organization saved' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Organization saved')).toBeInTheDocument();
      // PatternFly's 8 seconds, then its 3-second fade.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11500);
      });
      expect(screen.queryByText('Organization saved')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
