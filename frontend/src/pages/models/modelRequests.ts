// What the Deploy model wizard sends: Models/Create with the fields the backend's ModelsCreateRequest
// takes, and Models/Update with only the paths an edit changed (ModelsUpdateRequest.update_mask). A
// new model gets the inference scheduler and a managed route, as the console's models always have:
// the backend defaults the scheduler to off, and without it KServe makes no InferencePool or
// endpoint picker, so the model's route has no backend. The gateway is the backend's default (an
// empty gateway_refs), and a GPU request is also saved as its limit by the backend
// (ModelContainer.requests).
import type { MessageInitShape } from '@bufbuild/protobuf';
import type { ModelsCreateRequestSchema, ModelsUpdateRequestSchema } from '../../gen/ai_grid/v1/models_service_pb';
import type { ModelEnvVarSchema, ModelPlacementSchema } from '../../gen/ai_grid/v1/model_type_pb';
import { runtimeArgsOf, withRuntimeArgs } from './fields/runtimeArgs';
import { DESCRIPTION, DISPLAY_NAME, REQUEST_GPU, type ModelView } from './modelView';

type PlacementInit = MessageInitShape<typeof ModelPlacementSchema>;
type EnvInit = MessageInitShape<typeof ModelEnvVarSchema>;

/** The wizard's fields. */
export type ModelInput = {
  /** The model's id, which is also its metadata.name. */
  name: string;
  displayName: string;
  description?: string;
  modelUri: string;
  runtimeImage: string;
  replicas: number;
  cpu: string;
  memory: string;
  gpuCount: number;
  runtimeArgs: string[];
  /** The model server's presets (spec.base_refs); empty for KServe's default. */
  baseRefs: string[];
  /**
   * The HardwareProfile to run with (spec.hardware_profile). Its defaults filled cpu, memory and
   * gpuCount, which are sent as the container's requests and limits, as the OpenShift AI dashboard
   * does: the cluster's webhook then adds nothing to them.
   */
  hardwareProfile?: string;
  /** The resource gpuCount asks for: the model server's accelerator. Default nvidia.com/gpu. */
  gpuResource?: string;
  /**
   * The clusters to place the model on, by name, from Models/ListPlacementClusters; not
   * `location` labels, which status.placement.locations reports.
   */
  clusters: string[];
};

/** The placement the console writes: `name In [...]`, the shape git mode takes (ModelSpec.placement). */
export const namedPlacement = (clusters: string[]): PlacementInit => ({
  labelSelector: { matchExpressions: [{ key: 'name', operator: 'In', values: [...clusters] }] },
});

/** The main container's requests the wizard sets; a GPU count of 0 asks for none. */
const requestsOf = (input: ModelInput): Record<string, string> => ({
  ...(input.cpu ? { cpu: input.cpu } : {}),
  ...(input.memory ? { memory: input.memory } : {}),
  ...(input.gpuCount > 0 ? { [input.gpuResource ?? REQUEST_GPU]: String(input.gpuCount) } : {}),
});

/**
 * With a hardware profile, the limits equal the requests, as the OpenShift AI dashboard sends them
 * (the profile's webhook would also set each missing limit to its request). Without one, only
 * requests, as before.
 */
const limitsOf = (input: ModelInput): Record<string, string> => (input.hardwareProfile ? requestsOf(input) : {});

export const createRequestOf = (input: ModelInput): MessageInitShape<typeof ModelsCreateRequestSchema> => {
  const displayName = input.displayName.trim();
  return {
    object: {
      id: input.name,
      metadata: {
        name: input.name,
        // Empty ones are left out, as the backend documents the annotations (UI_API_REFERENCE.md).
        annotations: {
          ...(displayName ? { [DISPLAY_NAME]: displayName } : {}),
          ...(input.description ? { [DESCRIPTION]: input.description } : {}),
        },
      },
      spec: {
        // No served name: the backend serves a model as its id, the name users send
        // (ModelSource.name defaults to the id).
        model: { uri: input.modelUri },
        replicas: input.replicas,
        baseRefs: [...input.baseRefs],
        ...(input.hardwareProfile ? { hardwareProfile: { name: input.hardwareProfile } } : {}),
        main: {
          image: input.runtimeImage.trim(),
          requests: requestsOf(input),
          limits: limitsOf(input),
          env: withRuntimeArgs([], input.runtimeArgs),
        },
        // Both set: with the scheduler on, the backend takes managed_route as sent (modelRouterToMap).
        router: { scheduler: true, managedRoute: true },
        placement: namedPlacement(input.clusters),
      },
    },
  };
};

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((value, i) => value === b[i]);
export const sameSet = (a: string[], b: string[]) => sameList([...a].sort(), [...b].sort());

/** The model's replica count as the wizard starts from it: 1 when it has none stored. */
export const DEFAULT_REPLICAS = 1;

/**
 * An edit as Models/Update: only the fields the wizard changed, each a path of the mask, at the
 * version the page read (`lock`). The env and the annotations are whole fields on the wire, so they
 * go back as loaded with the change applied; undefined when nothing changed.
 */
export const updateRequestOf = (
  model: ModelView,
  input: ModelInput,
): MessageInitShape<typeof ModelsUpdateRequestSchema> | undefined => {
  const paths: string[] = [];
  const spec: { replicas?: number; main?: { image?: string; env?: EnvInit[] }; placement?: PlacementInit } = {};
  let annotations: Record<string, string> | undefined;
  // A model stored without a count shows the default; only a count the user changed is sent.
  if (!model.autoscaled && input.replicas !== (model.replicas ?? DEFAULT_REPLICAS)) {
    spec.replicas = input.replicas;
    paths.push('spec.replicas');
  }
  const image = input.runtimeImage.trim();
  if (image !== (model.runtimeImage ?? '')) {
    spec.main = { ...spec.main, image };
    paths.push('spec.main.image');
  }
  if (!sameList(input.runtimeArgs, runtimeArgsOf(model.env))) {
    spec.main = { ...spec.main, env: withRuntimeArgs(model.env, input.runtimeArgs) };
    paths.push('spec.main.env');
  }
  const displayName = input.displayName.trim();
  if (displayName !== (model.displayName ?? model.id) || (input.description ?? '') !== (model.description ?? '')) {
    annotations = { ...model.annotations };
    // The name field starts from the id when the model has no display name; keeping that default
    // writes nothing, so a description edit doesn't add an annotation nobody set.
    const hadDisplayName = model.annotations[DISPLAY_NAME] !== undefined;
    if (displayName && (hadDisplayName || displayName !== model.id)) annotations[DISPLAY_NAME] = displayName;
    else delete annotations[DISPLAY_NAME];
    if (input.description) annotations[DESCRIPTION] = input.description;
    else delete annotations[DESCRIPTION];
    paths.push('metadata.annotations');
  }
  if (model.placementClusters && !sameSet(input.clusters, model.placementClusters)) {
    spec.placement = namedPlacement(input.clusters);
    paths.push('spec.placement');
  }
  if (paths.length === 0) return undefined;
  return {
    object: {
      id: model.id,
      metadata: { name: model.id, version: model.version, ...(annotations ? { annotations } : {}) },
      spec,
    },
    updateMask: { paths },
    lock: true,
  };
};
