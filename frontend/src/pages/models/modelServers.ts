/**
 * The model servers and hardware profiles the Deploy model wizard offers, from the backend's
 * Models/ListServingOptions: one static list for every cluster, which the console's Helm chart ships
 * as OpenShift AI's defaults (values.yaml, servingOptions). A model server is an OpenShift AI
 * accelerator preset, an LLMInferenceServiceConfig a model's spec.base_refs names, as the ODH
 * dashboard's accelerator choice adds one (packages/llmd-serving/src/deployments/configs.ts,
 * applyConfigRef). A preset sets the runtime image and its environment, so a model on one may leave
 * its image empty (ModelContainer.image in the backend's model_type.proto). A hardware profile sets
 * the container's resources on each cluster (ModelSpec.hardware_profile).
 */
import { useQuery } from '@connectrpc/connect-query';
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

export type HardwareProfile = {
  name: string;
  label: string;
  description: string;
  /** The resources the profile sets (its spec.identifiers). */
  resources: string[];
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
  resources: [...option.resources],
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
