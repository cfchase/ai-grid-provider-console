/**
 * The model servers and hardware profiles the Deploy model wizard offers, from the backend's
 * Models/ListServingOptions: one static list for every cluster, which the console's Helm chart ships
 * as OpenShift AI's defaults (values.yaml, servingOptions). A model server is an OpenShift AI
 * accelerator preset, an LLMInferenceServiceConfig a model's spec.base_refs names, as the ODH
 * dashboard's accelerator choice adds one (packages/llmd-serving/src/deployments/configs.ts,
 * applyConfigRef). A preset sets the runtime image and its environment, so a model on one may leave
 * its image empty (ModelContainer.image in the backend's model_type.proto). A hardware profile is a
 * starting point, as in the OpenShift AI dashboard: it fills the wizard's CPU, memory and GPU fields
 * from its defaults and limits them to its range, and the model is saved with those resources and
 * the profile's annotations (ModelSpec.hardware_profile).
 */
import { useQuery } from '@connectrpc/connect-query';
import { parseQuantity } from '../../utilities/quantity';
import type {
  HardwareProfileOption,
  ModelServerOption,
  ModelsListServingOptionsResponse,
} from '../../gen/ai_grid/v1/models_service_pb';
import { listServingOptions } from '../../gen/ai_grid/v1/models_service-Models_connectquery';
import { useLoaded, type Loaded } from '../clusters/useClusters';

export type ModelServer = {
  /** The preset's full name, the value spec.base_refs takes. */
  name: string;
  label: string;
  description: string;
  /** Node resources the preset needs, such as nvidia.com/gpu; empty runs on CPUs. */
  accelerators: string[];
  /** Whether the server needs an accelerator, so the wizard asks for a count. */
  usesGpus: boolean;
};

/** One resource of a hardware profile, with its counts as Kubernetes quantities. */
export type ProfileResource = {
  /** The resource name, such as cpu, memory or nvidia.com/gpu. */
  identifier: string;
  label: string;
  min: string;
  default: string;
  /** Undefined: no maximum. */
  max?: string;
};

export type HardwareProfile = {
  name: string;
  label: string;
  description: string;
  /** The resources the profile sets (its spec.identifiers). */
  resources: string[];
  identifiers: ProfileResource[];
};

export type ServingOptions = { servers: ModelServer[]; profiles: HardwareProfile[] };

const toServer = (option: ModelServerOption): ModelServer => ({
  name: option.name,
  label: option.displayName || option.name,
  description: option.description,
  accelerators: [...option.accelerators],
  usesGpus: option.accelerators.length > 0,
});

const toProfile = (option: HardwareProfileOption): HardwareProfile => ({
  name: option.name,
  label: option.displayName || option.name,
  description: option.description,
  resources: option.identifiers.map((i) => i.identifier),
  identifiers: option.identifiers.map((i) => ({
    identifier: i.identifier,
    label: i.displayName || i.identifier,
    min: i.minCount,
    default: i.defaultCount,
    max: i.maxCount || undefined,
  })),
});

const servingOptionsOf = (answer: ModelsListServingOptionsResponse | undefined): ServingOptions => ({
  servers: (answer?.modelServers ?? []).map(toServer),
  profiles: (answer?.hardwareProfiles ?? []).map(toProfile),
});

/** The backend's model servers and hardware profiles. */
export const useServingOptions = (): Loaded<ServingOptions> =>
  useLoaded(useQuery(listServingOptions, {}, { retry: false }), servingOptionsOf);

/**
 * What the wizard says about where a server runs, from the accelerators it needs: OpenShift AI
 * installs a GPU preset only on clusters with that accelerator, so a model on one fails elsewhere.
 */
export const serverSuitsText = (server: ModelServer) =>
  server.usesGpus
    ? `Only for clusters whose nodes have ${server.accelerators.join(' or ')}: OpenShift AI installs this model server only there, and the model fails on any other cluster you select.`
    : 'For any cluster: OpenShift AI installs this model server on every cluster.';

/**
 * The accelerators a profile gives that a CPU server doesn't use: the cluster's webhook would add
 * them, with the profile's node selector, to a model that never uses them. Undefined otherwise.
 */
export const unusedAccelerator = (server: ModelServer | undefined, profile: HardwareProfile | undefined) => {
  const extra = profile?.resources.filter((r) => r !== 'cpu' && r !== 'memory') ?? [];
  return server && !server.usesGpus && extra.length > 0 ? extra.join(' and ') : undefined;
};

/** The accelerator a profile lacks that the server needs; undefined when it has one, or none is needed. */
export const missingAccelerator = (server: ModelServer | undefined, profile: HardwareProfile | undefined) =>
  server?.usesGpus && profile && !server.accelerators.some((a) => profile.resources.includes(a))
    ? server.accelerators.join(' or ')
    : undefined;

/**
 * A model's server as the details pages know it without the list: its presets. A model on presets
 * may leave its image to them (setsImage).
 */
export const modelServerOf = (baseRefs: readonly string[] | undefined) =>
  baseRefs && baseRefs.length > 0 ? { setsImage: true } : undefined;

/** A model's hardware profile by its display name when the list has it, else by its name. */
export const hardwareProfileLabel = (name: string | undefined, profiles: readonly HardwareProfile[] = []) =>
  name === undefined ? undefined : (profiles.find((p) => p.name === name)?.label ?? name);

/** A model's server by its display name when the list has it, else by its presets' names. */
export const modelServerLabel = (baseRefs: readonly string[], servers: readonly ModelServer[] = []) =>
  baseRefs.map((ref) => servers.find((s) => s.name === ref)?.label ?? ref).join(', ');

/** What the pages show for the runtime image of a model that leaves it to its server's presets. */
export const PRESET_IMAGE = 'The model server’s image';

/** The profile's entry for a resource, such as cpu; undefined without a profile or that resource. */
export const profileResource = (profile: HardwareProfile | undefined, identifier: string | undefined) =>
  identifier === undefined ? undefined : profile?.identifiers.find((i) => i.identifier === identifier);

/** A resource's range as the field's help says it, for example "From 2Gi to 8Gi." */
export const rangeText = (resource: ProfileResource) =>
  resource.max === undefined ? `At least ${resource.min}.` : `From ${resource.min} to ${resource.max}.`;

/**
 * Whether a value is outside the profile's range for the resource: a field error, as the OpenShift AI
 * dashboard checks, worded as the console's field errors are. Undefined when it fits, when the
 * profile doesn't set the resource, or when the value doesn't parse (the field's own check says so).
 */
export const outOfRange = (
  resource: ProfileResource | undefined,
  value: string,
  noun: 'value' | 'number' = 'value',
) => {
  const amount = parseQuantity(value);
  if (!resource || amount === undefined) return undefined;
  const min = parseQuantity(resource.min);
  const max = parseQuantity(resource.max);
  const fits = (min === undefined || amount >= min) && (max === undefined || amount <= max);
  if (fits) return undefined;
  return resource.max === undefined
    ? `Enter a ${noun} of at least ${resource.min}.`
    : `Enter a ${noun} from ${resource.min} to ${resource.max}.`;
};
