// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/createSubscription/CreateSubscriptionForm.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/createSubscription/CreateSubscriptionForm.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The console adds the Organization field: required on create, kept on edit. Telemetry is dropped.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ActionGroup,
  Alert,
  Button,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  NumberInput,
  PageSection,
} from '@patternfly/react-core';
import { z } from 'zod';
import { ServiceError } from '../../../api/ConsoleService';
import type { SubscriptionsService } from '../../../api/subscriptions';
import type {
  CreateSubscriptionRequest,
  MaaSModelRefSummary,
  SubscriptionInfoResponse,
  UpdateSubscriptionRequest,
} from '../../../api/types';
import { SYSTEM_AUTHENTICATED_GROUP } from '../../../api/types';
import { AddModelsModal } from '../../../components/AddModelsModal';
import { K8sNameDescriptionField } from '../../../components/K8sNameDescriptionField/K8sNameDescriptionField';
import { isK8sNameDescriptionDataValid } from '../../../components/K8sNameDescriptionField/nameField';
import { useK8sNameDescriptionFieldData } from '../../../components/K8sNameDescriptionField/useK8sNameDescriptionFieldData';
import { MaasModelsSection } from '../../../components/MaasModelsSection';
import type { SelectionOptions } from '../../../components/MultiSelection';
import { MultiSelection } from '../../../components/MultiSelection';
import { SystemAuthenticatedWarning } from '../../../components/SystemAuthenticatedWarning';
import { useMaaSGovernanceContext } from '../../../context/useMaaSGovernanceContext';
import type { SubscriptionModelEntry } from '../../../hooks/useSubscriptionModels';
import { useSubscriptionModels } from '../../../hooks/useSubscriptionModels';
import { isSameModel } from '../../../utilities/authpolicies';
import { getSectionUrl } from '../../../utilities/maasGovernanceNavigation';
import { fieldErrorsOf } from '../../../validation';
import { EditRateLimitsModal } from './EditRateLimitsModal';

type Props = {
  service: SubscriptionsService;
  modelRefs: MaaSModelRefSummary[];
  subscriptionInfo?: SubscriptionInfoResponse;
  returnTo?: string;
};

const MAX_PRIORITY = 1000000;
const MIN_PRIORITY = -1000000;
const SELECT_ORGANIZATION = 'Select an organization';

const subscriptionFormSchema = z.object({
  priority: z
    .number({ message: 'Priority is required' })
    .int('Priority must be a whole number')
    .min(MIN_PRIORITY, `Priority must be at least ${MIN_PRIORITY}`)
    .max(MAX_PRIORITY, `Priority must be at most ${MAX_PRIORITY}`),
  groups: z.array(z.string()).min(1, 'One or more groups must be selected'),
  models: z.array(z.unknown()).min(1, 'One or more models must be added'),
});

const buildInitialModels = (info: SubscriptionInfoResponse): SubscriptionModelEntry[] =>
  info.subscription.modelRefs.map((ref) => ({
    modelRefSummary: info.modelRefs.find((s) => isSameModel(s, ref)) ?? {
      name: ref.name,
      namespace: ref.namespace,
      modelRef: { kind: '', name: '' },
    },
    tokenRateLimits: ref.tokenRateLimits,
    unlimited: ref.unlimited,
  }));

const errorText = (message: string) => (
  <FormHelperText>
    <HelperText>
      <HelperTextItem variant="error">{message}</HelperTextItem>
    </HelperText>
  </FormHelperText>
);

export const CreateSubscriptionForm: React.FC<Props> = ({ service, modelRefs, subscriptionInfo, returnTo }) => {
  const navigate = useNavigate();
  const { refresh, organizations, organizationsError } = useMaaSGovernanceContext();
  const isEditing = !!subscriptionInfo;
  const subscription = subscriptionInfo?.subscription;

  const { data: nameDescData, onDataChange: onNameDescChange } = useK8sNameDescriptionFieldData(
    subscription
      ? {
          initialData: {
            name: subscription.displayName ?? subscription.name,
            k8sName: subscription.name,
            description: subscription.description ?? '',
          },
        }
      : undefined,
  );

  const [selectedGroups, setSelectedGroups] = useState<SelectionOptions[]>(() =>
    (subscription?.owner.groups ?? []).map(({ name }) => ({ id: name, name, selected: true })),
  );
  const [groupsTouched, setGroupsTouched] = useState(false);
  const [modelsTouched, setModelsTouched] = useState(false);
  const [organizationId, setOrganizationId] = useState(subscription?.tokenMetadata?.organizationId ?? '');
  const [organizationTouched, setOrganizationTouched] = useState(false);
  const [priority, setPriority] = useState<number | undefined>(subscription?.priority ?? 0);
  // Every subscription created here gets a matching authorization policy, as in the PoC.
  const createAuthPolicy = true;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [initialModels] = useState<SubscriptionModelEntry[]>(() =>
    subscriptionInfo ? buildInitialModels(subscriptionInfo) : [],
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
    handleRemoveModelsByRef,
    handleSaveRateLimits,
    handleCloseRateLimitsModal,
  } = useSubscriptionModels(initialModels);

  const isNameValid = isK8sNameDescriptionDataValid(nameDescData);
  const selectedGroupNames = selectedGroups.filter((g) => g.selected).map((g) => String(g.id));

  const initialGroupNames = useMemo(
    () => new Set(subscription ? subscription.owner.groups.map((g) => g.name) : []),
    [subscription],
  );
  const initialModelRefs = useMemo(() => subscription?.modelRefs ?? [], [subscription]);
  const groupsChanged =
    isEditing &&
    (selectedGroupNames.length !== initialGroupNames.size || selectedGroupNames.some((g) => !initialGroupNames.has(g)));
  const modelsChanged =
    isEditing &&
    (models.length !== initialModelRefs.length ||
      models.some((m) => !initialModelRefs.some((ref) => isSameModel(ref, m.modelRefSummary))));
  const showPolicyWarning = isEditing && (groupsChanged || modelsChanged);

  const fieldErrors = fieldErrorsOf(subscriptionFormSchema, {
    priority: priority == null || Number.isNaN(priority) ? Number.NaN : priority,
    groups: selectedGroupNames,
    models,
  });
  const isPriorityValid = priority != null && !Number.isNaN(priority);
  const organizationMissing = !isEditing && !organizationId;

  const canSubmit =
    isNameValid &&
    Object.keys(fieldErrors).length === 0 &&
    allModelsHaveRateLimits &&
    isPriorityValid &&
    !organizationMissing &&
    !isSubmitting;

  // Each reference names its model's namespace (P6), so a model of the same name elsewhere isn't it.
  const modelRefsPayload = models.map((m) => {
    const ref = {
      ...subscription?.modelRefs.find((r) => isSameModel(r, m.modelRefSummary)),
      name: m.modelRefSummary.name,
      tokenRateLimits: m.tokenRateLimits,
      unlimited: m.unlimited,
    };
    const namespace = m.modelRefSummary.namespace ?? ref.namespace;
    return namespace ? { ...ref, namespace } : ref;
  });

  // The organization select lists the organizations by name; an edited subscription keeps its
  // organization even when the backend no longer lists it.
  const organizationOptions = useMemo(() => {
    const options = [...organizations]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((o) => ({ value: o.id, label: o.name }));
    const current = subscription?.tokenMetadata?.organizationId;
    if (current && !options.some((o) => o.value === current)) {
      options.push({ value: current, label: current });
    }
    return options;
  }, [organizations, subscription]);

  const handleSubmit = async () => {
    if (priority == null || Number.isNaN(priority)) {
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      if (isEditing && subscription) {
        const trimmedName = nameDescData.name.trim();
        const originalName = subscription.displayName ?? subscription.name;
        const request: UpdateSubscriptionRequest = {
          displayName: trimmedName !== originalName ? trimmedName || undefined : subscription.displayName,
          description: nameDescData.description.trim() || undefined,
          owner: { ...subscription.owner, groups: selectedGroupNames.map((g) => ({ name: g })) },
          modelRefs: modelRefsPayload,
          tokenMetadata: organizationId
            ? { ...subscription.tokenMetadata, organizationId }
            : subscription.tokenMetadata,
          inferencePriority: subscription.inferencePriority,
          guardrails: subscription.guardrails,
          priority,
        };
        await service.updateSubscription(subscription.name, request, subscription.resourceVersion);
      } else {
        const request: CreateSubscriptionRequest = {
          name: nameDescData.k8sName.value,
          displayName: nameDescData.name.trim() || undefined,
          description: nameDescData.description.trim() || undefined,
          owner: { groups: selectedGroupNames.map((g) => ({ name: g })) },
          modelRefs: modelRefsPayload,
          priority,
          tokenMetadata: { organizationId },
          createAuthPolicy,
        };
        await service.createSubscription(request);
      }
      refresh();
      navigate(returnTo ?? getSectionUrl('subscriptions'), {
        state: { notice: isEditing ? 'Subscription updated' : 'Subscription created' },
      });
    } catch (e) {
      setSubmitError(
        e instanceof ServiceError && e.isNotImplemented
          ? `${isEditing ? 'Saving' : 'Creating'} subscriptions is not available on this backend yet.`
          : e instanceof Error
            ? e.message
            : `Failed to ${isEditing ? 'update' : 'create'} subscription`,
      );
      setIsSubmitting(false);
    }
  };

  const showNoModelsWarning = !isEditing && modelRefs.length === 0 && models.length === 0;
  const canAddModels = modelRefs.length > 0;

  let organizationHelper = (
    <FormHelperText>
      <HelperText>
        <HelperTextItem>The organization whose users this subscription serves.</HelperTextItem>
      </HelperText>
    </FormHelperText>
  );
  if (organizationsError) {
    organizationHelper = errorText(`Organizations could not be loaded: ${organizationsError.message}`);
  } else if (organizationTouched && organizationMissing) {
    organizationHelper = errorText(SELECT_ORGANIZATION);
  }

  return (
    <PageSection hasBodyWrapper={false}>
      <Form maxWidth="750px">
        <K8sNameDescriptionField
          data={nameDescData}
          onDataChange={onNameDescChange}
          dataTestId="subscription-name-desc"
        />

        <FormGroup label="Organization" fieldId="subscription-organization" isRequired={!isEditing}>
          <FormSelect
            id="subscription-organization"
            data-testid="subscription-organization"
            value={organizationId}
            validated={organizationTouched && organizationMissing ? 'error' : 'default'}
            onChange={(_event, value) => {
              setOrganizationTouched(true);
              setOrganizationId(value);
            }}
            onBlur={() => setOrganizationTouched(true)}
          >
            {(!isEditing || !subscription?.tokenMetadata?.organizationId) && (
              <FormSelectOption value="" label={SELECT_ORGANIZATION} isPlaceholder />
            )}
            {organizationOptions.map((o) => (
              <FormSelectOption key={o.value} value={o.value} label={o.label} />
            ))}
          </FormSelect>
          {organizationHelper}
        </FormGroup>

        <FormGroup label="Priority" fieldId="subscription-priority" isRequired>
          <FormHelperText>
            <HelperText>
              <HelperTextItem variant="default">Higher numbers indicate higher priority.</HelperTextItem>
            </HelperText>
          </FormHelperText>
          <NumberInput
            id="subscription-priority"
            data-testid="subscription-priority"
            inputAriaLabel="Priority"
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
        </FormGroup>

        <FormGroup label="Groups" fieldId="subscription-groups" isRequired>
          <FormHelperText>
            <HelperText>
              <HelperTextItem>
                Type each group name and choose Add group to grant access to models in this subscription.
              </HelperTextItem>
            </HelperText>
          </FormHelperText>
          <MultiSelection
            ariaLabel="Enter groups"
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
          {selectedGroupNames.includes(SYSTEM_AUTHENTICATED_GROUP) && <SystemAuthenticatedWarning />}
          {groupsTouched && fieldErrors.groups && errorText(fieldErrors.groups)}
        </FormGroup>

        {showNoModelsWarning ? (
          <Alert variant="warning" isInline title="No models available" data-testid="no-models-warning">
            There are no model endpoints available on the cluster. To create a subscription, first ask your MaaS
            administrator to make a model endpoint available.
          </Alert>
        ) : (
          <MaasModelsSection
            modelRefSummaries={models.map((m) => m.modelRefSummary)}
            modelRefsWithRateLimits={models.map((m) => ({
              name: m.modelRefSummary.name,
              namespace: m.modelRefSummary.namespace,
              tokenRateLimits: m.tokenRateLimits,
              unlimited: m.unlimited,
            }))}
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
            availableModelRefs={modelRefs}
            currentModels={models}
            onAdd={(refs) => {
              setModelsTouched(true);
              handleAddModels(refs);
            }}
            onRemove={(refs) => {
              setModelsTouched(true);
              handleRemoveModelsByRef(refs);
            }}
            onClose={() => setIsAddModelsModalOpen(false)}
          />
        )}

        {editLimitsTarget != null && editingModel && (
          <EditRateLimitsModal
            modelName={editingModel.modelRefSummary.displayName ?? editingModel.modelRefSummary.name}
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
          <Alert variant="danger" isInline title={`Failed to ${isEditing ? 'update' : 'create'} subscription`}>
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
            onClick={() => navigate(returnTo ?? getSectionUrl('subscriptions'))}
            isDisabled={isSubmitting}
            data-testid="cancel-subscription-button"
          >
            Cancel
          </Button>
        </ActionGroup>
      </Form>
    </PageSection>
  );
};
