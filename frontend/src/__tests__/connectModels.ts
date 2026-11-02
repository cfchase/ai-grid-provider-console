// The backend's Models API for page tests, in the generated messages (fakeClients serializes them as
// JSON): List, Get, Create, Update and Delete over an in-memory list, with the backend's rules the
// pages show (models_git.go and models_server.go at the pin): AlreadyExists, NotFound, Aborted on a
// stale version, FailedPrecondition while a subscription uses the model, InvalidArgument for a
// placement naming a cluster ListPlacementClusters doesn't offer and for a served name
// (spec.model.name) other than empty or the id, and an update that switches a model still served
// under another name to its id (normalizeServedName, servedNameOnUpdate). Subscriptions/List answers the
// subscriptions whose refs name a model (SubscriptionModelRef.model_id), for the delete dialog.
import { clone, create, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import type { FakeBackend } from '../api/connect/testing';
import {
  ModelsListServingOptionsResponseSchema,
  type ModelsListServingOptionsResponse,
} from '../gen/ai_grid/v1/models_service_pb';
import type { GridCluster } from '../api/types';
import { MetadataSchema } from '../gen/ai_grid/v1/metadata_type_pb';
import {
  ModelClusterStatusSchema,
  ModelContainerSchema,
  ModelPhase,
  ModelPlacementStatusSchema,
  ModelSchema,
  ModelStatusSchema,
  ModelSpecSchema,
  type Model,
} from '../gen/ai_grid/v1/model_type_pb';
import { SubscriptionSchema, type Subscription } from '../gen/ai_grid/v1/subscription_type_pb';

/** The clusters ListPlacementClusters offers: Ready, provisioned members that serve models. */
const placeableClustersOf = (clusters: GridCluster[]) =>
  [
    ...new Set(
      clusters
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

/** A model as the backend answers it; the fields a test leaves out are the backend's defaults. */
export const modelObject = (init: MessageInitShape<typeof ModelSchema>): Model => create(ModelSchema, init);

/** The clusters a `name In [...]` placement names. */
const namedClusters = (model: Model) =>
  model.spec?.placement?.labelSelector?.matchExpressions.find((e) => e.key === 'name' && e.operator === 'In')?.values ??
  [];

/**
 * The seed models (the PoC's catalog models): granite-3-8b placed on site1 and ready there,
 * llama-3-70b without a placement, granite-research still starting.
 */
export const seedModelObjects = (): Model[] =>
  (
    [
      ['granite-3-8b', 'Granite 3.3 8B Instruct', 'Enterprise language model', ModelPhase.READY, ['site1']],
      ['llama-3-70b', 'Llama 3.3 70B Instruct', 'General purpose language model', ModelPhase.READY, []],
      ['granite-research', 'Granite research endpoint', undefined, ModelPhase.PENDING, []],
    ] as [string, string, string | undefined, ModelPhase, string[]][]
  ).map(([id, displayName, description, phase, clusters]) =>
    modelObject({
      id,
      metadata: {
        name: id,
        version: 1,
        annotations: {
          'openshift.io/display-name': displayName,
          ...(description ? { 'openshift.io/description': description } : {}),
        },
      },
      spec: {
        // Served as its id, as the backend serves a model (ModelSource.name defaults to the id).
        model: { uri: `hf://example-org/${id}`, name: id },
        replicas: 1,
        baseRefs: ['v3-6-0-kserve-config-llm-template-cpu'],
        main: { image: 'quay.io/example/vllm:v1', requests: { cpu: '2', memory: '4Gi' } },
        ...(clusters.length
          ? { placement: { labelSelector: { matchExpressions: [{ key: 'name', operator: 'In', values: clusters }] } } }
          : {}),
      },
      status: {
        phase,
        ...(id === 'granite-research'
          ? { reason: 'ModelNotReady', message: 'The model endpoint is starting.' }
          : { reason: 'Ready' }),
        // The seed clusters' location label is their name.
        placement: { selectedClusters: clusters, locations: clusters, numberOfSelectedClusters: clusters.length },
        clusters: clusters.map((cluster) => ({
          cluster,
          phase,
          reason: 'Ready',
          message: 'LLMInferenceService ready',
        })),
      },
    }),
  );

/** A subscription whose refs name these models, as the backend joins them (model_id). */
export const subscriptionUsing = (id: string, modelIds: string[], displayName?: string): Subscription =>
  create(SubscriptionSchema, {
    id,
    metadata: { name: id, version: 1, annotations: displayName ? { 'openshift.io/display-name': displayName } : {} },
    spec: { modelRefs: modelIds.map((m) => ({ name: m, modelId: m, unlimited: true })) },
  });

/** The model id a ModelReferences filter asks for (useModels.ts, usingModelFilter). */
const filteredModelId = (filter: string | undefined) => /r\.model_id == "([^"]+)"/.exec(filter ?? '')?.[1];

type Impl = Required<
  Pick<
    NonNullable<FakeBackend['models']>,
    'list' | 'get' | 'listPlacementClusters' | 'listServingOptions' | 'create' | 'update' | 'delete'
  >
>;

/** The in-memory Models backend, over a service's clusters (for the placement's locations). */
export class FakeModels {
  models: Model[] = seedModelObjects();
  subscriptions: Subscription[] = [];

  constructor(private readonly source: { clusters: GridCluster[] }) {}

  /** Models/ListPlacementClusters; a test replaces it to change what the wizard offers. */
  placementClusters = async (): Promise<string[]> => placeableClustersOf(this.source.clusters);

  /**
   * Models/ListServingOptions: a CPU and an NVIDIA preset and the default profile, from the chart's
   * defaults (charts/ai-grid-provider-console/values.yaml); a test replaces it to offer others.
   */
  servingOptions: ModelsListServingOptionsResponse = create(ModelsListServingOptionsResponseSchema, {
    modelServers: [
      {
        name: 'v3-6-0-kserve-config-llm-template-cpu',
        displayName: 'vLLM CPU',
        description: 'vLLM on x86_64 CPU-only nodes.',
        accelerators: [],
      },
      {
        name: 'v3-6-0-kserve-config-llm-single-node-template-nvidia-cuda',
        displayName: 'vLLM NVIDIA GPU',
        description: 'vLLM with NVIDIA CUDA GPUs, on one node.',
        accelerators: ['nvidia.com/gpu'],
      },
    ],
    hardwareProfiles: [
      {
        name: 'default-profile',
        namespace: 'redhat-ods-applications',
        displayName: 'Default profile',
        description: 'Starts at 2 CPUs and 4 GiB of memory.',
        identifiers: [
          { identifier: 'cpu', displayName: 'CPU', minCount: '1', defaultCount: '2', maxCount: '4' },
          { identifier: 'memory', displayName: 'Memory', minCount: '2Gi', defaultCount: '4Gi', maxCount: '8Gi' },
        ],
      },
    ],
  });

  find = (id: string): Model => {
    const model = this.models.find((m) => m.id === id);
    if (!model) throw new ConnectError(`Model "${id}" not found`, Code.NotFound);
    return model;
  };

  /** The placement's status, as the backend reports it before any cluster has. */
  private placed(model: Model): Model {
    const clusters = [...namedClusters(model)].sort();
    const locations = [
      ...new Set(
        this.source.clusters.filter((c) => clusters.includes(c.name) && c.location).map((c) => c.location as string),
      ),
    ].sort();
    const out = clone(ModelSchema, model);
    out.status ??= create(ModelStatusSchema);
    out.status.placement = create(ModelPlacementStatusSchema, {
      selectedClusters: clusters,
      locations,
      numberOfSelectedClusters: clusters.length,
    });
    // Once a cluster has reported, every placed cluster has an entry: a new one hasn't reported yet
    // (models_git.go, modelReports.apply).
    if (out.status.clusters.length > 0) {
      out.status.clusters = clusters.map(
        (cluster) =>
          out.status!.clusters.find((c) => c.cluster === cluster) ??
          create(ModelClusterStatusSchema, {
            cluster,
            phase: ModelPhase.PENDING,
            reason: 'NoReport',
            message: 'No LLMInferenceService report',
          }),
      );
    }
    return out;
  }

  private async checkPlacement(model: Model) {
    const offered = await this.placementClusters();
    const unknown = namedClusters(model).filter((c) => !offered.includes(c));
    if (unknown.length) {
      throw new ConnectError(
        `spec.placement: cluster "${unknown[0]}" is not a placement cluster`,
        Code.InvalidArgument,
      );
    }
  }

  // The RPCs, each a field a test can spy on or replace (vi.spyOn(modelsOf(service), 'update')).
  list: Impl['list'] = ({ filter }) => {
    // The subscription pages' filter on model ids (useSubscriptions.ts, modelsFilter).
    const ids = /^this\.id in \[(.*)\]$/.exec(filter ?? '')?.[1];
    const wanted = ids === undefined ? undefined : [...ids.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const items = this.models.filter((m) => !wanted || wanted.includes(m.id)).sort((a, b) => a.id.localeCompare(b.id));
    return { items, size: items.length, total: items.length };
  };
  get: Impl['get'] = ({ id }) => ({ object: this.find(id) });
  listPlacementClusters: Impl['listPlacementClusters'] = async () => ({ clusters: await this.placementClusters() });
  listServingOptions: Impl['listServingOptions'] = () => this.servingOptions;
  create: Impl['create'] = async ({ object }) => {
    const id = object?.id ?? '';
    if (this.models.some((m) => m.id === id)) {
      throw new ConnectError(`Model "${id}" already exists`, Code.AlreadyExists);
    }
    const model = object ? clone(ModelSchema, object) : create(ModelSchema);
    model.id = id;
    // The served name is the id: empty becomes it, any other name is refused (ModelSource.name).
    const served = model.spec?.model?.name;
    if (served && served !== id) {
      throw new ConnectError(`spec.model.name "${served}" must be empty or the model id "${id}"`, Code.InvalidArgument);
    }
    if (model.spec?.model) model.spec.model.name = id;
    await this.checkPlacement(model);
    model.metadata = create(MetadataSchema, {
      name: id,
      version: 1,
      annotations: { ...model.metadata?.annotations },
      creationTimestamp: timestampFromDate(new Date()),
    });
    model.status = create(ModelStatusSchema, { phase: ModelPhase.UNSPECIFIED, reason: 'SavedToGit' });
    const saved = this.placed(model);
    this.models.push(saved);
    return { object: saved };
  };
  update: Impl['update'] = async ({ object, updateMask, lock }) => {
    const id = object?.id ?? '';
    const current = this.find(id);
    if (lock && object?.metadata?.version !== current.metadata?.version) {
      throw new ConnectError(
        `update Model "${id}": the model changed since it was read; reload and retry`,
        Code.Aborted,
      );
    }
    const paths = updateMask?.paths ?? [];
    if (paths.length === 0) throw new ConnectError('update_mask: name at least one path', Code.InvalidArgument);
    const next = clone(ModelSchema, current);
    next.metadata ??= create(MetadataSchema);
    next.spec ??= create(ModelSpecSchema);
    const spec = next.spec;
    for (const path of paths) {
      switch (path) {
        case 'metadata.annotations':
          next.metadata.annotations = { ...object?.metadata?.annotations };
          break;
        case 'spec.replicas':
          spec.replicas = object?.spec?.replicas;
          spec.scaling = undefined;
          break;
        case 'spec.main.image':
          spec.main ??= create(ModelContainerSchema);
          spec.main.image = object?.spec?.main?.image ?? '';
          break;
        case 'spec.main.env':
          spec.main ??= create(ModelContainerSchema);
          spec.main.env = [...(object?.spec?.main?.env ?? [])];
          break;
        case 'spec.placement':
          spec.placement = object?.spec?.placement;
          break;
        default:
          throw new ConnectError(`update_mask: unsupported path "${path}"`, Code.InvalidArgument);
      }
    }
    if (paths.includes('spec.placement')) await this.checkPlacement(next);
    // Any update serves a model under its id from then on, one saved under another name too.
    if (spec.model) spec.model.name = id;
    next.metadata.version = (current.metadata?.version ?? 0) + 1;
    const saved = paths.includes('spec.placement') ? this.placed(next) : next;
    this.models = this.models.map((m) => (m.id === id ? saved : m));
    return { object: saved };
  };
  delete: Impl['delete'] = ({ id, resourceVersion }) => {
    const current = this.find(id);
    if (resourceVersion !== 0 && resourceVersion !== current.metadata?.version) {
      throw new ConnectError(
        `delete Model "${id}": the model changed since it was read; reload and retry`,
        Code.Aborted,
      );
    }
    const user = this.subscriptions.find((s) => s.spec?.modelRefs.some((r) => r.modelId === id));
    if (user) {
      throw new ConnectError(`Model "${id}" is referenced by Subscription "${user.id}"`, Code.FailedPrecondition);
    }
    this.models = this.models.filter((m) => m.id !== id);
    return {};
  };

  backend = (): Impl => ({
    list: (req, ctx) => this.list(req, ctx),
    get: (req, ctx) => this.get(req, ctx),
    listPlacementClusters: (req, ctx) => this.listPlacementClusters(req, ctx),
    listServingOptions: (req, ctx) => this.listServingOptions(req, ctx),
    create: (req, ctx) => this.create(req, ctx),
    update: (req, ctx) => this.update(req, ctx),
    delete: (req, ctx) => this.delete(req, ctx),
  });

  /** Subscriptions/List as ModelReferences asks it: the subscriptions with a ref to one model. */
  listSubscriptions: NonNullable<NonNullable<FakeBackend['subscriptions']>['list']> = ({ filter }) => {
    const id = filteredModelId(filter);
    const items = this.subscriptions.filter((s) => s.spec?.modelRefs.some((r) => id && r.modelId === id));
    return { items, size: items.length, total: items.length };
  };

  subscriptionsBackend = (): NonNullable<FakeBackend['subscriptions']> => ({
    list: (req, ctx) => this.listSubscriptions(req, ctx),
  });
}

const fakes = new WeakMap<object, FakeModels>();

/** The Models backend of a test's service: one per service, so a test reads and changes what its pages see. */
export const modelsOf = (service: { clusters: GridCluster[] }): FakeModels => {
  let fake = fakes.get(service);
  if (!fake) {
    fake = new FakeModels(service);
    fakes.set(service, fake);
  }
  return fake;
};
