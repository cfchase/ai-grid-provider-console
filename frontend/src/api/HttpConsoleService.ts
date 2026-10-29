import type { DashboardResource } from '@perses-dev/client';
import { toGridCluster, toManagedModel, toModelCreate, toOrganization } from './adapters';
import type { ConsoleService } from './ConsoleService';
import { RelayedError, ServiceError } from './ConsoleService';
import { PERSES_API } from './monitoring';
import type {
  ApiCluster,
  ApiModel,
  ApiTenant,
  ConsoleConfig,
  CreateModelRequest,
  GridOverview,
  GridRange,
  ManagedModel,
  ModelUpdate,
  Organization,
  OrganizationInput,
  User,
} from './types';

const API_PREFIX = '/api/v1';

type Envelope<T> = { data: T };
type ErrorBody = { error?: { code?: string; message?: string; fieldErrors?: Record<string, string> } };

export type RequestOptions = {
  body?: unknown;
  /** The version the caller read; sent as `If-Match: "<version>"` unless empty. */
  ifMatch?: string;
};

export class HttpConsoleService implements ConsoleService {
  constructor(private readonly fetchFn: typeof fetch = (...args) => fetch(...args)) {}

  getUser(): Promise<User> {
    return this.request<User>('GET', '/user');
  }

  getConfig(): Promise<ConsoleConfig> {
    return this.request<ConsoleConfig>('GET', '/config');
  }

  /**
   * GET /perses/api/api/v1/[projects/<project>/]dashboards through the BFF's relay. The relay passes
   * Perses's answers on unchanged, so a failure carries Perses's message, or the BFF's own for the
   * relay's checks (401, 403, 404 when monitoring isn't configured).
   */
  async listMonitoringDashboards(project: string): Promise<DashboardResource[]> {
    let response: Response;
    try {
      response = await this.fetchFn(`${PERSES_API}/api/v1/projects/${encodeURIComponent(project)}/dashboards`, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
    } catch {
      throw new ServiceError(0, 'The console backend could not be reached.');
    }
    if (!response.ok) {
      let message = `Request failed with status ${response.status}.`;
      try {
        const payload = (await response.json()) as ErrorBody & { message?: string };
        message = payload.error?.message || payload.message || message;
      } catch {
        // keep the generic message
      }
      throw new RelayedError(response.status, message);
    }
    return (await response.json()) as DashboardResource[];
  }

  async listOrganizations(): Promise<Organization[]> {
    return (await this.request<ApiTenant[]>('GET', '/tenants')).map(toOrganization);
  }

  async getOrganization(id: string): Promise<Organization> {
    return toOrganization(await this.request<ApiTenant>('GET', `/tenants/${encodeURIComponent(id)}`));
  }

  async createOrganization(input: OrganizationInput): Promise<Organization> {
    const { name, domains, identityProvider } = input;
    return toOrganization(
      await this.request<ApiTenant>('POST', '/tenants', { body: { name, domains, identityProvider } }),
    );
  }

  /** PATCHes only what the PoC can change: the domains and the identity provider, not the name. */
  async updateOrganization(id: string, input: OrganizationInput, resourceVersion: string): Promise<Organization> {
    const { domains, identityProvider } = input;
    return toOrganization(
      await this.request<ApiTenant>('PATCH', `/tenants/${encodeURIComponent(id)}`, {
        body: { domains, identityProvider },
        ifMatch: resourceVersion,
      }),
    );
  }

  deleteOrganization(id: string, resourceVersion: string): Promise<void> {
    return this.request<void>('DELETE', `/tenants/${encodeURIComponent(id)}`, { ifMatch: resourceVersion });
  }

  async listModels(): Promise<ManagedModel[]> {
    return (await this.request<ApiModel[]>('GET', '/models')).map(toManagedModel);
  }

  async getModel(namespace: string, name: string): Promise<ManagedModel> {
    return toManagedModel(
      await this.request<ApiModel>('GET', `/models/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`),
    );
  }

  listLocations(): Promise<string[]> {
    return this.request<string[]>('GET', '/locations');
  }

  /** POSTs the BFF's ModelCreate (bff/internal/api/models.go) with only the wizard's keys, in the configured models namespace. */
  async createModel(input: CreateModelRequest): Promise<ManagedModel> {
    const { modelsNamespace } = await this.getConfig();
    return toManagedModel(
      await this.request<ApiModel>('POST', '/models', { body: toModelCreate(input, modelsNamespace) }),
    );
  }

  async updateModel(
    namespace: string,
    name: string,
    update: ModelUpdate,
    resourceVersion: string,
  ): Promise<ManagedModel> {
    return toManagedModel(
      await this.request<ApiModel>('PATCH', `/models/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`, {
        body: update,
        ifMatch: resourceVersion,
      }),
    );
  }

  deleteModel(namespace: string, name: string, resourceVersion: string): Promise<void> {
    return this.request<void>('DELETE', `/models/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`, {
      ifMatch: resourceVersion,
    });
  }

  async getGridOverview(
    range: GridRange,
    opts: { site?: string; includeMetrics?: boolean } = {},
  ): Promise<GridOverview> {
    const query = new URLSearchParams({ range });
    if (opts.site) {
      query.set('site', opts.site);
    }
    if (opts.includeMetrics === false) {
      query.set('metrics', 'false');
    }
    const overview = await this.request<Omit<GridOverview, 'clusters'> & { clusters: ApiCluster[] }>(
      'GET',
      `/grid/overview?${query}`,
    );
    return { ...overview, clusters: overview.clusters.map(toGridCluster) };
  }

  /** Calls the BFF and unwraps its data envelope; `undefined` for 204. */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const { body, ifMatch } = opts;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    // An object the backend gave no version is read with "": send no
    // precondition then (the BFF answers 422 to an empty entity tag).
    if (ifMatch) {
      headers['If-Match'] = JSON.stringify(ifMatch);
    }
    let response: Response;
    try {
      response = await this.fetchFn(`${API_PREFIX}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
      });
    } catch {
      throw new ServiceError(0, 'The console backend could not be reached.');
    }
    if (!response.ok) {
      let message = `Request failed with status ${response.status}.`;
      let fieldErrors: Record<string, string> | undefined;
      try {
        const payload = (await response.json()) as ErrorBody;
        if (payload.error?.message) {
          message = payload.error.message;
        }
        fieldErrors = payload.error?.fieldErrors;
      } catch {
        // keep the generic message
      }
      throw new ServiceError(response.status, message, fieldErrors);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const payload = (await response.json()) as Envelope<T>;
    return payload.data;
  }
}
