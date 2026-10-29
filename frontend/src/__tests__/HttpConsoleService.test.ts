import { HttpConsoleService } from '../api/HttpConsoleService';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('HttpConsoleService', () => {
  it('unwraps the data envelope', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: { username: 'u', groups: [], isProviderAdmin: true } }));
    const service = new HttpConsoleService(fetchFn);
    await expect(service.getUser()).resolves.toEqual({ username: 'u', groups: [], isProviderAdmin: true });
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/user', expect.objectContaining({ method: 'GET' }));
  });

  it('lists organizations from /tenants', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: [{ id: '1', name: 't', enabled: true, domains: [] }] }));
    const service = new HttpConsoleService(fetchFn);
    await expect(service.listOrganizations()).resolves.toEqual([
      { id: '1', name: 't', domains: [], status: 'Enabled', resourceVersion: '', creationTimestamp: '' },
    ]);
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/tenants', expect.objectContaining({ method: 'GET' }));
  });

  it('writes organizations by id, with the version in If-Match', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => jsonResponse(200, { data: { id: 'a b', domains: [] } }));
    const service = new HttpConsoleService(fetchFn);
    const input = { name: 'acme', domains: [], identityProvider: { title: 'SSO' } } as never;
    await service.getOrganization('a b');
    expect(fetchFn).toHaveBeenLastCalledWith('/api/v1/tenants/a%20b', expect.objectContaining({ method: 'GET' }));
    await service.createOrganization(input);
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/api/v1/tenants',
      expect.objectContaining({
        method: 'POST',
        body: '{"name":"acme","domains":[],"identityProvider":{"title":"SSO"}}',
        // The BFF answers 415 without it, which keeps cross-site form posts out.
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
    await service.updateOrganization('a b', input, '7');
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/api/v1/tenants/a%20b',
      expect.objectContaining({
        method: 'PATCH',
        // The name can't change, so it isn't sent.
        body: '{"domains":[],"identityProvider":{"title":"SSO"}}',
        headers: expect.objectContaining({ 'If-Match': '"7"' }),
      }),
    );
    fetchFn.mockImplementation(async () => new Response(null, { status: 204 }));
    await expect(service.deleteOrganization('a b', '8')).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/api/v1/tenants/a%20b',
      expect.objectContaining({ method: 'DELETE', headers: expect.objectContaining({ 'If-Match': '"8"' }) }),
    );
  });

  it('gets one model by namespace and name', async () => {
    const model = { name: 'a b', namespace: 'team-models', resourceVersion: '7', modelName: 'org/widget' };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { data: model }));
    const service = new HttpConsoleService(fetchFn);
    await expect(service.getModel('team-models', 'a b')).resolves.toMatchObject({
      name: 'a b',
      namespace: 'team-models',
      resourceVersion: '7',
    });
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/models/team-models/a%20b',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('lists, creates and deletes models, with the version in If-Match', async () => {
    const model = { name: 'widget', namespace: 'team-models', modelUri: 'hf://org/widget', modelName: 'org/widget' };
    const fetchFn = vi.fn().mockImplementation(async (url: string) =>
      jsonResponse(200, {
        data: url.endsWith('/config') ? { modelsNamespace: 'team-models' } : url.endsWith('/models') ? [model] : [],
      }),
    );
    const service = new HttpConsoleService(fetchFn);
    await expect(service.listModels()).resolves.toMatchObject([{ name: 'widget', namespace: 'team-models' }]);
    // The whole list: the page filters, sorts and pages in the browser.
    expect(fetchFn).toHaveBeenLastCalledWith('/api/v1/models', expect.objectContaining({ method: 'GET' }));
    await service.listLocations();
    expect(fetchFn).toHaveBeenLastCalledWith('/api/v1/locations', expect.objectContaining({ method: 'GET' }));
    fetchFn.mockImplementation(async (url: string) =>
      jsonResponse(200, { data: url.endsWith('/config') ? { modelsNamespace: 'team-models' } : model }),
    );
    const input = {
      name: 'widget',
      displayName: 'Widget',
      modelUri: 'hf://org/widget',
      modelName: 'org/widget',
      runtimeImage: 'img',
      replicas: 1,
      cpu: '2',
      memory: '4Gi',
      gpuCount: 0,
      runtimeArgs: [],
      baseRefs: ['v3-6-0-kserve-config-llm-template-cpu'],
      locations: ['site-paris-1'],
    };
    await expect(service.createModel(input)).resolves.toMatchObject({ name: 'widget', namespace: 'team-models' });
    const post = fetchFn.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/v1/models');
    // The BFF's ModelCreate (bff/internal/api/models.go) in the configured namespace, placed by cluster name.
    expect(JSON.parse(post?.[1].body)).toMatchObject({
      name: 'widget',
      namespace: 'team-models',
      baseRefs: ['v3-6-0-kserve-config-llm-template-cpu'],
      placement: { matchExpressions: [{ key: 'name', operator: 'In', values: ['site-paris-1'] }] },
    });
    fetchFn.mockImplementation(async () =>
      jsonResponse(200, {
        data: { name: 'a b', namespace: 'team-models', modelUri: 'hf://x', modelName: 'x', replicas: 2 },
      }),
    );
    await expect(service.updateModel('team-models', 'a b', { replicas: 2 }, '3')).resolves.toMatchObject({
      replicas: 2,
    });
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/api/v1/models/team-models/a%20b',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({ 'If-Match': '"3"' }),
        body: JSON.stringify({ replicas: 2 }),
      }),
    );
    fetchFn.mockImplementation(async () => new Response(null, { status: 204 }));
    await expect(service.deleteModel('team-models', 'a b', '3')).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/api/v1/models/team-models/a%20b',
      expect.objectContaining({ method: 'DELETE', headers: expect.objectContaining({ 'If-Match': '"3"' }) }),
    );
  });

  it('maps the clusters the grid overview embeds', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: { clusters: [{ name: 'site-madrid-1', aiGridEnabled: true, provisioned: true }], metrics: [] },
      }),
    );
    const overview = await new HttpConsoleService(fetchFn).getGridOverview('1h');
    expect(overview.clusters).toEqual([
      expect.objectContaining({ name: 'site-madrid-1', status: 'Unknown', provisioningStatus: 'Provisioned' }),
    ]);
  });

  it('surfaces the BFF error message and status', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(401, { error: { code: '401', message: 'missing header' } }));
    const service = new HttpConsoleService(fetchFn);
    await expect(service.getUser()).rejects.toMatchObject({ status: 401, message: 'missing header' });
  });

  it('maps network failures to status 0', async () => {
    const service = new HttpConsoleService(vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(service.getUser()).rejects.toMatchObject({ status: 0 });
  });

  it('sends the version as a quoted If-Match and returns undefined for 204', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const service = new HttpConsoleService(fetchFn);
    await expect(service.request('DELETE', '/subscriptions/research', { ifMatch: '3' })).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/subscriptions/research',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ 'If-Match': '"3"' }),
      }),
    );
  });

  it('sends no If-Match for an object the backend gave no version', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
    const service = new HttpConsoleService(fetchFn);
    await service.deleteOrganization('t-9', '');
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('If-Match');
  });

  it('reads the grid overview with the range, site and metrics query', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => jsonResponse(200, { data: { clusters: [], metrics: [] } }));
    const service = new HttpConsoleService(fetchFn);
    await service.getGridOverview('1h');
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/api/v1/grid/overview?range=1h',
      expect.objectContaining({ method: 'GET' }),
    );
    await service.getGridOverview('24h', { site: 'new york', includeMetrics: false });
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/api/v1/grid/overview?range=24h&site=new+york&metrics=false',
      expect.objectContaining({ method: 'GET' }),
    );
    await service.getGridOverview('6h', { site: '', includeMetrics: true });
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/api/v1/grid/overview?range=6h',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('carries field errors and flags conflicts', async () => {
    const body = {
      error: {
        code: '422',
        message: 'The organization is invalid.',
        fieldErrors: { name: 'Use lowercase letters, numbers, and hyphens.' },
      },
    };
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 422 }));
    await expect(new HttpConsoleService(fetchFn).request('POST', '/tenants', { body: {} })).rejects.toMatchObject({
      status: 422,
      fieldErrors: { name: 'Use lowercase letters, numbers, and hyphens.' },
      isConflict: false,
    });
    const conflict = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: { code: '409', message: 'changed' } }), { status: 409 }));
    await expect(
      new HttpConsoleService(conflict).request('PUT', '/tenants/x', { body: {}, ifMatch: '1' }),
    ).rejects.toMatchObject({ isConflict: true });
  });
});
