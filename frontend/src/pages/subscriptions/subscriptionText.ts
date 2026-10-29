// How the subscription pages word the backend's Subscriptions, Models and Tenants messages: the thin
// selector layer ADR-0002 allows. What each field means is the backend's (proto/ai_grid/v1 at
// .backend-api-version); nothing here derives a value the backend doesn't send.
import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';
import type { Condition } from '../../gen/ai_grid/v1/condition_type_pb';
import type { Metadata } from '../../gen/ai_grid/v1/metadata_type_pb';
import { ModelPhase, type Model } from '../../gen/ai_grid/v1/model_type_pb';
import type {
  ModelRegistration,
  Subscription,
  SubscriptionModelRef,
  TokenRateLimit,
} from '../../gen/ai_grid/v1/subscription_type_pb';
import type { Tenant } from '../../gen/ai_grid/v1/tenant_type_pb';
import { MODEL_NOT_FOUND_STATUS_MESSAGE, normalizePhase } from '../../utilities/phaseLabelUtils';
import type { TokenLimit } from '../../utilities/rateLimits';

/**
 * The annotations a subscription, its policy and a model keep their display name and description
 * in: the only prefixed keys the backend accepts on them (docs/UI_API_REFERENCE.md, and
 * validateGitMetadata in internal/servers/subscriptions_git.go).
 */
export const ANNOTATION_DISPLAY_NAME = 'openshift.io/display-name';
export const ANNOTATION_DESCRIPTION = 'openshift.io/description';

/** The backend's Ready condition reason for a status git mode doesn't read from the clusters. */
const REASON_SAVED_TO_GIT = 'SavedToGit';

/** An object's display name: its display-name annotation, else its id. */
export const displayNameOf = (object: { id: string; metadata?: Metadata }): string =>
  object.metadata?.annotations[ANNOTATION_DISPLAY_NAME]?.trim() || object.id;

/** An object's description annotation; empty without one. */
export const descriptionOf = (object: { metadata?: Metadata }): string =>
  object.metadata?.annotations[ANNOTATION_DESCRIPTION]?.trim() ?? '';

/** A timestamp as an ISO string for RelativeTime; undefined when the backend sent none. */
export const isoTime = (time: Timestamp | undefined): string | undefined =>
  time ? timestampDate(time).toISOString() : undefined;

/** Whether the backend reports the object as being deleted (metadata.deletion_timestamp). */
export const isDeleting = (object: { metadata?: Metadata }): boolean => !!object.metadata?.deletionTimestamp;

/** The organization the subscription belongs to: spec.organization.id, empty without one. */
export const organizationIdOf = (subscription: Subscription): string => subscription.spec?.organization?.id ?? '';

/** The organization's name (metadata.name), else its id. */
export const tenantNameOf = (tenant: Tenant): string => tenant.metadata?.name || tenant.id;

/** The subscription's owner groups, as the backend answers them: bare group names. */
export const groupsOf = (subscription: Subscription): string[] => subscription.spec?.owner?.groups ?? [];

/** The subscription's model refs. */
export const modelRefsOf = (subscription: Subscription): SubscriptionModelRef[] => subscription.spec?.modelRefs ?? [];

/** The Ready condition's reason and message, which a status label's tooltip shows. */
export type ConditionText = { reason?: string; statusMessage?: string };

/** The Ready condition of an object's conditions; empty without one. */
export const readyConditionOf = (conditions: Condition[] | undefined): ConditionText => {
  const ready = conditions?.find((c) => c.type === 'Ready');
  return ready ? { reason: ready.reason, statusMessage: ready.message } : {};
};

/** The ref that names this model: the backend's model_id join (SubscriptionModelRef.model_id). */
export const refForModel = (refs: SubscriptionModelRef[], modelId: string): SubscriptionModelRef | undefined =>
  refs.find((ref) => ref.modelId === modelId);

/** The model a ref names, by the backend's model_id join; undefined for a ref it couldn't join. */
export const modelForRef = (models: Model[], ref: SubscriptionModelRef): Model | undefined =>
  ref.modelId ? models.find((m) => m.id === ref.modelId) : undefined;

/** A ref's title: the display name the backend joined, else its model's, else its name. */
export const refTitleOf = (ref: SubscriptionModelRef, model?: Model): string =>
  ref.displayName || (model && displayNameOf(model)) || ref.name;

/** A key for a ref in React lists: its namespace and name, as the backend writes it. */
export const refKey = (ref: { name: string; namespace: string }): string => `${ref.namespace}/${ref.name}`;

/**
 * A model's phase, worded as the Models page words it (utilities/status). Git mode reports no phase
 * with reason SavedToGit until a cluster has reported (ModelStatus.reason); an UNSPECIFIED phase
 * otherwise, or one this pin doesn't know, is Unknown.
 */
export const modelPhaseOf = (model: Model): string => {
  switch (model.status?.phase) {
    case ModelPhase.READY:
      return 'Ready';
    case ModelPhase.PENDING:
      return 'Pending';
    case ModelPhase.FAILED:
      return 'Failed';
    case ModelPhase.PARTIALLY_AVAILABLE:
      return 'Partially available';
    default:
      return model.status?.reason === REASON_SAVED_TO_GIT ? 'Saved to Git' : 'Unknown';
  }
};

/** A registration's status: the label's word and its reason (the Ready condition's message). */
export type RegistrationStatus = { status: string; reason?: string };

/**
 * A referenced model's status on the subscription's page, from Subscriptions/Get's
 * model_registrations: the registration's phase (Ready or Pending in git mode), Saved to Git for one
 * with no phase and a Ready condition of reason SavedToGit, and Not found for a ref without a
 * registration, which the backend's gitModelRegistrations says a client takes as missing.
 */
export const registrationStatusOf = (
  registrations: ModelRegistration[],
  ref: SubscriptionModelRef,
): RegistrationStatus => {
  const registration = registrations.find((r) => r.name === ref.name && r.namespace === ref.namespace);
  if (!registration) {
    return { status: 'Not found', reason: MODEL_NOT_FOUND_STATUS_MESSAGE };
  }
  const ready = registration.conditions.find((c) => c.type === 'Ready');
  if (!registration.phase && ready?.reason === REASON_SAVED_TO_GIT) {
    return { status: 'Saved to Git', reason: ready.message };
  }
  return { status: normalizePhase(registration.phase), reason: ready?.message };
};

/** A ref's token limits as the form edits them. */
export const toTokenLimits = (limits: TokenRateLimit[]): TokenLimit[] =>
  limits.map(({ limit, window }) => ({ limit: Number(limit), window }));
