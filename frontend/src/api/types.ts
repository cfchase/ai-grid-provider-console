// Response shapes of the BFF. Keep in sync with docs/plan/bff-api.md.

export type User = {
  username: string;
  email?: string;
  groups: string[];
  /** UI hint only; the backend enforces authorization. */
  isProviderAdmin: boolean;
};

export type ConsoleConfig = {
  gridEndpoint: string;
  mapTileUrl: string;
  mapTileAttribution: string;
  billingUrl: string;
  version: string;
  /** The namespace the deploy wizard creates models in. */
  modelsNamespace: string;
  /** The BFF talks to the fake backend; the UI shows a banner. */
  fakeBackend: boolean;
  /** The Monitoring page's Perses relay at /perses/api. */
  monitoring: MonitoringConfig;
};

export type MonitoringConfig = {
  /** The BFF relays /perses/api to the hub's Perses; off when it has no PERSES_URL. */
  enabled: boolean;
  /** The one Perses project the relay reads, whose `dashboard-*` objects are the Monitoring tabs; set whenever Monitoring is on. */
  persesProject: string;
};

export type ClusterStatus = 'Ready' | 'Offline' | 'Unknown';

/** The ACM console's word for a cluster that is neither ready, offline, nor unknown. */
export type ClusterState = 'Pending import' | 'Importing' | 'Import failed' | 'Detaching' | 'Not accepted';

export type ProvisioningStatus = 'Provisioned' | 'Provisioning' | 'Not provisioned';

/** How a node's GPUs are shared: none, time-slicing, mps, or mig (with migStrategy single or mixed). */
export type GPUSharing = { strategy: string; replicas: number; migCapable: boolean; migStrategy?: string };

/** Nodes that share one GPU configuration (bff/internal/api/clusters.go GPUConfiguration). */
export type GPUConfiguration = {
  vendor: string;
  /** GPU Feature Discovery's product, for example NVIDIA-L4; MIG and time-slicing suffixes kept. */
  product: string;
  memoryMib: number;
  gpusPerNode: number;
  nodeCount: number;
  sharing: GPUSharing;
};

/** One node with GPUs, from its GPU Feature Discovery labels. */
export type GPUNode = {
  name: string;
  vendor: string;
  product: string;
  count: number;
  memoryMib: number;
  family?: string;
  computeCapability?: string;
  driverVersion?: string;
  cudaRuntimeVersion?: string;
  sharing: GPUSharing;
  instanceType?: string;
  ready: boolean;
};

/** A cluster's GPU inventory, as the backend reads it from ACM Search. */
export type ClusterGPUs = { total: number; nodeCount: number; configurations: GPUConfiguration[]; nodes: GPUNode[] };

/**
 * A cluster as the BFF sends it (`GridCluster` in bff/internal/api/clusters.go),
 * limited to the fields the console reads. `toGridCluster` in adapters.ts maps it.
 */
export type ApiCluster = {
  name: string;
  aiGridEnabled: boolean;
  provisioned: boolean;
  hubAcceptsClient?: boolean;
  location?: string;
  site?: string;
  region?: string;
  siteName?: string;
  latitude?: number;
  longitude?: number;
  openshiftVersion?: string;
  /**
   * ready, offline, unknown, pendingimport, importing, importfailed, detaching, or
   * notaccepted; absent when the backend reports no state.
   */
  status?: string;
  statusMessage?: string;
  consoleUrl?: string;
  kubernetesVersion?: string;
  platform?: string;
  product?: string;
  /** `status.capacity` and `status.allocatable`: Kubernetes quantities by resource name. */
  capacity?: Record<string, string>;
  /** The BFF's count of `capacity["nvidia.com/gpu"]`, 0 when the capacity has none. */
  gpuCapacity?: number;
  allocatable?: Record<string, string>;
  /** The backend's `status.gpus`: the GPU inventory from ACM Search; absent without one. */
  gpus?: ClusterGPUs;
  creationTimestamp?: string;
  /** Add-on name to available, unhealthy or unreachable. */
  addons?: Record<string, string>;
  conditions?: ClusterCondition[];
  resourceVersion?: string;
  labels?: Record<string, string>;
};

/** One of the hub's `status.conditions` on a ManagedCluster. */
export type ClusterCondition = {
  type: string;
  /** True, False or Unknown. */
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
};

/** A ManagedCluster as the console shows it; the PoC's GridCluster plus the hub fields. */
export type GridCluster = {
  name: string;
  /** The PoC's availability; every ACM state other than ready and offline is Unknown. */
  status: ClusterStatus;
  /** The ACM state behind an Unknown status, such as Importing. */
  state?: ClusterState;
  /** The backend's explanation of the state. */
  statusMessage?: string;
  aiGridEnabled: boolean;
  provisioned: boolean;
  provisioningStatus: ProvisioningStatus;
  location?: string;
  site?: string;
  region?: string;
  siteName?: string;
  /** Latitude and longitude are both present or both absent. */
  latitude?: number;
  longitude?: number;
  openshiftVersion?: string;
  /** The cluster's OpenShift web console, from its claims. */
  consoleUrl?: string;
  kubernetesVersion?: string;
  /** The infrastructure, such as AWS or BareMetal, and the product, such as OpenShift or ROSA. */
  platform?: string;
  product?: string;
  /** Absent when the backend doesn't report the cluster's resources. */
  capacity?: Record<string, string>;
  /** The BFF's count of `capacity["nvidia.com/gpu"]`, the GPUs Kubernetes can schedule. */
  gpuCapacity?: number;
  allocatable?: Record<string, string>;
  /** The backend's `status.gpus`: the GPU inventory from ACM Search; absent without one. */
  gpus?: ClusterGPUs;
  /** When the hub created the ManagedCluster. */
  creationTimestamp?: string;
  addons: Record<string, string>;
  conditions: ClusterCondition[];
  resourceVersion?: string;
  labels: Record<string, string>;
};

// The PoC's grid overview (shared/grid-monitoring.mjs gridOverviewSchema at 62319b8).
export type GridRange = '1h' | '6h' | '24h';

export type MetricStatus = 'ok' | 'unavailable' | 'not-configured' | 'no-data';

/** A sample at a Unix time in seconds. */
export type MetricPoint = { timestamp: number; value: number };

/** One fleet-wide series, such as `requests` in req/s. */
export type GridMetric = {
  key: string;
  label: string;
  unit: string;
  /** Absent when the backend doesn't say. */
  status?: MetricStatus;
  /** Why there are no points, when status is not ok. */
  message?: string;
  points: MetricPoint[];
};

export type GridOverview = {
  /** Absent when the backend doesn't send a time. */
  updatedAt?: string;
  /** Absent when the backend doesn't say. */
  inventorySource?: 'acm' | 'git' | 'demo';
  /** True only for the PoC's browser demo; the BFF always sends false. */
  demo: boolean;
  /** `demo`: simulated, because the backend has no Thanos configured. */
  metricsSource?: 'thanos' | 'demo';
  clusters: GridCluster[];
  metrics: GridMetric[];
};

// The PoC's tenant types (src/app/types/tenants.ts at 62319b8) as organizations,
// with the id the backend assigns and resourceVersion for the PoC's revision.
export type OidcConfig = {
  clientId: string;
  /** Only the name of the Secret holding the client secret; never the secret itself. */
  clientSecretSecret: { name: string };
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  defaultScopes: string;
  userInfoUrl: string;
  jwksUrl: string;
  logoutUrl: string;
  validateSignature: boolean;
};

export type IdentityProvider = { title: string; description: string; enabled: true; config: OidcConfig };

/** `identityProvider` is optional: the backend's Tenants API has none yet. */
export type OrganizationInput = { name: string; domains: string[]; identityProvider?: IdentityProvider };

/**
 * An organization as the pages read it. `identityProvider` is absent for an organization
 * created without one (by another client, or before the backend stored one).
 */
export type Organization = Omit<OrganizationInput, 'identityProvider'> & {
  id: string;
  identityProvider?: IdentityProvider;
  /** Whether members can sign in (Keycloak's `enabled`). */
  status: 'Enabled' | 'Disabled';
  /** Opaque; sent back as If-Match on update and delete. Empty when the backend sends none. */
  resourceVersion: string;
  /** When the backend created it; empty when it doesn't know. */
  creationTimestamp: string;
  description?: string;
  /** Keycloak's organization attributes, for example a billing account. */
  attributes?: Record<string, string>;
  /** Each domain's verification state, when the backend reports it. */
  domainDetails?: { name: string; verified: boolean }[];
};

/**
 * A tenant of GET /api/v1/tenants (the BFF's JSON plus the identity provider, proposal P1).
 * The pages read it through toOrganization.
 */
export type ApiTenant = {
  id: string;
  name: string;
  alias?: string;
  enabled: boolean;
  description?: string;
  domains: string[];
  domainDetails?: { name: string; verified: boolean; identityProviderAlias?: string; autoRedirect: boolean }[];
  attributes?: Record<string, string>;
  resourceVersion?: string;
  createTime?: string;
  identityProvider?: {
    title?: string;
    description?: string;
    /** Absent means true. */
    enabled?: boolean;
    config?: Partial<OidcConfig>;
  };
};

// The PoC's model types (src/app/types/models.ts and MaaSModelRefSummary in
// src/app/types/subscriptions.ts at 62319b8), with resourceVersion for the PoC's revision.
export type ModelReference = { kind: string; name: string };

/** The body of POST /api/v1/models; the PoC's CreateModelRequest. */
export type CreateModelRequest = {
  name: string;
  displayName: string;
  description?: string;
  modelUri: string;
  modelName: string;
  runtimeImage: string;
  replicas: number;
  cpu: string;
  memory: string;
  gpuCount: number;
  runtimeArgs: string[];
  /** The model server's presets (spec.baseRefs); empty for KServe's default. */
  baseRefs: string[];
  locations: string[];
};

/**
 * The body of POST /api/v1/models: the keys of `ModelCreate` (bff/internal/api/models.go)
 * that the wizard sets, and no others. `toModelCreate` in adapters.ts builds it.
 */
export type ApiModelCreate = {
  name: string;
  namespace: string;
  /** `openshift.io/display-name` and `openshift.io/description`. */
  annotations: Record<string, string>;
  modelUri: string;
  modelName: string;
  runtimeImage: string;
  replicas: number;
  cpu: string;
  memory: string;
  gpuCount: number;
  baseRefs: string[];
  env?: EnvVar[];
  placement: ConsolePlacement;
  rollout: { strategy: 'All' };
};

/** A container environment variable, as the BFF's `env` lists them. */
export type EnvVar = { name: string; value: string };

/** The placement the console writes: enrolled, provisioned clusters at the chosen locations. */
export type ConsolePlacement = {
  matchExpressions: { key: string; operator: 'In'; values: string[] }[];
};

/** The Placement spec a model was deployed with, as the BFF returns it; the console writes only some shapes. */
export type ModelPlacementSpec = {
  clusterSets?: string[];
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
  claimExpressions?: { key: string; operator: string; values?: string[] }[];
  tolerations?: unknown[];
  numberOfClusters?: number;
};

/**
 * A change to a deployed model: the fields PATCH /api/v1/models/{namespace}/{name} takes. Each
 * present field replaces the stored one as a whole (`env`, `annotations`), so callers send what
 * they loaded with their change applied.
 */
export type ModelUpdate = {
  replicas?: number;
  runtimeImage?: string;
  env?: EnvVar[];
  placement?: ConsolePlacement;
  annotations?: Record<string, string>;
};

/**
 * A model of GET /api/v1/models (`Model` in bff/internal/api/models.go), limited to the
 * fields the console reads. `toManagedModel` in adapters.ts maps it.
 */
export type ApiModel = {
  name: string;
  namespace: string;
  displayName?: string;
  description?: string;
  modelUri: string;
  modelName: string;
  runtimeImage?: string;
  /** The LLMInferenceServiceConfig presets the model is built on. */
  baseRefs?: string[];
  replicas?: number;
  /** KEDA scaling; when set, `replicas` is absent and the model autoscales. */
  scaling?: unknown;
  /** The main container's requests, quantity strings: cpu, memory, nvidia.com/gpu. */
  requests?: Record<string, string>;
  env?: EnvVar[];
  annotations?: Record<string, string>;
  /** pending, ready, failed or partiallyavailable (P13); absent before the backend reports one. */
  phase?: string;
  reason?: string;
  message?: string;
  /**
   * Absent for a model served on the hub only. `selectedClusters` are the decided ManagedClusters by
   * name; `locations` is proposal P8.
   */
  placement?: ModelPlacementSpec & {
    selectedClusters?: string[];
    locations?: string[];
    /** `PlacementSatisfied`, with its reason and message. */
    satisfied?: boolean;
    reason?: string;
    message?: string;
  };
  /** The ManifestWorkReplicaSet's status: `works` is the model on each decided cluster. */
  rollout?: { works?: ApiModelWork[] };
  resourceVersion?: string;
  creationTimestamp?: string;
};

/** One generated ManifestWork in GET /models: the model on one cluster (docs/plan/bff-api.md). */
export type ApiModelWork = {
  cluster: string;
  applied?: ConditionStatus;
  available?: ConditionStatus;
  progressing?: ConditionStatus;
  degraded?: ConditionStatus;
  feedback?: { ready?: string; url?: string };
  /** The backend's summary for this cluster (P13): pending, ready or failed, and why. */
  phase?: string;
  reason?: string;
  message?: string;
  conditions?: Condition[];
};

/** The model on one cluster, as the Models page lists it under the model. */
export type ModelWork = {
  cluster: string;
  /** Pending, Ready or Failed, as the backend derived it. */
  phase: string;
  reason?: string;
  message?: string;
  /** The spoke's `ready` feedback: True, False, or absent until the agent scrapes it. */
  ready?: string;
  /** The work's Applied, Available, Progressing and Degraded conditions. */
  conditions: Condition[];
};

/** A model deployment: its saved deployment and placement, and the BFF's phase. */
export type ManagedModel = {
  name: string;
  namespace: string;
  displayName?: string;
  description?: string;
  modelRef: ModelReference;
  /** The BFF's phase: Pending, Ready or Failed. */
  phase?: string;
  endpoint?: string;
  status?: string;
  reason?: string;
  statusMessage?: string;
  creationTimestamp?: string;
  /** Opaque; sent back as If-Match on delete. */
  resourceVersion: string;
  /** The `location` labels of the clusters the placement decided on; empty without one. */
  locations: string[];
  /**
   * The clusters the placement decided on, by ManagedCluster name (`placement.selectedClusters`);
   * empty without one. Unlike `locations`, these name the same clusters on every backend.
   */
  selectedClusters: string[];
  /** The model on each cluster it was sent to; absent for a model served on the hub only. */
  works?: ModelWork[];
  /** Why the placement chose no cluster, when the backend says it isn't satisfied. */
  placementIssue?: { reason?: string; message?: string };
  modelUri?: string;
  modelName?: string;
  runtimeImage?: string;
  replicas?: number;
  /** Whether KEDA scales the model, so it has no fixed replica count. */
  autoscaled?: boolean;
  /** The main container's CPU and memory requests and GPU count, as deployed. */
  cpu?: string;
  memory?: string;
  gpuCount?: number;
  /** The LLMInferenceServiceConfig presets the model is built on; empty for KServe's default. */
  baseRefs: string[];
  env?: EnvVar[];
  /** The annotations as stored; an edit sends them back whole with its changes. */
  annotations?: Record<string, string>;
  /** The Placement spec as deployed; absent for a model served on the hub only. */
  placementSpec?: ModelPlacementSpec;
};

// The MaaS status (mock/research/models-maas.md 3.4-3.6), as the BFF returns it (P12).
export type ConditionStatus = 'True' | 'False' | 'Unknown';
export type Condition = {
  type: string;
  status: ConditionStatus;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
};

/** The group every signed-in user is in, which a subscription warns about. */
export const SYSTEM_AUTHENTICATED_GROUP = 'system:authenticated';
