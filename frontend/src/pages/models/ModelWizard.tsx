// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/models/ModelWizard.tsx at 62319b8.
// Adapted from packages/model-serving/src/components/deploymentWizard/ModelDeploymentWizard.tsx,
// steps/ModelSourceStep.tsx, steps/ModelDeploymentStep.tsx and steps/ReviewStep.tsx.
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Standalone fields replace cluster catalogs and dynamic deployment plugins.
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  AlertActionLink,
  Breadcrumb,
  BreadcrumbItem,
  ExpandableSection,
  Flex,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  PageSection,
  Spinner,
  TextInput,
  Wizard,
  WizardStep,
  useWizardContext,
} from '@patternfly/react-core';
import { ServiceError } from '../../api/ConsoleService';
import { ConsoleWizardFooter } from '../../components/ConsoleWizardFooter';
import { CountInput } from '../../components/CountInput';
import { DetailsList } from '../../components/DetailsList';
import { DetailsSection } from '../../components/DetailsSection';
import { K8sNameDescriptionField } from '../../components/K8sNameDescriptionField/K8sNameDescriptionField';
import { useK8sNameDescriptionFieldData } from '../../components/K8sNameDescriptionField/useK8sNameDescriptionFieldData';
import { MultiSelection } from '../../components/MultiSelection';
import { PageHeader } from '../../components/PageHeader';
import { ReadOnlyField } from '../../components/ReadOnlyField';
import { useConfirmDiscard } from '../../hooks/useConfirmDiscard';
import { createModelSchema, fieldMessage } from '../../validation';
import { RuntimeArgsField } from './fields/RuntimeArgsField';
import { filterRuntimeArgsForContainer, runtimeArgsOf, type RuntimeArgsFieldData } from './fields/runtimeArgs';
import { DEFAULT_REPLICAS, sameSet, updateRequestOf, type ModelInput } from './modelRequests';
import { REQUEST_GPU, titleOf, type ModelView } from './modelView';
import { OlderServedNameAlert } from './OlderServedNameAlert';
import { useModelWrites, usePlacementClusters } from './useModels';
import { deploymentNameFromUri, locationLabel, modelPath, siteNamesOf } from './modelUtils';
import {
  hardwareProfileLabel,
  missingAccelerator,
  modelServerLabel,
  modelServerOf,
  PRESET_IMAGE,
  serverSuitsText,
  useServingOptions,
} from './modelServers';
import { useClusterList } from '../clusters/useClusters';

type Props = {
  /** The model to edit; without it the wizard deploys a new one. */
  model?: ModelView;
};

const steps = {
  source: 'source-model-step',
  deployment: 'model-deployment-step',
  locations: 'locations-step',
  review: 'summary-step',
} as const;

const defaults = { replicas: String(DEFAULT_REPLICAS), cpu: '2', memory: '4Gi', gpuCount: '0' };

/** A resource the model was deployed without, shown in its read-only field. */
const NOT_SET = 'Not set';
/** A resource a model's hardware profile sets on each cluster. */
const BY_PROFILE = 'Set by the hardware profile';

const fixedReason = {
  source: 'The model a deployment serves is fixed. Deploy a new model to serve another one.',
  // Says what the field is without claiming a model deployed earlier serves its resource name: one
  // written before the backend served models as their ids can keep another.
  served: 'Users send this name as the model in their requests. It cannot be edited.',
  resources: 'Resources are set when the model is deployed. Deploy it again to change them.',
};

/** The wizard's starting values: the defaults when deploying, the model's own when editing. */
const initialValues = (model?: ModelView) => ({
  modelUri: model?.modelUri ?? '',
  runtimeImage: model?.runtimeImage ?? '',
  replicas: model?.replicas !== undefined ? String(model.replicas) : defaults.replicas,
  cpu: model ? (model.cpu ?? '') : defaults.cpu,
  memory: model ? (model.memory ?? '') : defaults.memory,
  gpuCount: model ? String(model.gpuCount ?? 0) : defaults.gpuCount,
  runtimeArgs: runtimeArgsOf(model?.env),
  // Only a `name In [...]` placement can be edited as locations (placementClustersOf).
  locations: model?.placementClusters ?? [],
});

/** A field's help line, replaced by the field's error while it has one. */
const Help: React.FC<{ children: React.ReactNode; error?: string; id?: string }> = ({ children, error, id }) => (
  <FormHelperText>
    <HelperText id={id}>
      <HelperTextItem variant={error ? 'error' : 'default'}>{error ?? children}</HelperTextItem>
    </HelperText>
  </FormHelperText>
);

const notAvailable = (err: unknown, what: string) =>
  err instanceof ServiceError && err.isNotImplemented ? `${what} not available on this AI Grid backend.` : undefined;

/** Says which chosen locations are no longer offered; undefined when none are. */
const goneLocationsError = (names: string[]) =>
  names.length === 0
    ? undefined
    : `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} no longer available. Remove ${names.length === 1 ? 'it' : 'them'} to continue.`;

/**
 * The Review step: an alert about the choices or the model first, if there is one, spaced as the
 * sections are; each section's Edit link goes back to its step.
 */
const ReviewStep: React.FC<{
  sections: { title: string; step: string; items: { term: string; value?: string }[] }[];
  alert?: React.ReactNode;
}> = ({ sections, alert }) => {
  const { goToStepById } = useWizardContext();
  return (
    <Flex
      direction={{ default: 'column' }}
      flexWrap={{ default: 'nowrap' }}
      spaceItems={{ default: 'spaceItemsXl' }}
      data-testid="model-review"
    >
      {alert}
      {sections.map((section) => (
        <DetailsSection key={section.title} title={section.title} onEdit={() => goToStepById(section.step)}>
          <DetailsList items={section.items} hideEmpty aria-label={section.title} />
        </DetailsSection>
      ))}
    </Flex>
  );
};

/**
 * The four-step deploy wizard at /models/deploy: source, deployment, locations, review. With
 * `model` it edits that deployment at /models/:id/edit through the same steps: every step can be
 * opened from the start, the fields the console doesn't edit are read-only, and Save changes sends
 * only what changed (Models/Update with its mask).
 */
export const ModelWizard: React.FC<Props> = ({ model }) => {
  const navigate = useNavigate();
  const editing = !!model;
  const [start] = useState(() => initialValues(model));
  // Editing any other placement as locations would change what else it selects.
  const locationsEditable = !model || model.placementClusters !== undefined;
  const replicasEditable = !model?.autoscaled;
  const writes = useModelWrites();
  const {
    data: availableLocations,
    loaded: locationsLoaded,
    error: locationsError,
    refresh: reloadLocations,
  } = usePlacementClusters();
  const { data: clusters, refresh: reloadClusters } = useClusterList();
  // Site names by location label, for a placement the console didn't write (its model.locations).
  const siteNames = useMemo(() => siteNamesOf(clusters), [clusters]);
  // Site names by cluster name, for the clusters Models/ListPlacementClusters offers and the placement takes.
  const clusterSiteNames = useMemo(
    () => new Map(clusters.flatMap((c) => (c.siteName ? [[c.name, c.siteName] as const] : []))),
    [clusters],
  );
  // AI Grid members ListPlacementClusters doesn't offer: not Available, not Compliant, or not a cluster
  // that serves models (role inference or combined).
  const unavailableMembers = clusters.filter((c) => c.aiGridEnabled && !availableLocations.includes(c.name)).length;
  const [locations, setLocations] = useState<string[]>(start.locations);
  // True from entering the Locations step until its locations reload answers; Next waits for it.
  const [reloadingLocations, setReloadingLocations] = useState(false);
  const reloadRef = useRef(0);
  // Chosen locations that a reload no longer offers. They stay as chips, so the user sees why Next is disabled.
  const goneLocations = locationsLoaded ? locations.filter((location) => !availableLocations.includes(location)) : [];
  // Like the text fields, Locations shows its error only once the user has changed it.
  const [locationsTouched, setLocationsTouched] = useState(false);
  const { data: nameDescData, onDataChange: onNameDescChange } = useK8sNameDescriptionFieldData({
    maxLength: 63,
    // A k8sName makes the resource name read-only, as a deployed one is.
    initialData: model ? { name: titleOf(model), description: model.description ?? '', k8sName: model.id } : undefined,
  });
  const [modelUri, setModelUri] = useState(start.modelUri);
  const [runtimeImage, setRuntimeImage] = useState(start.runtimeImage);
  const [replicas, setReplicas] = useState(start.replicas);
  const [cpu, setCpu] = useState(start.cpu);
  const [memory, setMemory] = useState(start.memory);
  const [gpuCount, setGpuCount] = useState(start.gpuCount);
  // The model servers and hardware profiles the backend offers (Models/ListServingOptions).
  const {
    data: servingOptions,
    loaded: servingOptionsLoaded,
    error: servingOptionsError,
    refresh: reloadServingOptions,
  } = useServingOptions();
  // A deployed model keeps its presets and profile; the choice is only made when deploying.
  // No default server: the grid's clusters can have GPUs or not, so the user picks one.
  const [serverName, setServerName] = useState('');
  const server = servingOptions.servers.find((s) => s.name === serverName);
  // Empty: no profile, and the wizard's own CPU, memory and GPU fields set the resources.
  const [profileName, setProfileName] = useState('');
  const profile = editing ? undefined : servingOptions.profiles.find((p) => p.name === profileName);
  const editedProfile = hardwareProfileLabel(model?.hardwareProfile, servingOptions.profiles);
  const chooseServer = (name: string) => {
    setServerName(name);
    // A GPU server starts at one GPU (none is what crash-loops); a CPU server hides the field,
    // so it goes back to its default rather than keep a value nobody can see or fix.
    if (!servingOptions.servers.find((s) => s.name === name)?.usesGpus) setGpuCount(defaults.gpuCount);
    else if (gpuCount === defaults.gpuCount || gpuCount === '') setGpuCount('1');
  };
  // With a profile, the profile gives the GPUs.
  const usesGpus = editing || (Boolean(server?.usesGpus) && !profile);
  const [runtimeArgs, setRuntimeArgs] = useState<RuntimeArgsFieldData>({
    enabled: start.runtimeArgs.length > 0,
    args: start.runtimeArgs,
  });
  // A field shows its error only once the user has left it, as Locations does.
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const touch = (field: string) => setTouched((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const input: ModelInput = {
    name: nameDescData.k8sName.value,
    displayName: nameDescData.name,
    description: nameDescData.description,
    modelUri: modelUri.trim(),
    runtimeImage,
    replicas: Number(replicas),
    cpu,
    memory,
    // A CPU server asks for no GPUs, whatever the hidden field last held.
    gpuCount: usesGpus ? Number(gpuCount) : 0,
    runtimeArgs: filterRuntimeArgsForContainer(runtimeArgs.args),
    baseRefs: model ? model.baseRefs : server ? [server.name] : [],
    hardwareProfile: profile?.name,
    gpuResource: server?.accelerators[0],
    clusters: locations,
  };
  const edited: ModelInput = { ...input, clusters: locationsEditable ? locations : start.locations };
  const isDirty = model
    ? updateRequestOf(model, edited) !== undefined
    : [modelUri, runtimeImage, nameDescData.name, nameDescData.description].some((v) => v !== '') ||
      replicas !== defaults.replicas ||
      cpu !== defaults.cpu ||
      memory !== defaults.memory ||
      gpuCount !== defaults.gpuCount ||
      serverName !== '' ||
      profileName !== '' ||
      runtimeArgs.enabled ||
      locations.length > 0;
  const detailsPath = model ? modelPath(model) : '';
  const leave = () => navigate(model ? detailsPath : '/models');
  const [requestLeave, discardModal] = useConfirmDiscard(isDirty && !saving, leave);

  // Every field this checks is required, so a field the user left empty says so.
  const shownError = (field: keyof typeof createModelSchema.shape, value: string, parse?: (text: string) => unknown) =>
    !touched.has(field)
      ? undefined
      : value.trim()
        ? fieldMessage(createModelSchema.shape[field], value, parse)
        : 'Required.';
  // A model server's preset sets the image, so the field may stay empty and the preset's applies.
  const imageOptional = editing ? Boolean(modelServerOf(model?.baseRefs)?.setsImage) : true;
  const imageFromPreset = imageOptional && runtimeImage.trim() === '';
  const modelUriError = shownError('modelUri', modelUri);
  const runtimeImageError = imageFromPreset ? undefined : shownError('runtimeImage', runtimeImage);
  const replicasError = shownError('replicas', replicas, Number);
  const cpuError = shownError('cpu', cpu);
  const memoryError = shownError('memory', memory);
  // KServe's GPU preset with no GPUs is what crash-loops on a CPU-only node.
  const gpusMissing = usesGpus && !editing && gpuCount !== '' && Number(gpuCount) < 1;
  const serverError = !editing && touched.has('server') && !server ? 'Required.' : undefined;
  // A GPU server on a profile that gives no such accelerator would start without one.
  const lacking = missingAccelerator(server, profile);
  const profileError =
    lacking && server && profile
      ? `${profile.label} gives the model no ${lacking}, which ${server.label} needs. Select a profile with one, or no profile.`
      : undefined;
  const gpuCountError =
    shownError('gpuCount', gpuCount, Number) ??
    (touched.has('gpuCount') && gpusMissing ? 'A GPU model server needs at least 1 GPU.' : undefined);
  // A deployed model's source, name and resources are fixed, so only what an edit can change is checked.
  const sourceValid = editing || createModelSchema.pick({ modelUri: true }).safeParse({ modelUri }).success;
  const deploymentValid = editing
    ? createModelSchema
        .pick({ displayName: true, description: true })
        .safeParse({ displayName: input.displayName, description: input.description }).success &&
      // A model deployed without an image keeps none until one is entered.
      (runtimeImage === start.runtimeImage ||
        imageFromPreset ||
        createModelSchema.shape.runtimeImage.safeParse(input.runtimeImage).success) &&
      // The deploy wizard's limits apply to a count the user sets, not to one the model already has.
      (!replicasEditable ||
        replicas === start.replicas ||
        (replicas !== '' && createModelSchema.shape.replicas.safeParse(input.replicas).success))
    : server !== undefined &&
      !profileError &&
      replicas !== '' &&
      (profile !== undefined || (gpuCount !== '' && !gpusMissing)) &&
      createModelSchema
        .omit({ locations: true, runtimeImage: true })
        .strip()
        // A profile sets the resources, so the hidden fields' values don't count.
        .safeParse(profile ? { ...input, cpu: defaults.cpu, memory: defaults.memory, gpuCount: 0 } : input).success &&
      (imageFromPreset || createModelSchema.shape.runtimeImage.safeParse(input.runtimeImage).success);
  // An edit that keeps the locations doesn't depend on which locations are offered right now.
  const locationsChanged = !editing || !sameSet(locations, start.locations);
  const locationsValid =
    !locationsEditable ||
    (!locationsChanged && locations.length > 0) ||
    (locationsLoaded && !reloadingLocations && !locationsError && locations.length > 0 && goneLocations.length === 0);
  const isStepValid = (step: string) =>
    step === steps.source
      ? sourceValid
      : sourceValid &&
        deploymentValid &&
        (step === steps.deployment || locationsValid) &&
        // Saving an edit that changes nothing would only bump the version.
        (step !== steps.review || !editing || isDirty);

  const save = async () => {
    if (saving || !sourceValid || !deploymentValid || !locationsValid || (editing && !isDirty)) return;
    setSaving(true);
    setError(undefined);
    try {
      if (model) {
        await writes.updateModel(model, edited);
        navigate(detailsPath, { state: { notice: 'Model updated' } });
      } else {
        await writes.createModel(input);
        // Replaces the deploy form in history, so Back doesn't land on it, empty.
        navigate('/models', { replace: true, state: { notice: 'Model deployed' } });
      }
    } catch (err) {
      setError(
        notAvailable(err, editing ? 'Editing models is' : 'Deploying models is') ??
          (editing && err instanceof ServiceError && err.status === 409
            ? 'This model was changed by another user. Reload the page to edit the latest version.'
            : err instanceof Error
              ? err.message
              : editing
                ? 'Unable to update the model.'
                : 'Unable to deploy the model.'),
      );
      setSaving(false);
    }
  };

  // A placement the console doesn't edit, or none, as the review and the step show it.
  const placedAt = () => {
    if (!model?.placed) return 'Not deployed to a location';
    return model.locations.length > 0
      ? model.locations.map((l) => locationLabel(l, siteNames)).join(', ')
      : 'No locations selected';
  };

  const locationsStep = () => {
    if (!locationsEditable) {
      return (
        <ReadOnlyField
          label="Locations"
          fieldId="model-locations"
          value={placedAt()}
          reason={
            model?.placed
              ? "This model's placement uses rules other than location, so its locations cannot be edited here."
              : 'This model is not deployed to any AI Grid location.'
          }
        />
      );
    }
    if (locationsError) {
      return (
        <Alert
          isInline
          variant="danger"
          title="Unable to load locations"
          actionLinks={<AlertActionLink onClick={() => void reloadLocations()}>Retry</AlertActionLink>}
        >
          {notAvailable(locationsError, 'Locations are') ?? locationsError.message}
        </Alert>
      );
    }
    if (!locationsLoaded) {
      return <Spinner size="lg" aria-label="Loading locations" />;
    }
    // With chosen locations to show, the field stays, so the user can see and remove them.
    if (availableLocations.length === 0 && goneLocations.length === 0) {
      return (
        <Alert isInline variant="warning" title="No locations available">
          A location appears here when an AI Grid cluster that serves models at that location is Ready and Provisioned.
        </Alert>
      );
    }
    return (
      <FormGroup label="Locations" fieldId="model-locations" isRequired>
        <MultiSelection
          id="model-locations-select"
          inputId="model-locations"
          ariaLabel="Locations"
          placeholder="Select locations"
          selectionRequired={locationsTouched}
          noSelectedOptionsMessage="Select at least one location."
          errorMessage={
            locationsChanged
              ? goneLocationsError(goneLocations.map((location) => locationLabel(location, clusterSiteNames)))
              : undefined
          }
          value={[
            ...availableLocations.map((location) => ({
              id: location,
              name: locationLabel(location, clusterSiteNames),
              selected: locations.includes(location),
            })),
            ...goneLocations.map((location) => ({
              id: location,
              name: locationLabel(location, clusterSiteNames),
              selected: true,
              chipOnly: true,
            })),
          ]}
          setValue={(options) => {
            setLocationsTouched(true);
            setLocations(options.filter((option) => option.selected).map((o) => String(o.id)));
          }}
          isDisabled={saving}
        />
        <Help>
          The model runs on every AI Grid cluster at the selected locations.
          {unavailableMembers > 0 &&
            ` ${unavailableMembers} AI Grid ${unavailableMembers === 1 ? 'cluster is' : 'clusters are'} not listed because ${unavailableMembers === 1 ? 'it is' : 'they are'} not Ready and Provisioned, or ${unavailableMembers === 1 ? 'does' : 'do'} not serve models.`}
        </Help>
      </FormGroup>
    );
  };

  // A hint only, from the GPU counts the clusters list already carries: a GPU server on a cluster
  // with no GPUs never schedules, and a CPU server on a GPU cluster leaves its GPUs unused.
  const serverMismatch = (() => {
    // The clusters' GPU counts are NVIDIA GPUs only, so they say nothing about another accelerator.
    if (editing || !server || (server.usesGpus && !server.accelerators.includes(REQUEST_GPU))) return undefined;
    const chosen = clusters.filter(
      (c) => c.aiGridEnabled && (locations.includes(c.name) || (c.location && locations.includes(c.location))),
    );
    const mismatched = chosen
      .filter((c) => c.gpuCapacity !== undefined && (server.usesGpus ? c.gpuCapacity === 0 : c.gpuCapacity > 0))
      .map((c) => c.name)
      .sort();
    if (mismatched.length === 0) return undefined;
    const names = mismatched.join(', ');
    return server.usesGpus
      ? `${names} ${mismatched.length === 1 ? 'reports' : 'report'} no GPUs, so ${server.label} can't run there.`
      : `${names} ${mismatched.length === 1 ? 'has' : 'have'} GPUs that ${server.label} doesn't use.`;
  })();

  const review = [
    {
      title: 'Source',
      step: steps.source,
      items: [
        { term: 'Model URI', value: modelUri },
        // A deployed model keeps the name it is served as; a new one is served as its resource name.
        ...(model ? [{ term: 'Model name in requests', value: model.modelName ?? model.id }] : []),
      ],
    },
    {
      title: 'Deployment',
      step: steps.deployment,
      items: [
        { term: 'Model name', value: nameDescData.name },
        ...(model ? [] : [{ term: 'Model name in requests', value: nameDescData.k8sName.value }]),
        { term: 'Description', value: nameDescData.description },
        { term: 'Model server', value: modelServerLabel(input.baseRefs, servingOptions.servers) },
        { term: 'Hardware profile', value: editing ? (editedProfile ?? 'None') : (profile?.label ?? 'None') },
        { term: 'Runtime image', value: imageFromPreset ? PRESET_IMAGE : runtimeImage },
        { term: 'Replicas', value: replicasEditable ? replicas : 'Autoscaled' },
        // A profile sets these on each cluster, for a new model or one deployed with a profile.
        ...(profile || (editing && model?.hardwareProfile)
          ? []
          : [
              { term: 'CPU', value: cpu },
              { term: 'Memory', value: memory },
              { term: 'GPUs', value: String(input.gpuCount) },
            ]),
        { term: 'Additional runtime arguments', value: input.runtimeArgs.join(' ') },
      ],
    },
    {
      title: 'Locations',
      step: steps.locations,
      items: [
        {
          term: 'Locations',
          value: locationsEditable ? locations.map((l) => locationLabel(l, clusterSiteNames)).join(', ') : placedAt(),
        },
      ],
    },
  ];

  return (
    <>
      <PageHeader
        title={model ? `Edit ${titleOf(model)}` : 'Deploy model'}
        description={model ? "Edit the model's settings and locations." : 'Deploy a model to AI Grid locations.'}
        breadcrumb={
          <Breadcrumb>
            <BreadcrumbItem>
              <Link to="/models">Models</Link>
            </BreadcrumbItem>
            {model && (
              <BreadcrumbItem>
                <Link to={detailsPath}>{titleOf(model)}</Link>
              </BreadcrumbItem>
            )}
            <BreadcrumbItem isActive>{model ? 'Edit' : 'Deploy model'}</BreadcrumbItem>
          </Breadcrumb>
        }
      />
      <PageSection type="wizard" hasBodyWrapper={false} isFilled>
        <Wizard
          isProgressive={false}
          onClose={requestLeave}
          onStepChange={(_event, current, previous) => {
            // Start a new deployment's name from the model URI's last segment, once.
            if (!editing && previous.id === steps.source && !nameDescData.name) {
              onNameDescChange('name', deploymentNameFromUri(modelUri));
            }
            // A cluster can change state while the earlier steps are filled in, so offer what is available now.
            if (current.id === steps.locations && locationsEditable) {
              const reload = ++reloadRef.current;
              setReloadingLocations(true);
              void reloadLocations().then(() => {
                if (reload === reloadRef.current) setReloadingLocations(false);
              });
              // The clusters only name the sites and count the unlisted members, so Next doesn't wait for them.
              void reloadClusters();
            }
          }}
          footer={
            <ConsoleWizardFooter
              submitStepId={steps.review}
              submitLabel={editing ? 'Save changes' : 'Deploy'}
              errorTitle={editing ? 'Unable to update model' : 'Unable to deploy model'}
              isStepValid={isStepValid}
              saving={saving}
              error={error}
              onSubmit={save}
              onCancel={requestLeave}
            />
          }
        >
          <WizardStep name="Source" id={steps.source}>
            <Form maxWidth="750px">
              {editing ? (
                <>
                  {model && <OlderServedNameAlert model={model} />}
                  <ReadOnlyField label="Model URI" fieldId="model-uri" value={modelUri} reason={fixedReason.source} />
                  <ReadOnlyField
                    label="Model name in requests"
                    fieldId="model-alias"
                    value={model?.modelName ?? model?.id ?? ''}
                    reason={fixedReason.served}
                  />
                </>
              ) : (
                <>
                  <FormGroup label="Model URI" fieldId="model-uri" isRequired>
                    <TextInput
                      id="model-uri"
                      aria-describedby="model-uri-help"
                      value={modelUri}
                      onChange={(_event, value) => setModelUri(value)}
                      onBlur={() => touch('modelUri')}
                      validated={modelUriError ? 'error' : 'default'}
                      isRequired
                    />
                    <Help id="model-uri-help" error={modelUriError}>
                      For example, hf://org/model, oci://registry/model:tag, s3://bucket/path, or pvc://claim/path.
                    </Help>
                  </FormGroup>
                </>
              )}
            </Form>
          </WizardStep>
          <WizardStep name="Deployment" id={steps.deployment} isDisabled={!sourceValid || saving}>
            <Form maxWidth="750px">
              <K8sNameDescriptionField
                data={nameDescData}
                onDataChange={onNameDescChange}
                dataTestId="model-name-desc"
                nameLabel="Model name"
                nameHelperText={
                  editing
                    ? undefined
                    : 'Users send the resource name as the model in their requests. Up to 63 characters.'
                }
              />
              {editing ? (
                <>
                  <ReadOnlyField
                    label="Model server"
                    fieldId="model-server"
                    value={modelServerLabel(input.baseRefs, servingOptions.servers)}
                    reason={fixedReason.resources}
                  />
                  <ReadOnlyField
                    label="Hardware profile"
                    fieldId="model-hardware-profile"
                    value={editedProfile ?? 'None'}
                    reason={fixedReason.resources}
                  />
                </>
              ) : servingOptionsError ? (
                <Alert
                  isInline
                  variant="danger"
                  title="Error loading model servers"
                  actionLinks={<AlertActionLink onClick={() => void reloadServingOptions()}>Retry</AlertActionLink>}
                >
                  {notAvailable(servingOptionsError, 'Model servers are') ?? servingOptionsError.message}
                </Alert>
              ) : !servingOptionsLoaded ? (
                <p>Loading model servers...</p>
              ) : servingOptions.servers.length === 0 ? (
                <Alert isInline variant="warning" title="No model servers to offer">
                  The console’s backend has no model servers configured. Set servingOptions in the console’s Helm chart.
                </Alert>
              ) : (
                <>
                  <FormGroup label="Model server" fieldId="model-server" isRequired>
                    <FormSelect
                      id="model-server"
                      aria-describedby="model-server-help"
                      // A choice a reload no longer lists shows as none, as the wizard then treats it.
                      value={server?.name ?? ''}
                      onChange={(_event, value) => chooseServer(value)}
                      onBlur={() => touch('server')}
                      validated={serverError ? 'error' : 'default'}
                      isRequired
                    >
                      <FormSelectOption isPlaceholder isDisabled value="" label="Select a model server" />
                      {servingOptions.servers.map((s) => (
                        <FormSelectOption key={s.name} value={s.name} label={s.label} />
                      ))}
                    </FormSelect>
                    <Help id="model-server-help" error={serverError}>
                      {server
                        ? `${server.description} ${serverSuitsText(server)}`.trim()
                        : 'Select the model server that matches the hardware of the clusters you deploy to.'}
                    </Help>
                  </FormGroup>
                  <FormGroup label="Hardware profile" fieldId="model-hardware-profile">
                    <FormSelect
                      id="model-hardware-profile"
                      aria-describedby="model-hardware-profile-help"
                      value={profile?.name ?? ''}
                      onChange={(_event, value) => setProfileName(value)}
                      validated={profileError ? 'error' : 'default'}
                    >
                      <FormSelectOption value="" label="None: set CPU, memory and GPUs here" />
                      {servingOptions.profiles.map((p) => (
                        <FormSelectOption key={p.name} value={p.name} label={p.label} />
                      ))}
                    </FormSelect>
                    <Help id="model-hardware-profile-help" error={profileError}>
                      {profile
                        ? `${profile.description} The profile sets the model’s CPU, memory and accelerators on each cluster.`.trim()
                        : "A hardware profile sets the model's resources on each cluster. Without one, set them here."}
                    </Help>
                  </FormGroup>
                </>
              )}
              <FormGroup label="Runtime image" fieldId="runtime-image" isRequired={!imageOptional}>
                <TextInput
                  id="runtime-image"
                  aria-describedby="runtime-image-help"
                  value={runtimeImage}
                  onChange={(_event, value) => setRuntimeImage(value)}
                  onBlur={() => touch('runtimeImage')}
                  validated={runtimeImageError ? 'error' : 'default'}
                  isRequired={!imageOptional}
                />
                <Help id="runtime-image-help" error={runtimeImageError}>
                  {imageOptional
                    ? "Leave empty to use the model server's image. An image entered here replaces it."
                    : 'Must match the model server. For example, use a vLLM CPU image for vLLM CPU.'}
                </Help>
              </FormGroup>
              {replicasEditable ? (
                <FormGroup label="Replicas" fieldId="deployment-replicas" isRequired>
                  <CountInput
                    id="deployment-replicas"
                    label="Replicas"
                    min={1}
                    max={99}
                    value={replicas}
                    onChange={setReplicas}
                    onBlur={() => touch('replicas')}
                    describedBy="deployment-replicas-help"
                    validated={replicasError ? 'error' : 'default'}
                  />
                  <Help id="deployment-replicas-help" error={replicasError}>
                    From 1 to 99.
                  </Help>
                </FormGroup>
              ) : (
                <ReadOnlyField
                  label="Replicas"
                  fieldId="deployment-replicas"
                  value="Autoscaled"
                  reason="This model scales automatically, so it has no fixed replica count."
                />
              )}
              {editing ? (
                <>
                  {/* A model deployed without requests has none to show. */}
                  <ReadOnlyField
                    label="CPU"
                    fieldId="deployment-cpu"
                    value={model?.hardwareProfile ? BY_PROFILE : cpu || NOT_SET}
                    reason={fixedReason.resources}
                  />
                  <ReadOnlyField
                    label="Memory"
                    fieldId="deployment-memory"
                    value={model?.hardwareProfile ? BY_PROFILE : memory || NOT_SET}
                    reason={fixedReason.resources}
                  />
                  <ReadOnlyField
                    label="GPUs"
                    fieldId="deployment-gpus"
                    value={model?.hardwareProfile ? BY_PROFILE : gpuCount}
                    reason={fixedReason.resources}
                  />
                </>
              ) : profile ? null : (
                <>
                  <FormGroup label="CPU" fieldId="deployment-cpu" isRequired>
                    <TextInput
                      id="deployment-cpu"
                      aria-describedby="deployment-cpu-help"
                      value={cpu}
                      onChange={(_event, value) => setCpu(value)}
                      onBlur={() => touch('cpu')}
                      validated={cpuError ? 'error' : 'default'}
                      isRequired
                    />
                    <Help id="deployment-cpu-help" error={cpuError}>
                      In cores or millicores. For example, 2 or 500m.
                    </Help>
                  </FormGroup>
                  <FormGroup label="Memory" fieldId="deployment-memory" isRequired>
                    <TextInput
                      id="deployment-memory"
                      aria-describedby="deployment-memory-help"
                      value={memory}
                      onChange={(_event, value) => setMemory(value)}
                      onBlur={() => touch('memory')}
                      validated={memoryError ? 'error' : 'default'}
                      isRequired
                    />
                    <Help id="deployment-memory-help" error={memoryError}>
                      For example, 4Gi or 512Mi.
                    </Help>
                  </FormGroup>
                  {usesGpus && (
                    <FormGroup label="GPUs" fieldId="deployment-gpus" isRequired>
                      <CountInput
                        id="deployment-gpus"
                        label="GPUs"
                        min={1}
                        max={64}
                        value={gpuCount}
                        onChange={setGpuCount}
                        onBlur={() => touch('gpuCount')}
                        describedBy="deployment-gpus-help"
                        validated={gpuCountError ? 'error' : 'default'}
                      />
                      <Help id="deployment-gpus-help" error={gpuCountError}>
                        From 1 to 64.
                      </Help>
                    </FormGroup>
                  )}
                </>
              )}
              <ExpandableSection toggleText="Advanced settings" isIndented>
                <RuntimeArgsField data={runtimeArgs} onChange={setRuntimeArgs} />
              </ExpandableSection>
            </Form>
          </WizardStep>
          <WizardStep name="Locations" id={steps.locations} isDisabled={!sourceValid || !deploymentValid || saving}>
            <Form maxWidth="750px">{locationsStep()}</Form>
          </WizardStep>
          <WizardStep
            name="Review"
            id={steps.review}
            isDisabled={!sourceValid || !deploymentValid || !locationsValid || saving}
          >
            <ReviewStep
              sections={review}
              alert={
                model ? (
                  <OlderServedNameAlert model={model} />
                ) : (
                  serverMismatch && (
                    <Alert isInline variant="warning" title={serverMismatch} data-testid="model-server-mismatch" />
                  )
                )
              }
            />
          </WizardStep>
        </Wizard>
      </PageSection>
      {discardModal}
    </>
  );
};
