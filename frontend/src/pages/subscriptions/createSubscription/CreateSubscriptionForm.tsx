// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/createSubscription/CreateSubscriptionForm.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/createSubscription/CreateSubscriptionForm.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The console adds the Organization field: required on create, kept on edit. Telemetry is dropped.
// It writes Subscriptions/Create and Update over Connect.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ActionGroup,
  Alert,
  Button,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  NumberInput,
  TextInput,
} from '@patternfly/react-core';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { z } from 'zod';
import { describeError } from '../../../api/connect/errors';
import { SYSTEM_AUTHENTICATED_GROUP } from '../../../api/types';
import { AddModelsModal } from '../../../components/AddModelsModal';
import { K8sNameDescriptionField } from '../../../components/K8sNameDescriptionField/K8sNameDescriptionField';
import { isK8sNameDescriptionDataValid } from '../../../components/K8sNameDescriptionField/nameField';
import { useK8sNameDescriptionFieldData } from '../../../components/K8sNameDescriptionField/useK8sNameDescriptionFieldData';
import { MaasModelsSection, type SubscriptionModelRow } from '../../../components/MaasModelsSection';
import type { SelectionOptions } from '../../../components/MultiSelection';
import { MultiSelection } from '../../../components/MultiSelection';
import { SystemAuthenticatedWarning } from '../../../components/SystemAuthenticatedWarning';
import { TypeaheadSelect } from '../../../components/TypeaheadSelect';
import type { Model } from '../../../gen/ai_grid/v1/model_type_pb';
import {
  SubscriptionModelRefSchema,
  type SubscriptionModelRef,
  SubscriptionSpecSchema,
} from '../../../gen/ai_grid/v1/subscription_type_pb';
import type { SubscriptionsGetResponse } from '../../../gen/ai_grid/v1/subscriptions_service_pb';
import { useConfirmDiscard } from '../../../hooks/useConfirmDiscard';
import { getSectionUrl } from '../../../utilities/maasGovernanceNavigation';
import { fieldErrorsOf } from '../../../validation';
import type { SubscriptionModelEntry } from '../hooks/useSubscriptionModels';
import { entryKey, useSubscriptionModels } from '../hooks/useSubscriptionModels';
import {
  ANNOTATION_DESCRIPTION,
  ANNOTATION_DISPLAY_NAME,
  descriptionOf,
  displayNameOf,
  groupsOf,
  modelForRef,
  modelPhaseOf,
  modelRefsOf,
  organizationIdOf,
  refTitleOf,
  registrationStatusOf,
  tenantNameOf,
  toTokenLimits,
} from '../subscriptionText';
import { useSubscriptionWrites, useTenantList } from '../useSubscriptions';
import { EditRateLimitsModal } from './EditRateLimitsModal';

type Props = {
  /** The models the subscription may name, from Models/List. */
  models: Model[];
  /** The subscription being edited, as Subscriptions/Get answered it; none on create. */
  subscriptionInfo?: SubscriptionsGetResponse;
  returnTo?: string;
};

const MAX_PRIORITY = 1000000;
const MIN_PRIORITY = -1000000;
const SELECT_ORGANIZATION = 'Select an organization';
/**
 * The longest subscription id the backend takes: 63 less the managed policy's "-policy" suffix
 * (maxSubscriptionIDLen, internal/servers/subscription_mapper.go).
 */
const MAX_ID_LENGTH = 56;

const subscriptionFormSchema = z.object({
  priority: z
    .number({ message: 'Priority is required' })
    .int('Priority must be a whole number')
    .min(MIN_PRIORITY, `Priority must be at least ${MIN_PRIORITY}`)
    .max(MAX_PRIORITY, `Priority must be at most ${MAX_PRIORITY}`),
  groups: z.array(z.string()).min(1, 'One or more groups must be selected'),
  models: z.array(z.unknown()).min(1, 'One or more models must be added'),
});

const buildInitialModels = (info: SubscriptionsGetResponse, models: Model[]): SubscriptionModelEntry[] =>
  (info.object ? modelRefsOf(info.object) : []).map((ref) => ({
    ref,
    model: modelForRef(models, ref),
    saved: true,
    unlimited: ref.unlimited,
    tokenRateLimits: toTokenLimits(ref.tokenRateLimits),
  }));

/**
 * The ref the form writes: the loaded ref's own fields (its namespace, billing rate and guardrails)
 * with the limits set here. The output-only display_name, description and model_id are left out:
 * the backend ignores them on write.
 */
const refPayload = (entry: SubscriptionModelEntry): SubscriptionModelRef =>
  create(SubscriptionModelRefSchema, {
    name: entry.ref.name,
    namespace: entry.ref.namespace,
    billingRate: entry.ref.billingRate,
    guardrails: entry.ref.guardrails,
    unlimited: entry.unlimited,
    tokenRateLimits: entry.tokenRateLimits.map(({ limit, window }) => ({ limit: BigInt(limit), window })),
  });

const errorText = (message: string) => (
  <FormHelperText>
    <HelperText>
      <HelperTextItem variant="error">{message}</HelperTextItem>
    </HelperText>
  </FormHelperText>
);

export const CreateSubscriptionForm: React.FC<Props> = ({ models: availableModels, subscriptionInfo, returnTo }) => {
  const navigate = useNavigate();
  const { data: organizations, error: organizationsError } = useTenantList();
  const { createSubscription, updateSubscription } = useSubscriptionWrites();
  const isEditing = !!subscriptionInfo?.object;
  const subscription = subscriptionInfo?.object;

  const { data: nameDescData, onDataChange: onNameDescChange } = useK8sNameDescriptionFieldData(
    subscription
      ? {
          initialData: {
            name: displayNameOf(subscription),
            k8sName: subscription.id,
            description: descriptionOf(subscription),
          },
        }
      : { maxLength: MAX_ID_LENGTH },
  );

  const [selectedGroups, setSelectedGroups] = useState<SelectionOptions[]>(() =>
    (subscription ? groupsOf(subscription) : []).map((name) => ({ id: name, name, selected: true })),
  );
  const [groupsTouched, setGroupsTouched] = useState(false);
  const [modelsTouched, setModelsTouched] = useState(false);
  const savedOrganizationId = subscription ? organizationIdOf(subscription) : '';
  const [organizationId, setOrganizationId] = useState(savedOrganizationId);
  // A subscription saved without an organization opens with Save disabled, so it says why straight
  // away instead of waiting for the field to be touched.
  const [organizationTouched, setOrganizationTouched] = useState(!!subscription && !organizationId);
  const [priority, setPriority] = useState<number | undefined>(subscription?.spec?.priority ?? 0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [initialModels] = useState<SubscriptionModelEntry[]>(() =>
    subscriptionInfo ? buildInitialModels(subscriptionInfo, availableModels) : [],
  );

  const {
    models,
    isAddModelsModalOpen,
    setIsAddModelsModalOpen,
    editLimitsTarget,
    setEditLimitsTarget,
    editingModel,
    allModelsHaveRateLimits,
    handleAddModels,
    handleRemoveModel,
    handleRemoveModels,
    handleSaveRateLimits,
    handleCloseRateLimitsModal,
  } = useSubscriptionModels(initialModels);

  const isNameValid = isK8sNameDescriptionDataValid(nameDescData);
  const selectedGroupNames = selectedGroups.filter((g) => g.selected).map((g) => String(g.id));

  const initialGroupNames = useMemo(() => new Set(subscription ? groupsOf(subscription) : []), [subscription]);
  const initialModelKeys = useMemo(() => new Set(initialModels.map(entryKey)), [initialModels]);
  const groupsChanged =
    isEditing &&
    (selectedGroupNames.length !== initialGroupNames.size || selectedGroupNames.some((g) => !initialGroupNames.has(g)));
  const modelsChanged =
    isEditing && (models.length !== initialModelKeys.size || models.some((m) => !initialModelKeys.has(entryKey(m))));
  const showPolicyWarning = isEditing && (groupsChanged || modelsChanged);

  const fieldErrors = fieldErrorsOf(subscriptionFormSchema, {
    priority: priority == null || Number.isNaN(priority) ? Number.NaN : priority,
    groups: selectedGroupNames,
    models,
  });
  const isPriorityValid = priority != null && !Number.isNaN(priority);
  // Required on create and edit, and immutable once set (validateOrganizationImmutable in the
  // backend's internal/servers/subscriptions_server.go), so the edit form shows a set one read-only.
  const organizationLocked = !!savedOrganizationId;
  const organizationMissing = !organizationId;

  // What the user can change, so Cancel asks before discarding it and an unchanged edit can't be saved
  // (as the organization and model forms do).
  const formValues = JSON.stringify({
    name: nameDescData.name,
    k8sName: nameDescData.k8sName.value,
    description: nameDescData.description,
    groups: selectedGroupNames,
    organizationId,
    priority: priority == null || Number.isNaN(priority) ? null : priority,
    models: models.map((m) => [entryKey(m), m.tokenRateLimits, m.unlimited]),
  });
  const [initialValues] = useState(formValues);
  const isDirty = formValues !== initialValues;
  const leave = () => navigate(returnTo ?? getSectionUrl('subscriptions'));
  const [requestLeave, discardModal] = useConfirmDiscard(isDirty && !isSubmitting, leave);

  const canSubmit =
    (!isEditing || isDirty) &&
    isNameValid &&
    Object.keys(fieldErrors).length === 0 &&
    allModelsHaveRateLimits &&
    isPriorityValid &&
    !organizationMissing &&
    !isSubmitting;

  // The organization select lists the organizations by name; an edited subscription keeps its
  // organization even when the backend no longer lists it.
  const organizationOptions = useMemo(() => {
    const options = organizations
      .map((o) => ({ value: o.id, label: tenantNameOf(o) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (savedOrganizationId && !options.some((o) => o.value === savedOrganizationId)) {
      options.push({ value: savedOrganizationId, label: savedOrganizationId });
    }
    return options;
  }, [organizations, savedOrganizationId]);

  /**
   * The annotations to write: on an edit the whole map as loaded (an Update replaces the map), with
   * the display name and description set, or dropped when cleared. An unchanged name keeps the
   * annotation as it was.
   */
  const annotationsPayload = (): Record<string, string> => {
    const annotations = { ...(subscription?.metadata?.annotations ?? {}) };
    const set = (key: string, value: string) => {
      if (value) annotations[key] = value;
      else delete annotations[key];
    };
    const name = nameDescData.name.trim();
    if (!subscription || name !== displayNameOf(subscription)) {
      set(ANNOTATION_DISPLAY_NAME, name);
    }
    set(ANNOTATION_DESCRIPTION, nameDescData.description.trim());
    return annotations;
  };

  const handleSubmit = async () => {
    if (priority == null || Number.isNaN(priority)) {
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    // The whole spec: what the form edits, and as loaded what it doesn't (users, token metadata,
    // inference priority, guardrails), since the mask names spec as a whole.
    const loaded = subscription?.spec;
    const spec: MessageInitShape<typeof SubscriptionSpecSchema> = {
      owner: { groups: selectedGroupNames, users: loaded?.owner?.users ?? [] },
      modelRefs: models.map(refPayload),
      priority,
      organization: { id: organizationId },
      tokenMetadata: loaded?.tokenMetadata,
      inferencePriority: loaded?.inferencePriority,
      guardrails: loaded?.guardrails ?? [],
    };
    try {
      if (subscription) {
        await updateSubscription.mutateAsync({
          object: {
            id: subscription.id,
            metadata: { annotations: annotationsPayload(), version: subscription.metadata?.version ?? 0 },
            spec,
          },
          updateMask: { paths: ['spec', 'metadata.annotations'] },
          // The backend answers Aborted when the subscription changed since it was read.
          lock: true,
        });
      } else {
        const id = nameDescData.k8sName.value;
        // The backend creates the managed authorization policy, <id>-policy, with it.
        await createSubscription.mutateAsync({
          object: { id, metadata: { name: id, annotations: annotationsPayload() }, spec },
        });
      }
      // A created subscription replaces its create form in history, so Back doesn't land on it, empty.
      navigate(returnTo ?? getSectionUrl('subscriptions'), {
        replace: !isEditing,
        state: { notice: isEditing ? 'Subscription updated' : 'Subscription created' },
      });
    } catch (e) {
      const error = describeError(e);
      setSubmitError(
        error.kind === 'notAvailable'
          ? `${isEditing ? 'Saving' : 'Creating'} subscriptions is not available on this backend yet.`
          : error.message,
      );
      setIsSubmitting(false);
    }
  };

  const showNoModelsWarning = !isEditing && availableModels.length === 0 && models.length === 0;
  const canAddModels = availableModels.length > 0;

  const rows: SubscriptionModelRow[] = models.map((entry) => {
    const status =
      entry.saved && subscriptionInfo
        ? registrationStatusOf(subscriptionInfo.modelRegistrations, entry.ref)
        : { status: entry.model ? modelPhaseOf(entry.model) : 'Unknown', reason: entry.model?.status?.message };
    return {
      key: entryKey(entry),
      title: refTitleOf(entry.ref, entry.model),
      name: entry.ref.name,
      ...status,
      tokenRateLimits: entry.tokenRateLimits,
      unlimited: entry.unlimited,
    };
  });

  let organizationHelper = (
    <FormHelperText>
      <HelperText>
        <HelperTextItem>
          {organizationLocked
            ? 'The organization can’t be changed once it is set.'
            : 'The organization whose users this subscription serves.'}
        </HelperTextItem>
      </HelperText>
    </FormHelperText>
  );
  if (organizationsError) {
    organizationHelper = errorText(`Unable to load organizations: ${organizationsError.message}`);
  } else if (organizationTouched && organizationMissing) {
    organizationHelper = errorText(SELECT_ORGANIZATION);
  }

  return (
    <>
      <Form maxWidth="750px">
        <K8sNameDescriptionField
          data={nameDescData}
          onDataChange={onNameDescChange}
          dataTestId="subscription-name-desc"
        />

        <FormGroup label="Organization" fieldId="subscription-organization" isRequired={!organizationLocked}>
          {organizationLocked ? (
            <TextInput
              id="subscription-organization"
              data-testid="subscription-organization"
              readOnlyVariant="default"
              value={organizationOptions.find((o) => o.value === organizationId)?.label ?? organizationId}
            />
          ) : (
            <TypeaheadSelect
              id="subscription-organization"
              data-testid="subscription-organization"
              aria-label="Organization"
              value={organizationId}
              options={organizationOptions}
              placeholder={SELECT_ORGANIZATION}
              status={organizationTouched && organizationMissing ? 'danger' : undefined}
              onChange={(value) => {
                setOrganizationTouched(true);
                setOrganizationId(value);
              }}
              onBlur={() => setOrganizationTouched(true)}
            />
          )}
          {organizationHelper}
        </FormGroup>

        <FormGroup label="Priority" fieldId="subscription-priority" isRequired>
          <NumberInput
            id="subscription-priority"
            data-testid="subscription-priority"
            inputAriaLabel="Priority"
            minusBtnAriaLabel="Decrease priority"
            plusBtnAriaLabel="Increase priority"
            value={priority == null || Number.isNaN(priority) ? '' : priority}
            min={MIN_PRIORITY}
            max={MAX_PRIORITY}
            onMinus={() =>
              setPriority(Math.max(MIN_PRIORITY, (priority == null || Number.isNaN(priority) ? 0 : priority) - 1))
            }
            onPlus={() =>
              setPriority(Math.min(MAX_PRIORITY, (priority == null || Number.isNaN(priority) ? 0 : priority) + 1))
            }
            onChange={(event: React.FormEvent<HTMLInputElement>) => {
              const inputValue = event.currentTarget.value;
              if (inputValue === '') {
                setPriority(NaN);
              } else {
                const parsed = parseInt(inputValue, 10);
                if (!Number.isNaN(parsed)) {
                  setPriority(Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, parsed)));
                }
              }
            }}
          />
          <FormHelperText>
            <HelperText>
              <HelperTextItem variant={isPriorityValid ? 'default' : 'error'}>
                {isPriorityValid ? 'Higher numbers indicate higher priority.' : fieldErrors.priority}
              </HelperTextItem>
            </HelperText>
          </FormHelperText>
        </FormGroup>

        <FormGroup label="Groups" fieldId="subscription-groups" isRequired>
          <MultiSelection
            ariaLabel="Enter groups"
            toggleAriaLabel="Groups options"
            value={selectedGroups}
            setValue={(newValue) => {
              setGroupsTouched(true);
              setSelectedGroups(newValue);
            }}
            toggleTestId="subscription-groups"
            isCreatable
            createOptionMessage={(value) => `Add group "${value}"`}
            placeholder="Type a group name"
          />
          {groupsTouched && fieldErrors.groups ? (
            errorText(fieldErrors.groups)
          ) : (
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  Type each group name and choose Add group. Members of these groups can use the models.
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          )}
          {selectedGroupNames.includes(SYSTEM_AUTHENTICATED_GROUP) && <SystemAuthenticatedWarning />}
        </FormGroup>

        {showNoModelsWarning ? (
          <Alert variant="warning" isInline title="No models available" data-testid="no-models-warning">
            There are no model endpoints available on the cluster. To create a subscription, first ask your MaaS
            administrator to make a model endpoint available.
          </Alert>
        ) : (
          <MaasModelsSection
            rows={rows}
            editable
            onAddModels={canAddModels ? () => setIsAddModelsModalOpen(true) : undefined}
            onEditLimits={(index) => setEditLimitsTarget(index)}
            onRemoveModel={(index) => {
              setModelsTouched(true);
              handleRemoveModel(index);
            }}
            validationError={modelsTouched ? fieldErrors.models : undefined}
          />
        )}

        {isAddModelsModalOpen && canAddModels && (
          <AddModelsModal
            availableModels={availableModels}
            currentModels={models}
            onAdd={(added) => {
              setModelsTouched(true);
              handleAddModels(added);
            }}
            onRemove={(removed) => {
              setModelsTouched(true);
              handleRemoveModels(removed);
            }}
            onClose={() => setIsAddModelsModalOpen(false)}
          />
        )}

        {editLimitsTarget != null && editingModel && (
          <EditRateLimitsModal
            modelName={refTitleOf(editingModel.ref, editingModel.model)}
            rateLimits={editingModel.tokenRateLimits}
            onSave={handleSaveRateLimits}
            onClose={handleCloseRateLimitsModal}
          />
        )}

        {showPolicyWarning && (
          <Alert
            variant="warning"
            isInline
            title="Only a policy created with this subscription is updated"
            data-testid="policy-change-warning"
          >
            The authorization policy created with this subscription follows these changes. Update any other policy for
            it from the <b>authorization policy administration tool</b> after saving.
          </Alert>
        )}

        {submitError && (
          <Alert variant="danger" isInline title={`Unable to ${isEditing ? 'update' : 'create'} subscription`}>
            {submitError}
          </Alert>
        )}

        <ActionGroup>
          <Button
            variant="primary"
            onClick={handleSubmit}
            isDisabled={!canSubmit}
            isLoading={isSubmitting}
            data-testid={isEditing ? 'update-subscription-button' : 'create-subscription-button'}
          >
            {isEditing ? (isSubmitting ? 'Saving...' : 'Save') : isSubmitting ? 'Creating...' : 'Create subscription'}
          </Button>
          <Button
            variant="link"
            onClick={requestLeave}
            isDisabled={isSubmitting}
            data-testid="cancel-subscription-button"
          >
            Cancel
          </Button>
        </ActionGroup>
      </Form>
      {discardModal}
    </>
  );
};
