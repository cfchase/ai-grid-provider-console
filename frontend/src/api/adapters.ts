import type {
  ApiCluster,
  ApiModel,
  ApiModelCreate,
  ApiTenant,
  ClusterState,
  ClusterStatus,
  ConsolePlacement,
  CreateModelRequest,
  EnvVar,
  GridCluster,
  IdentityProvider,
  ManagedModel,
  ModelPlacementSpec,
  ModelWork,
  Organization,
} from './types';

// The one place that turns the BFF's JSON into the types the pages read. It renames
// fields and picks display words; anything the backend should decide stays there.

const availability: Record<string, ClusterStatus> = { ready: 'Ready', offline: 'Offline' };

const states: Record<string, ClusterState> = {
  pendingimport: 'Pending import',
  importing: 'Importing',
  importfailed: 'Import failed',
  detaching: 'Detaching',
  notaccepted: 'Not accepted',
};

/**
 * Maps a cluster of GET /clusters, PATCH /clusters/{name}, or GET /grid/overview to the
 * PoC's GridCluster. Ready and offline keep their words; every other ACM state, and a
 * cluster without one, is Unknown, with the ACM word in `state`.
 */
export const toGridCluster = (json: ApiCluster): GridCluster => ({
  name: json.name,
  status: availability[json.status ?? ''] ?? 'Unknown',
  state: states[json.status ?? ''],
  statusMessage: json.statusMessage,
  aiGridEnabled: json.aiGridEnabled,
  provisioned: json.provisioned,
  // Membership first: right after Remove the hub can still report the cluster
  // provisioned until its ready Policy lets go of it.
  provisioningStatus: !json.aiGridEnabled ? 'Not provisioned' : json.provisioned ? 'Provisioned' : 'Provisioning',
  location: json.location,
  site: json.site,
  region: json.region,
  siteName: json.siteName,
  latitude: json.latitude,
  longitude: json.longitude,
  openshiftVersion: json.openshiftVersion,
  consoleUrl: json.consoleUrl,
  kubernetesVersion: json.kubernetesVersion,
  platform: json.platform,
  product: json.product,
  capacity: json.capacity,
  gpuCapacity: json.gpuCapacity,
  allocatable: json.allocatable,
  gpus: json.gpus,
  creationTimestamp: json.creationTimestamp,
  addons: json.addons ?? {},
  conditions: json.conditions ?? [],
  resourceVersion: json.resourceVersion,
  labels: json.labels ?? {},
});

const toIdentityProvider = (json: NonNullable<ApiTenant['identityProvider']>): IdentityProvider => {
  const config = json.config ?? {};
  return {
    title: json.title ?? '',
    description: json.description ?? '',
    // The backend refuses a disabled identity provider, as the PoC does.
    enabled: true,
    config: {
      clientId: config.clientId ?? '',
      clientSecretSecret: { name: config.clientSecretSecret?.name ?? '' },
      issuer: config.issuer ?? '',
      authorizationUrl: config.authorizationUrl ?? '',
      tokenUrl: config.tokenUrl ?? '',
      defaultScopes: config.defaultScopes ?? '',
      userInfoUrl: config.userInfoUrl ?? '',
      jwksUrl: config.jwksUrl ?? '',
      logoutUrl: config.logoutUrl ?? '',
      validateSignature: config.validateSignature ?? true,
    },
  };
};

/**
 * Maps a tenant of GET/POST/PATCH /tenants to the PoC's organization: "Enabled" or "Disabled" from
 * `enabled`, and the backend's version and creation time, empty when it sends none.
 */
export const toOrganization = (json: ApiTenant): Organization => {
  const out: Organization = {
    id: json.id,
    name: json.name,
    domains: json.domains ?? [],
    status: json.enabled ? 'Enabled' : 'Disabled',
    resourceVersion: json.resourceVersion ?? '',
    creationTimestamp: json.createTime ?? '',
  };
  if (json.description) {
    out.description = json.description;
  }
  if (json.attributes && Object.keys(json.attributes).length) {
    out.attributes = json.attributes;
  }
  if (json.domainDetails?.length) {
    out.domainDetails = json.domainDetails.map(({ name, verified }) => ({ name, verified }));
  }
  if (json.identityProvider) {
    out.identityProvider = toIdentityProvider(json.identityProvider);
  }
  return out;
};

const modelPhases: Record<string, string> = {
  pending: 'Pending',
  ready: 'Ready',
  failed: 'Failed',
  partiallyavailable: 'Partially available',
};

const phaseOf = (phase: string | undefined) => (phase ? (modelPhases[phase] ?? phase) : 'Pending');

/** The backend's reason for a model in git mode, where it reports no phase. */
const SAVED_TO_GIT_REASON = 'SavedToGit';

/** A model's phase: Saved to Git when the backend saved it to Git and reports no phase. */
const modelPhaseOf = (phase: string | undefined, reason: string | undefined) =>
  !phase && reason === SAVED_TO_GIT_REASON ? 'Saved to Git' : phaseOf(phase);

/**
 * Maps a model of GET/POST /models to the PoC's ManagedModel. Status is the BFF's phase (Pending
 * before the backend reports one, Saved to Git when the backend saved it to Git); locations are the placement's decided locations (P8).
 */
export const toManagedModel = (json: ApiModel): ManagedModel => ({
  name: json.name,
  namespace: json.namespace,
  displayName: json.displayName,
  description: json.description,
  modelRef: { kind: 'LLMInferenceService', name: json.name },
  phase: modelPhaseOf(json.phase, json.reason),
  reason: json.reason,
  statusMessage: json.message,
  creationTimestamp: json.creationTimestamp,
  resourceVersion: json.resourceVersion ?? '',
  locations: json.placement?.locations ?? [],
  selectedClusters: json.placement?.selectedClusters ?? [],
  ...(json.placement?.satisfied === false && (json.placement.reason || json.placement.message)
    ? { placementIssue: { reason: json.placement.reason, message: json.placement.message } }
    : {}),
  works: json.rollout?.works?.map((work): ModelWork => ({
    cluster: work.cluster,
    phase: phaseOf(work.phase),
    reason: work.reason,
    message: work.message,
    ready: work.feedback?.ready,
    conditions: work.conditions ?? [],
  })),
  modelUri: json.modelUri,
  modelName: json.modelName,
  runtimeImage: json.runtimeImage,
  baseRefs: json.baseRefs ?? [],
  replicas: json.replicas,
  autoscaled: json.scaling !== undefined && json.scaling !== null,
  cpu: json.requests?.cpu,
  memory: json.requests?.memory,
  gpuCount: json.requests?.['nvidia.com/gpu'] !== undefined ? Number(json.requests['nvidia.com/gpu']) : undefined,
  env: json.env ?? [],
  annotations: json.annotations ?? {},
  placementSpec: json.placement ? placementSpecOf(json.placement) : undefined,
});

/** The spec part of a placement the BFF returned, without its decisions and status. */
const placementSpecOf = ({
  clusterSets,
  matchLabels,
  matchExpressions,
  claimExpressions,
  tolerations,
  numberOfClusters,
}: ModelPlacementSpec): ModelPlacementSpec => ({
  ...(clusterSets?.length ? { clusterSets } : {}),
  ...(matchLabels && Object.keys(matchLabels).length ? { matchLabels } : {}),
  ...(matchExpressions?.length ? { matchExpressions } : {}),
  ...(claimExpressions?.length ? { claimExpressions } : {}),
  ...(tolerations?.length ? { tolerations } : {}),
  ...(numberOfClusters !== undefined ? { numberOfClusters } : {}),
});

/**
 * The placement the console writes for a set of clusters: `name In [...]` over ManagedCluster
 * names, the backend's own placement (its models_service.proto, ListPlacementClusters). GET
 * /locations answers the names it takes.
 */
export const consolePlacement = (clusters: string[]): ConsolePlacement => ({
  matchExpressions: [{ key: 'name', operator: 'In', values: [...clusters] }],
});

/**
 * The clusters of a placement the console wrote, or undefined for any other shape (cluster
 * sets, other selectors, a hub-only model). Only the console's own shape can be edited in the
 * wizard without changing what else the placement selects.
 */
export const consolePlacementLocations = (spec: ModelPlacementSpec | undefined): string[] | undefined => {
  if (!spec) return undefined;
  const {
    clusterSets,
    matchLabels = {},
    matchExpressions = [],
    claimExpressions,
    tolerations,
    numberOfClusters,
  } = spec;
  const [expression, ...others] = matchExpressions;
  if (
    clusterSets?.length ||
    claimExpressions?.length ||
    tolerations?.length ||
    numberOfClusters !== undefined ||
    Object.keys(matchLabels).length > 0 ||
    others.length > 0 ||
    expression?.key !== 'name' ||
    expression.operator !== 'In'
  ) {
    return undefined;
  }
  return [...(expression.values ?? [])];
};

/** The variable the console passes vLLM's extra arguments in (the PoC's deploymentResources). */
export const RUNTIME_ARGS_ENV = 'VLLM_ADDITIONAL_ARGS';

/**
 * The runtime arguments a model's env carries, one per flag as the wizard shows them. The wizard
 * joins its lines with spaces, so the value is cut before each flag (`-x`, `--x`) that starts
 * after whitespace outside quotes; each piece keeps its own text, so a flag's value
 * (`--max-model-len 4096`) and a quoted value (`--name "a  --b"`) survive an edit unchanged.
 */
export const runtimeArgsOf = (env: EnvVar[] | undefined): string[] => {
  const value = env?.find((v) => v.name === RUNTIME_ARGS_ENV)?.value ?? '';
  const args: string[] = [];
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c) && /^\s+--?[A-Za-z]/.test(value.slice(i))) {
      args.push(value.slice(start, i));
      start = i + value.slice(i).search(/\S/);
      i = start - 1;
    }
  }
  args.push(value.slice(start));
  return args.map((arg) => arg.trim()).filter(Boolean);
};

/** The env with its runtime arguments replaced, keeping every other variable in place. */
export const withRuntimeArgs = (env: EnvVar[] | undefined, args: string[]): EnvVar[] => {
  const others = (env ?? []).filter((v) => v.name !== RUNTIME_ARGS_ENV);
  return args.length > 0 ? [...others, { name: RUNTIME_ARGS_ENV, value: args.join(' ') }] : others;
};

/**
 * The wizard's input as the BFF's POST /models body, with only the keys the PoC writes. The
 * Placement is the PoC's (backend/placements.mjs): enrolled, provisioned clusters at the chosen
 * locations, rolled out to all at once. Runtime arguments go in VLLM_ADDITIONAL_ARGS, as the
 * PoC's deployment does (backend/models.mjs deploymentResources).
 */
export const toModelCreate = (input: CreateModelRequest, namespace: string): ApiModelCreate => ({
  name: input.name,
  namespace,
  // The BFF takes the display name and description as annotations, as on PATCH; empty ones are left out.
  annotations: {
    ...(input.displayName ? { 'openshift.io/display-name': input.displayName } : {}),
    ...(input.description ? { 'openshift.io/description': input.description } : {}),
  },
  modelUri: input.modelUri,
  modelName: input.modelName,
  runtimeImage: input.runtimeImage,
  replicas: input.replicas,
  cpu: input.cpu,
  memory: input.memory,
  gpuCount: input.gpuCount,
  baseRefs: input.baseRefs,
  ...(input.runtimeArgs.length > 0 ? { env: withRuntimeArgs([], input.runtimeArgs) } : {}),
  placement: consolePlacement(input.locations),
  rollout: { strategy: 'All' },
});
