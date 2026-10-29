import type { DashboardResource } from '@perses-dev/client';
import { consolePlacement, consolePlacementLocations, withRuntimeArgs } from './adapters';
import type { GridMembership } from './clusters';
import type { ConsoleService } from './ConsoleService';
import { ServiceError } from './ConsoleService';
import type {
  ConsoleConfig,
  CreateModelRequest,
  ClusterGPUs,
  GPUNode,
  GPUSharing,
  GridCluster,
  GridOverview,
  GridRange,
  ManagedModel,
  ModelUpdate,
  Organization,
  OrganizationInput,
  User,
} from './types';
import { createModelSchema, fieldErrorsOf, organizationInputSchema } from '../validation';
import { demoMetrics } from '../services/demoMetrics';

/** In-memory service for tests and UI work without a cluster. */
export class MockConsoleService implements ConsoleService {
  public models: ManagedModel[] = seedModels();

  constructor(
    public user: User = { username: 'dev-user', groups: ['cluster-admins'], isProviderAdmin: true },
    public clusters: GridCluster[] = seedClusters(),
    public organizations: Organization[] = seedOrganizations(),
    public config: ConsoleConfig = {
      gridEndpoint: 'https://ai.grid.example.com',
      mapTileUrl: '',
      mapTileAttribution: '',
      billingUrl: '',
      version: 'mock',
      modelsNamespace: 'ai-grid-models',
      fakeBackend: false,
      monitoring: { enabled: false, persesProject: '' },
    },
  ) {}

  /** The hub's Perses dashboards, for the Monitoring page; none until a test sets them. */
  monitoringDashboards: DashboardResource[] = [];

  listMonitoringDashboards = async (project: string): Promise<DashboardResource[]> =>
    this.monitoringDashboards.filter((d) => d.metadata.project === project);

  getUser = async (): Promise<User> => this.user;

  getConfig = async (): Promise<ConsoleConfig> => this.config;

  listClusters = async (): Promise<GridCluster[]> => [...this.clusters];

  getCluster = async (name: string): Promise<GridCluster> => {
    const cluster = this.clusters.find((c) => c.name === name);
    if (!cluster) {
      throw new ServiceError(404, `object with identifier '${name}' not found`);
    }
    return cluster;
  };

  /**
   * Sets `ai-grid/enabled`, `ai-grid/role` and `location` on the labels the caller read, as
   * HttpConsoleService sends them: the BFF's PATCH replaces the labels map as a whole, at the
   * version the caller read.
   */
  enrollCluster = async (cluster: GridCluster, membership: GridMembership): Promise<GridCluster> =>
    this.setMembership(cluster, membership);

  removeClusterFromGrid = async (cluster: GridCluster): Promise<GridCluster> => this.setMembership(cluster);

  /** Writes a membership's labels, or drops `ai-grid/enabled` without one; provisioning follows toGridCluster. */
  private setMembership(cluster: GridCluster, membership?: GridMembership): GridCluster {
    const { name } = cluster;
    const index = this.clusters.findIndex((c) => c.name === name);
    if (index < 0) {
      throw new ServiceError(404, `object with identifier '${name}' not found`);
    }
    const current = this.clusters[index];
    // The fake backend's precondition (bff/internal/fakebackend/clusters.go), answered 409 by the BFF.
    if ((cluster.resourceVersion ?? '') !== (current.resourceVersion ?? '')) {
      throw new ServiceError(
        409,
        `object with identifier '${name}' has resource version ${current.resourceVersion}, the request carries "${cluster.resourceVersion ?? ''}"; fetch it again and retry`,
      );
    }
    const labels = { ...cluster.labels };
    const member = !!membership;
    if (membership) {
      Object.assign(labels, {
        'ai-grid/enabled': 'true',
        'ai-grid/role': membership.role,
        location: membership.location,
      });
    } else {
      delete labels['ai-grid/enabled'];
    }
    const updated: GridCluster = {
      ...current,
      aiGridEnabled: member,
      provisioningStatus: !member ? 'Not provisioned' : current.provisioned ? 'Provisioned' : 'Provisioning',
      ...(labels.location ? { location: labels.location } : {}),
      labels,
      resourceVersion: String(Number(current.resourceVersion ?? '0') + 1),
    };
    this.clusters[index] = updated;
    return updated;
  }

  /**
   * The fake backend's GetOverview (bff/internal/fakebackend/grid.go): the AI Grid members,
   * filtered by site, and the PoC's simulated metrics for the range ending at the current second.
   */
  getGridOverview = async (
    range: GridRange,
    opts: { site?: string; includeMetrics?: boolean } = {},
  ): Promise<GridOverview> => {
    const seconds = { '1h': 3600, '6h': 21600, '24h': 86400 }[range];
    if (!seconds) {
      throw new ServiceError(422, 'Choose a time range of 1h, 6h, or 24h.');
    }
    const clusters = this.clusters
      .filter((c) => c.aiGridEnabled && (!opts.site || c.site === opts.site))
      .sort((a, b) => a.name.localeCompare(b.name));
    const end = Math.floor(Date.now() / 1000);
    return {
      updatedAt: new Date(end * 1000).toISOString(),
      inventorySource: 'acm',
      demo: false,
      metricsSource: 'demo',
      clusters,
      metrics: opts.includeMetrics === false ? [] : demoMetrics(clusters, end - seconds, end, Math.ceil(seconds / 60)),
    };
  };

  // The fake backend's organization rules and messages (bff/internal/fakebackend/tenants.go),
  // with the BFF's status codes.

  listOrganizations = async (): Promise<Organization[]> =>
    [...this.organizations].sort((a, b) => a.name.localeCompare(b.name));

  getOrganization = async (id: string): Promise<Organization> => this.organizations[this.organizationIndex(id)];

  createOrganization = async (input: OrganizationInput): Promise<Organization> => {
    this.checkOrganization(input, undefined);
    const now = new Date().toISOString();
    const created: Organization = {
      ...structuredClone(input),
      id: crypto.randomUUID(),
      status: 'Enabled',
      resourceVersion: '1',
      creationTimestamp: now,
    };
    this.organizations.push(created);
    return structuredClone(created);
  };

  updateOrganization = async (id: string, input: OrganizationInput, resourceVersion: string): Promise<Organization> => {
    const index = this.organizationIndex(id);
    const current = this.organizations[index];
    if (resourceVersion !== current.resourceVersion) {
      throw new ServiceError(409, organizationChanged(id, current.resourceVersion, resourceVersion));
    }
    if (input.name !== current.name) {
      throw new ServiceError(422, organizationRenamed, { name: organizationRenamed });
    }
    this.checkOrganization(input, id);
    const updated: Organization = {
      ...current,
      domains: [...input.domains],
      identityProvider: structuredClone(input.identityProvider),
      resourceVersion: String(Number(current.resourceVersion) + 1),
    };
    this.organizations[index] = updated;
    return structuredClone(updated);
  };

  deleteOrganization = async (id: string, resourceVersion: string): Promise<void> => {
    const index = this.organizationIndex(id);
    const current = this.organizations[index];
    if (resourceVersion !== current.resourceVersion) {
      throw new ServiceError(409, organizationChanged(id, current.resourceVersion, resourceVersion));
    }
    this.organizations.splice(index, 1);
  };

  // The fake backend's model rules and messages (bff/internal/fakebackend/models.go),
  // with the BFF's status codes.

  listModels = async (): Promise<ManagedModel[]> =>
    structuredClone(this.models).sort((a, b) => a.name.localeCompare(b.name));

  getModel = async (namespace: string, name: string): Promise<ManagedModel> => {
    const model = this.models.find((m) => m.namespace === namespace && m.name === name);
    if (!model) {
      throw new ServiceError(404, `object with identifier '${namespace}/${name}' not found`);
    }
    return structuredClone(model);
  };

  /** The PoC's eligibleLocations: Ready, provisioned AI Grid members' location labels. */
  listLocations = async (): Promise<string[]> =>
    [
      ...new Set(
        this.clusters
          .filter(
            (c) =>
              c.aiGridEnabled &&
              c.provisioned &&
              c.status === 'Ready' &&
              ['inference', 'combined'].includes(c.labels?.['ai-grid/role'] ?? ''),
          )
          .map((c) => c.name),
      ),
    ].sort();

  /**
   * The fake backend's decision for the console's placement, `name In [...]`
   * (bff/internal/fakebackend/placement.go): the clusters of those names, sorted.
   */
  private decidedClusters = (names: string[]): string[] =>
    this.clusters
      .filter((c) => names.includes(c.name))
      .map((c) => c.name)
      .sort();

  /** The decided clusters' `location` labels, unique and sorted, as the fake reports them (P8). */
  private decidedLocations = (names: string[]): string[] =>
    [
      ...new Set(this.clusters.filter((c) => names.includes(c.name) && c.location).map((c) => c.location as string)),
    ].sort();

  createModel = async (input: CreateModelRequest): Promise<ManagedModel> => {
    const fieldErrors = fieldErrorsOf(createModelSchema, input);
    if (Object.keys(fieldErrors).length > 0) {
      throw new ServiceError(422, 'The model is invalid.', fieldErrors);
    }
    const known = await this.listLocations();
    if (input.locations.some((l) => !known.includes(l))) {
      throw new ServiceError(422, unknownLocation, { locations: unknownLocation });
    }
    const namespace = this.config.modelsNamespace;
    if (this.models.some((m) => m.namespace === namespace && m.name === input.name)) {
      throw new ServiceError(409, 'A model with this resource name already exists.');
    }
    const created: ManagedModel = {
      name: input.name,
      namespace,
      displayName: input.displayName.trim(),
      description: input.description,
      modelRef: { kind: 'LLMInferenceService', name: input.name },
      phase: 'Pending',
      creationTimestamp: new Date().toISOString(),
      resourceVersion: '1',
      locations: this.decidedLocations(input.locations),
      selectedClusters: this.decidedClusters(input.locations),
      modelUri: input.modelUri.trim(),
      modelName: input.modelName.trim(),
      runtimeImage: input.runtimeImage.trim(),
      replicas: input.replicas,
      autoscaled: false,
      cpu: input.cpu,
      memory: input.memory,
      gpuCount: input.gpuCount,
      baseRefs: [...input.baseRefs],
      env: withRuntimeArgs([], input.runtimeArgs),
      annotations: {
        ...(input.displayName.trim() ? { 'openshift.io/display-name': input.displayName.trim() } : {}),
        ...(input.description ? { 'openshift.io/description': input.description } : {}),
      },
      placementSpec: consolePlacement(input.locations),
    };
    this.models.push(created);
    return structuredClone(created);
  };

  /** The fake backend's UpdateModel through the BFF's PATCH: each present field replaces the stored one. */
  updateModel = async (
    namespace: string,
    name: string,
    update: ModelUpdate,
    resourceVersion: string,
  ): Promise<ManagedModel> => {
    const model = this.models.find((m) => m.namespace === namespace && m.name === name);
    if (!model) {
      throw new ServiceError(404, `Model ${namespace}/${name} not found.`);
    }
    if (resourceVersion !== model.resourceVersion) {
      throw new ServiceError(409, 'This model changed. Reload it before saving.');
    }
    if (Object.keys(update).length === 0) {
      throw new ServiceError(422, 'Name at least one field to change.');
    }
    const fieldErrors = fieldErrorsOf(createModelSchema.pick({ replicas: true, runtimeImage: true }).partial(), {
      replicas: update.replicas,
      runtimeImage: update.runtimeImage,
    });
    if (Object.keys(fieldErrors).length > 0) {
      throw new ServiceError(422, 'The model is invalid.', fieldErrors);
    }
    const locations = consolePlacementLocations(update.placement);
    if (update.placement) {
      const known = await this.listLocations();
      if (!locations?.length || locations.some((l) => !known.includes(l))) {
        throw new ServiceError(422, unknownLocation, { locations: unknownLocation });
      }
    }
    if (update.replicas !== undefined) model.replicas = update.replicas;
    if (update.runtimeImage !== undefined) model.runtimeImage = update.runtimeImage.trim();
    if (update.env) model.env = structuredClone(update.env);
    if (update.annotations) {
      model.annotations = { ...update.annotations };
      // As the BFF: no display name when the annotation is missing (omitempty in toModel).
      model.displayName = update.annotations['openshift.io/display-name'] || undefined;
      model.description = update.annotations['openshift.io/description'] || undefined;
    }
    if (update.placement && locations) {
      model.placementSpec = structuredClone(update.placement);
      model.locations = this.decidedLocations(locations);
      model.selectedClusters = this.decidedClusters(locations);
    }
    model.resourceVersion = String(Number(model.resourceVersion) + 1);
    return structuredClone(model);
  };

  deleteModel = async (namespace: string, name: string, resourceVersion: string): Promise<void> => {
    const index = this.models.findIndex((m) => m.namespace === namespace && m.name === name);
    if (index < 0) {
      throw new ServiceError(404, `object with identifier '${namespace}/${name}' not found`);
    }
    if (resourceVersion && resourceVersion !== this.models[index].resourceVersion) {
      throw new ServiceError(409, 'This model changed. Reload it before deleting.');
    }
    this.models.splice(index, 1);
  };

  private organizationIndex(id: string): number {
    const index = this.organizations.findIndex((o) => o.id === id);
    if (index < 0) {
      throw new ServiceError(404, `object with identifier '${id}' not found`);
    }
    return index;
  }

  private checkOrganization(input: OrganizationInput, self: string | undefined) {
    const fieldErrors = fieldErrorsOf(organizationInputSchema, input);
    if (Object.keys(fieldErrors).length > 0) {
      throw new ServiceError(422, 'The organization is invalid.', fieldErrors);
    }
    const others = this.organizations.filter((o) => o.id !== self);
    if (others.some((o) => o.name === input.name)) {
      throw new ServiceError(409, 'An organization with this name already exists.');
    }
    if (others.some((o) => o.domains.some((d) => input.domains.includes(d)))) {
      throw new ServiceError(409, 'One or more domains are already assigned to another organization.');
    }
  }
}

const unknownLocation = 'Select locations from the available location catalog.';

// The fake backend's Aborted message (checkTenantVersion), which the BFF passes through as a 409.
const organizationChanged = (id: string, stored: string, carried: string) =>
  `object with identifier '${id}' has resource version ${stored}, the request carries "${carried}"; fetch it again and retry`;
const organizationRenamed = 'The organization name cannot be changed.';

// The PoC's Git-backend seed (shared/grid-clusters.mjs seedClusters at 62319b8),
// the same clusters as mock/fixtures/managedclusters.json.
const seedSites: [name: string, site: string, siteName: string, region: string, latitude: number, longitude: number][] =
  [
    ['site1', 'san-francisco', 'San Francisco', 'us-west', 37.7749, -122.4194],
    ['site2', 'new-york', 'New York', 'us-east', 40.7128, -74.006],
    ['site3', 'brussels', 'Brussels', 'europe-west', 50.8503, 4.3517],
    ['site4', 'sydney', 'Sydney', 'asia-pacific', -33.8688, 151.2093],
  ];

/** One GPU node as the backend reports it from GPU Feature Discovery's labels. */
const gpuNode = (
  name: string,
  product: string,
  count: number,
  memoryMib: number,
  family: string,
  computeCapability: string,
  instanceType: string,
  sharing: GPUSharing = { strategy: 'none', replicas: 1, migCapable: false },
): GPUNode => ({
  name,
  vendor: 'NVIDIA',
  product,
  count,
  memoryMib,
  family,
  computeCapability,
  driverVersion: '580.105.08',
  cudaRuntimeVersion: '13.0',
  sharing,
  instanceType,
  ready: true,
});

/** A cluster's inventory from nodes that share one configuration, as the backend derives it. */
const gpuInventory = (nodes: GPUNode[]): ClusterGPUs => ({
  total: nodes.reduce((sum, n) => sum + n.count, 0),
  nodeCount: nodes.length,
  configurations: [
    {
      vendor: nodes[0].vendor,
      product: nodes[0].product,
      memoryMib: nodes[0].memoryMib,
      gpusPerNode: nodes[0].count,
      nodeCount: nodes.length,
      sharing: nodes[0].sharing,
    },
  ],
  nodes,
});

/**
 * The members' GPUs, 16 schedulable on each as their capacity says: site1 H200, 2 nodes x 8;
 * site2 L4 time-sliced x4 on 4 nodes; site3 MIG (A100 3g.20gb), 2 nodes x 8 devices.
 */
const seedGPUs: Record<string, ClusterGPUs> = {
  site1: gpuInventory(
    [0, 1].map((i) => gpuNode(`gpu-h200-${i}`, 'NVIDIA-H200', 8, 143771, 'hopper', '9.0', 'p5en.48xlarge')),
  ),
  site2: gpuInventory(
    [0, 1, 2, 3].map((i) =>
      gpuNode(`gpu-l4-${i}`, 'NVIDIA-L4-SHARED', 1, 23034, 'ada-lovelace', '8.9', 'g6.xlarge', {
        strategy: 'time-slicing',
        replicas: 4,
        migCapable: false,
      }),
    ),
  ),
  site3: gpuInventory(
    [0, 1].map((i) =>
      gpuNode(`gpu-a100-${i}`, 'NVIDIA-A100-SXM4-40GB-MIG-3g.20gb', 8, 19968, 'ampere', '8.0', 'p4d.24xlarge', {
        strategy: 'mig',
        replicas: 1,
        migCapable: true,
        migStrategy: 'single',
      }),
    ),
  ),
};

export const seedClusters = (): GridCluster[] =>
  seedSites.map(([name, site, siteName, region, latitude, longitude], index) => {
    const member = index < 3;
    return {
      name,
      status: 'Ready',
      aiGridEnabled: member,
      provisioned: member,
      provisioningStatus: member ? 'Provisioned' : 'Not provisioned',
      location: name,
      site,
      region,
      siteName,
      latitude,
      longitude,
      openshiftVersion: '4.22.15',
      consoleUrl: `https://console-openshift-console.apps.${name}.example.com`,
      kubernetesVersion: 'v1.35.6',
      platform: 'BareMetal',
      product: 'OpenShift',
      capacity: { cpu: '192', memory: '1572864Mi', 'nvidia.com/gpu': member ? '16' : '0' },
      gpuCapacity: member ? 16 : 0,
      allocatable: { cpu: '186', memory: '1540000Mi', 'nvidia.com/gpu': member ? '16' : '0' },
      // A copy each time, so a test that changes one cluster's GPUs doesn't change the next seed's.
      ...(seedGPUs[name] ? { gpus: structuredClone(seedGPUs[name]) } : {}),
      creationTimestamp: '2026-10-01T09:00:00Z',
      addons: { 'work-manager': 'available', 'cluster-proxy': 'available' },
      conditions: [
        {
          type: 'ManagedClusterConditionAvailable',
          status: 'True',
          reason: 'ManagedClusterAvailable',
          message: 'Managed cluster is available',
          lastTransitionTime: '2026-10-01T09:00:08Z',
        },
      ],
      resourceVersion: '1',
      labels: {
        name,
        openshiftVersion: '4.22.15',
        'cluster.open-cluster-management.io/clusterset': 'ai-grid',
        location: name,
        'ai-grid/provisioned': String(member),
        'ai-grid/site': site,
        'ai-grid/region': region,
        ...(member ? { 'ai-grid/enabled': 'true', 'ai-grid/role': 'combined' } : {}),
      },
    };
  });

// The organizations in mock/fixtures/tenants.json.
const seedOrgs: [id: string, name: string, domains: string[], title: string, created: string][] = [
  [
    '3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c',
    'acme-robotics',
    ['acme-robotics.example.com', 'acme.example.org'],
    'Acme Robotics SSO',
    '2026-09-01T09:00:00Z',
  ],
  [
    '8d2e7b31-0c4f-4a9d-b5e6-7f8a9b0c1d2e',
    'globex-research',
    ['globex.example.com'],
    'Globex SSO',
    '2026-09-02T09:00:00Z',
  ],
  ['c5a4d3e2-f1b0-4987-a6c5-d4e3f2a1b0c9', 'initech-labs', [], '', '2026-09-03T09:00:00Z'],
];

export const seedOrganizations = (): Organization[] =>
  seedOrgs.map(([id, name, domains, title, created]) => {
    const realm = `https://sso.example.com/realms/${name}`;
    const oidc = `${realm}/protocol/openid-connect`;
    const full = name === 'acme-robotics';
    return {
      id,
      name,
      domains,
      identityProvider: {
        title,
        description: full ? 'Employees of Acme Robotics sign in here.' : '',
        enabled: true,
        config: {
          clientId: 'ai-grid',
          clientSecretSecret: { name: `${name}-oidc-client` },
          issuer: realm,
          authorizationUrl: `${oidc}/auth`,
          tokenUrl: `${oidc}/token`,
          defaultScopes: 'openid profile email',
          userInfoUrl: full ? `${oidc}/userinfo` : '',
          jwksUrl: full ? `${oidc}/certs` : '',
          logoutUrl: full ? `${oidc}/logout` : '',
          validateSignature: true,
        },
      },
      status: 'Enabled',
      resourceVersion: '1',
      creationTimestamp: created,
    };
  });

// The models in mock/fixtures/models.json (the PoC's catalog models), except that
// granite-3-8b is placed on site1, so pages that follow placement have one to show (A27).
export const seedModels = (): ManagedModel[] =>
  (
    [
      ['granite-3-8b', 'Granite 3.3 8B Instruct', 'Enterprise language model', 'Ready', ['site1']],
      ['llama-3-70b', 'Llama 3.3 70B Instruct', 'General purpose language model', 'Ready', []],
      ['granite-research', 'Granite research endpoint', undefined, 'Pending', []],
    ] as [string, string, string | undefined, string, string[]][]
  ).map(([name, displayName, description, phase, locations]) => ({
    name,
    namespace: 'ai-grid-models',
    displayName,
    description,
    modelRef: { kind: 'LLMInferenceService', name },
    phase,
    ...(name === 'granite-research'
      ? { reason: 'ModelNotReady', statusMessage: 'The model endpoint is starting.' }
      : {}),
    resourceVersion: '1',
    locations,
    // The seed clusters' location label is their name, and site1 is a provisioned member.
    selectedClusters: [...locations],
    modelUri: `hf://example-org/${name}`,
    modelName: `example-org/${name}`,
    runtimeImage: 'quay.io/example/vllm:v1',
    replicas: 1,
    autoscaled: false,
    cpu: '2',
    memory: '4Gi',
    gpuCount: 0,
    baseRefs: ['v3-6-0-kserve-config-llm-template-cpu'],
    env: [],
    annotations: {
      'openshift.io/display-name': displayName,
      ...(description ? { 'openshift.io/description': description } : {}),
    },
    // A placed model is the console's shape; the others are served on the hub only.
    ...(locations.length > 0 ? { placementSpec: consolePlacement(locations) } : {}),
  }));
