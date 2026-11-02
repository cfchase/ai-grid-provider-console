// What the Models pages, the AI Grid map and Monitoring show of a Model from the backend's Models
// API (ai_grid.v1, read over Connect): a thin selector layer over the generated message (ADR-0002),
// as clusterView.ts is for clusters. Each field reads one documented field or key and words it; the
// backend decides the phase, the clusters the placement chose, and each placed cluster's status
// (ModelStatus in the backend's proto/ai_grid/v1/model_type.proto).
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { ModelPhase, type Model, type ModelEnvVar, type ModelSpec } from '../../gen/ai_grid/v1/model_type_pb';

/** The annotations the backend documents for a model's display name and description. */
export const DISPLAY_NAME = 'openshift.io/display-name';
export const DESCRIPTION = 'openshift.io/description';

/** The display name an object's annotations give it, if they give one (a model's, a subscription's). */
export const displayNameAnnotation = (annotations: { [key: string]: string } | undefined): string | undefined =>
  annotations?.[DISPLAY_NAME] || undefined;

/** The name a page shows for a backend object: its display name annotation, else its id. */
export const displayNameOf = (object: { id: string; metadata?: { annotations: { [key: string]: string } } }) =>
  displayNameAnnotation(object.metadata?.annotations) ?? object.id;

/** The main container's request keys the console reads and writes. */
const REQUEST_CPU = 'cpu';
const REQUEST_MEMORY = 'memory';
export const REQUEST_GPU = 'nvidia.com/gpu';

/** The reason the backend gives a model it saved to Git that no cluster has reported yet. */
const SAVED_TO_GIT = 'SavedToGit';

/** A model's phase as the pages word it. */
export type ModelPhaseWord = 'Ready' | 'Pending' | 'Failed' | 'Partially available' | 'Saved to Git' | 'Unknown';

/** The model on one cluster its placement names, as the backend reports it (`status.clusters`). */
export type ModelClusterView = {
  cluster: string;
  /** Ready or Pending: the backend gives a placed cluster no other phase in git mode. */
  phase: ModelPhaseWord;
  /** Ready, NotReady or NoReport. */
  reason: string;
  /** What the cluster reported, for example "LLMInferenceService not ready". */
  message?: string;
};

/** A Model as the pages show it. */
export type ModelView = {
  /** The model's id, which is also its metadata.name and the page's URL. */
  id: string;
  displayName?: string;
  description?: string;
  /** The name clients send in the request's model field (spec.model.name). */
  modelName?: string;
  modelUri?: string;
  runtimeImage?: string;
  /** The LLMInferenceServiceConfig presets the model is built on; empty for KServe's default. */
  baseRefs: string[];
  /**
   * The HardwareProfile the model runs with (spec.hardware_profile): its node selector and
   * tolerations on each cluster, and the range its resources were chosen from.
   */
  hardwareProfile?: string;
  replicas?: number;
  /** KEDA scales the model (spec.scaling), so it has no fixed replica count. */
  autoscaled: boolean;
  cpu?: string;
  memory?: string;
  gpuCount?: number;
  env: ModelEnvVar[];
  /** The annotations as read, sent back whole by an edit. */
  annotations: Record<string, string>;
  phase: ModelPhaseWord;
  reason?: string;
  statusMessage?: string;
  /** status.url: the external URL, when the backend knows it. */
  url?: string;
  creationTimestamp?: string;
  /** metadata.version, sent back with `lock` by an edit and with a delete. */
  version: number;
  /** The `location` labels of the clusters the placement chose (status.placement.locations). */
  locations: string[];
  /** The clusters the placement chose, by name (status.placement.selected_clusters). */
  selectedClusters: string[];
  /** Each placed cluster's status; empty while no cluster has reported the model. */
  clusters: ModelClusterView[];
  /**
   * The clusters a `name In [...]` placement names, the only shape the console edits; undefined
   * for a model without a placement or with any other one.
   */
  placementClusters?: string[];
  /** Whether the model has a placement at all. */
  placed: boolean;
};

const phaseWords: Record<ModelPhase, ModelPhaseWord> = {
  [ModelPhase.UNSPECIFIED]: 'Unknown',
  [ModelPhase.PENDING]: 'Pending',
  [ModelPhase.READY]: 'Ready',
  [ModelPhase.FAILED]: 'Failed',
  [ModelPhase.PARTIALLY_AVAILABLE]: 'Partially available',
};

/**
 * The phase in words. The backend leaves the phase unspecified with reason SavedToGit while no
 * cluster has reported the model; any other unspecified phase, or a value newer than the pin, is
 * Unknown.
 */
export const phaseWordOf = (phase: ModelPhase | undefined, reason?: string): ModelPhaseWord =>
  phase === ModelPhase.UNSPECIFIED && reason === SAVED_TO_GIT
    ? 'Saved to Git'
    : (phaseWords[phase ?? ModelPhase.UNSPECIFIED] ?? 'Unknown');

/**
 * The clusters of a placement that names clusters by `name In [...]` and nothing else, the shape
 * the backend's git mode takes (ModelSpec.placement); undefined for any other shape.
 */
export const placementClustersOf = (spec: ModelSpec | undefined): string[] | undefined => {
  const placement = spec?.placement;
  if (!placement) return undefined;
  const selector = placement.labelSelector;
  const expressions = selector?.matchExpressions ?? [];
  const [expression, ...others] = expressions;
  if (
    placement.clusterSets.length > 0 ||
    placement.numberOfClusters !== undefined ||
    Object.keys(selector?.matchLabels ?? {}).length > 0 ||
    others.length > 0 ||
    expression?.key !== 'name' ||
    expression.operator !== 'In'
  ) {
    return undefined;
  }
  return [...expression.values];
};

const nonEmpty = (value: string | undefined) => (value ? value : undefined);

export const toModelView = (model: Model): ModelView => {
  const annotations = model.metadata?.annotations ?? {};
  const spec = model.spec;
  const requests = spec?.main?.requests ?? {};
  const status = model.status;
  // The model's accelerator count: nvidia.com/gpu, or another extended resource such as
  // amd.com/gpu (cpu, memory and the other built-in resources have no "/").
  const gpu = requests[REQUEST_GPU] ?? Object.entries(requests).find(([key]) => key.includes('/'))?.[1];
  const created = model.metadata?.creationTimestamp;
  return {
    id: model.id,
    displayName: displayNameAnnotation(annotations),
    description: nonEmpty(annotations[DESCRIPTION]),
    modelName: nonEmpty(spec?.model?.name),
    modelUri: nonEmpty(spec?.model?.uri),
    runtimeImage: nonEmpty(spec?.main?.image),
    baseRefs: [...(spec?.baseRefs ?? [])],
    hardwareProfile: nonEmpty(spec?.hardwareProfile?.name),
    replicas: spec?.replicas,
    autoscaled: spec?.scaling !== undefined,
    cpu: nonEmpty(requests[REQUEST_CPU]),
    memory: nonEmpty(requests[REQUEST_MEMORY]),
    gpuCount: gpu !== undefined && /^\d+$/.test(gpu) ? Number(gpu) : undefined,
    env: [...(spec?.main?.env ?? [])],
    annotations: { ...annotations },
    phase: phaseWordOf(status?.phase, status?.reason),
    reason: nonEmpty(status?.reason),
    statusMessage: nonEmpty(status?.message),
    url: nonEmpty(status?.url),
    creationTimestamp: created ? timestampDate(created).toISOString() : undefined,
    version: model.metadata?.version ?? 0,
    locations: [...(status?.placement?.locations ?? [])],
    selectedClusters: [...(status?.placement?.selectedClusters ?? [])],
    clusters: (status?.clusters ?? []).map((c) => ({
      cluster: c.cluster,
      phase: phaseWordOf(c.phase, c.reason),
      reason: c.reason,
      message: nonEmpty(c.message),
    })),
    placementClusters: placementClustersOf(spec),
    placed: spec?.placement !== undefined,
  };
};

/**
 * The name a model still serves instead of its id, for one saved before the backend served every
 * model as its id; undefined for any other model. The backend reports the name a model serves
 * (spec.model.name) and switches it to the id on the model's next update.
 */
export const olderServedNameOf = (model: Pick<ModelView, 'id' | 'modelName'>): string | undefined =>
  model.modelName && model.modelName !== model.id ? model.modelName : undefined;

/** The name a page shows for the model: its display name, else its id. */
export const titleOf = (model: Pick<ModelView, 'id' | 'displayName'>) => model.displayName ?? model.id;
