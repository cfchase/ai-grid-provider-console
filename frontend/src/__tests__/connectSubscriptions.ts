// The backend's Subscriptions API for page tests, in memory, with Models/List and Tenants/List over
// a MockConsoleService's models and organizations. It answers as the backend's git mode does at
// .backend-api-version (internal/servers/subscriptions_server.go and subscriptions_git.go): Active,
// Pending or no phase; a managed <id>-policy; a model ref joined to its model by model_id; versions
// from 1, Aborted on a stale one; refs to a model that doesn't exist refused.
import { clone, create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import type { FakeBackend } from '../api/connect/testing';
import type { ManagedModel, Organization } from '../api/types';
import { ConditionStatus } from '../gen/ai_grid/v1/condition_type_pb';
import { MetadataSchema } from '../gen/ai_grid/v1/metadata_type_pb';
import { ModelPhase, ModelSchema, type Model } from '../gen/ai_grid/v1/model_type_pb';
import {
  AuthPolicySchema,
  ModelRegistrationSchema,
  SubscriptionSchema,
  SubscriptionSpecSchema,
  type AuthPolicy,
  type ModelRegistration,
  type Subscription,
} from '../gen/ai_grid/v1/subscription_type_pb';
import { TenantSchema } from '../gen/ai_grid/v1/tenant_type_pb';
import { ANNOTATION_DESCRIPTION, ANNOTATION_DISPLAY_NAME } from '../pages/subscriptions/subscriptionText';

/** The backend's default subscription namespace (AI_GRID_SUBSCRIPTION_NAMESPACE), where refs point. */
export const SUBSCRIPTION_NAMESPACE = 'models-as-a-service';
/** The fixture organization acme-robotics (MockConsoleService's seedOrganizations). */
export const ACME_ID = '3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c';

const ready = (message: string) => ({
  type: 'Ready',
  status: ConditionStatus.TRUE,
  reason: 'Ready',
  message,
});

const annotations = (displayName?: string, description?: string) => ({
  ...(displayName ? { [ANNOTATION_DISPLAY_NAME]: displayName } : {}),
  ...(description ? { [ANNOTATION_DESCRIPTION]: description } : {}),
});

const limits = (...pairs: [number, string][]) => pairs.map(([limit, window]) => ({ limit: BigInt(limit), window }));

/**
 * The PoC's subscriptions (MockConsoleService's former seed), as git mode reports them: engineering
 * Active in acme-robotics, data-science Pending, research with no report yet and a ref to a model
 * the catalog doesn't have.
 */
export const seedSubscriptions = (): Subscription[] => [
  create(SubscriptionSchema, {
    id: 'engineering',
    metadata: {
      name: 'engineering',
      version: 1,
      annotations: annotations('Engineering', 'Production models for the engineering team.'),
      creationTimestamp: timestampFromDate(new Date('2026-09-01T09:00:00Z')),
    },
    spec: {
      owner: { groups: ['engineering'] },
      priority: 100,
      organization: { id: ACME_ID },
      tokenMetadata: { costCenter: 'engineering', labels: { environment: 'production' } },
      modelRefs: [
        {
          name: 'granite-3-8b',
          namespace: SUBSCRIPTION_NAMESPACE,
          tokenRateLimits: limits([100000, '1h'], [10000, '1m']),
          billingRate: { perToken: '0.000002' },
        },
      ],
    },
    status: { phase: 'Active' },
  }),
  create(SubscriptionSchema, {
    id: 'data-science',
    metadata: {
      name: 'data-science',
      version: 1,
      annotations: annotations('Data science', 'Shared model access for data scientists.'),
    },
    spec: {
      owner: { groups: ['data-scientists', 'platform-admins'] },
      priority: 10,
      modelRefs: ['granite-3-8b', 'llama-3-70b'].map((name) => ({
        name,
        namespace: SUBSCRIPTION_NAMESPACE,
        tokenRateLimits: limits([50000, '1h']),
      })),
    },
    status: { phase: 'Pending' },
  }),
  create(SubscriptionSchema, {
    id: 'research',
    metadata: { name: 'research', version: 1, annotations: annotations('Research', 'Experimental endpoint access.') },
    spec: {
      owner: { groups: ['research'] },
      modelRefs: [{ name: 'retired-llm', namespace: SUBSCRIPTION_NAMESPACE, tokenRateLimits: limits([1000, '1h']) }],
    },
  }),
];

/** Each seed subscription's managed policy, Active with its Ready condition. */
const seedPolicies = (subscriptions: Subscription[]): AuthPolicy[] =>
  subscriptions.map((s) =>
    create(AuthPolicySchema, {
      id: `${s.id}-policy`,
      metadata: {
        name: `${s.id}-policy`,
        annotations: annotations(`${s.metadata?.annotations[ANNOTATION_DISPLAY_NAME]} policy`),
      },
      subjectGroups: s.spec?.owner?.groups ?? [],
      modelRefs: (s.spec?.modelRefs ?? []).map(({ name, namespace }) => ({ name, namespace })),
      phase: 'Active',
      conditions: [ready('Ready on site1')],
    }),
  );

/** A ManagedModel's phase as the backend's enum and reason. */
const phaseOf = (phase: string | undefined): { phase: ModelPhase; reason: string } => {
  switch (phase) {
    case 'Ready':
      return { phase: ModelPhase.READY, reason: 'Ready' };
    case 'Failed':
      return { phase: ModelPhase.FAILED, reason: 'Failed' };
    case 'Partially available':
      return { phase: ModelPhase.PARTIALLY_AVAILABLE, reason: 'PartiallyAvailable' };
    case 'Saved to Git':
      return { phase: ModelPhase.UNSPECIFIED, reason: 'SavedToGit' };
    default:
      return { phase: ModelPhase.PENDING, reason: 'NotReady' };
  }
};

/** A ManagedModel as the backend's Model: the fields the subscription pages read. */
export const toModel = (m: ManagedModel): Model =>
  create(ModelSchema, {
    id: m.name,
    metadata: {
      name: m.name,
      annotations: annotations(m.displayName, m.description),
      version: Number(m.resourceVersion),
    },
    status: {
      ...phaseOf(m.phase),
      message: m.statusMessage ?? '',
      placement: { selectedClusters: m.selectedClusters, locations: m.locations },
    },
  });

/** An organization as the backend's Tenant. */
export const toTenant = (o: Organization) =>
  create(TenantSchema, { id: o.id, metadata: { name: o.name }, spec: { domains: o.domains } });

/** What the Models and Tenants lists read. */
export type SubscriptionsSource = {
  listModels: () => Promise<ManagedModel[]>;
  listOrganizations: () => Promise<Organization[]>;
};

type Impl = Required<NonNullable<FakeBackend['subscriptions']>>;
type Method = 'list' | 'get' | 'create' | 'update' | 'delete';

/** The one filter the console sends: the subscriptions whose refs name a model (the backend's README). */
const MODEL_FILTER = /^this\.spec\.model_refs\.exists\(r, r\.model_id == "([^"]*)"\)$/;

/** The in-memory subscriptions, their policies and their models' registrations. */
export class FakeSubscriptions {
  subscriptions: Subscription[] = seedSubscriptions();
  policies: AuthPolicy[] = seedPolicies(this.subscriptions);
  /** The MaaSModelRef reports, by model; a model without one is Saved to Git. */
  registrations: ModelRegistration[] = [
    create(ModelRegistrationSchema, {
      name: 'granite-3-8b',
      namespace: SUBSCRIPTION_NAMESPACE,
      phase: 'Ready',
      conditions: [ready('Ready on site1')],
    }),
    create(ModelRegistrationSchema, {
      name: 'llama-3-70b',
      namespace: SUBSCRIPTION_NAMESPACE,
      phase: 'Pending',
      conditions: [{ type: 'Ready', status: ConditionStatus.FALSE, reason: 'NotReady', message: 'Not ready on site2' }],
    }),
  ];

  /** What Subscriptions/List answers instead, while set: a test's failed load. */
  listError?: ConnectError;
  /**
   * Runs before each method, so a test can make one fail (throw), wait (return a promise) or count
   * its calls; requests are recorded in `requests`.
   */
  before: Partial<Record<Method, (request: unknown) => unknown>> = {};
  requests: { method: Method; request: unknown }[] = [];

  constructor(private readonly listModels: () => Promise<ManagedModel[]>) {}

  /** The requests of one method, as the backend received them. */
  sent<M extends Method>(method: M): Parameters<Impl[M]>[0][] {
    return this.requests.filter((r) => r.method === method).map((r) => r.request as Parameters<Impl[M]>[0]);
  }

  private async enter(method: Method, request: unknown, models = true): Promise<ManagedModel[]> {
    this.requests.push({ method, request });
    await this.before[method]?.(request);
    return models ? this.listModels() : [];
  }

  /** The subscription as an answer carries it: each ref joined to its model (modelCatalog.join). */
  private joined(subscription: Subscription, models: ManagedModel[]): Subscription {
    const out = clone(SubscriptionSchema, subscription);
    for (const ref of out.spec?.modelRefs ?? []) {
      const model = ref.namespace === SUBSCRIPTION_NAMESPACE && models.find((m) => m.name === ref.name);
      ref.modelId = model ? model.name : '';
      ref.displayName = model ? (model.displayName ?? '') : '';
      ref.description = model ? (model.description ?? '') : '';
    }
    return out;
  }

  private find(id: string): Subscription {
    const found = this.subscriptions.find((s) => s.id === id);
    if (!found) throw new ConnectError(`Subscription "${id}" not found`, Code.NotFound);
    return found;
  }

  /** A write's checks: an owner, an organization and models that exist (validateSubscriptionSpec, gitEnsureModelsExist). */
  private check(subscription: Subscription, models: ManagedModel[]): Subscription {
    const spec = subscription.spec;
    if (!spec?.owner?.groups.length) {
      throw new ConnectError('spec.owner must include at least one group or user', Code.InvalidArgument);
    }
    if (!spec.organization?.id) {
      throw new ConnectError('spec.organization.id is required', Code.InvalidArgument);
    }
    // A ref in the subscription namespace must name a model that exists; renderSubscriptionDoc
    // writes a ref without a namespace into it.
    for (const ref of spec.modelRefs) {
      ref.namespace ||= SUBSCRIPTION_NAMESPACE;
      if (ref.namespace === SUBSCRIPTION_NAMESPACE && !models.some((m) => m.name === ref.name)) {
        throw new ConnectError(`model ${ref.name} does not exist`, Code.FailedPrecondition);
      }
    }
    return subscription;
  }

  backend(): Impl {
    return {
      list: async (request) => {
        const models = await this.enter('list', request);
        if (this.listError) throw this.listError;
        const { filter } = request;
        let items = this.subscriptions.map((s) => this.joined(s, models));
        if (filter) {
          const model = MODEL_FILTER.exec(filter)?.[1];
          if (model === undefined) throw new ConnectError(`the fake can't evaluate ${filter}`, Code.InvalidArgument);
          items = items.filter((s) => s.spec?.modelRefs.some((r) => r.modelId === model));
        }
        items.sort((a, b) => a.id.localeCompare(b.id));
        return { items, size: items.length, total: items.length };
      },
      get: async (request) => {
        const models = await this.enter('get', request);
        const subscription = this.joined(this.find(request.id), models);
        const refs = subscription.spec?.modelRefs ?? [];
        const named = (r: { name: string; namespace: string }) =>
          refs.some((ref) => ref.name === r.name && ref.namespace === r.namespace);
        // Git mode answers the subscription's own managed policy (gitGet).
        return {
          object: subscription,
          authPolicies: this.policies.filter((p) => p.id === `${subscription.id}-policy` && p.modelRefs.some(named)),
          // One per ref: its report, or Saved to Git (gitModelRegistrations); none for a missing model.
          modelRegistrations: refs
            .filter((ref) => ref.modelId)
            .map(
              (ref) =>
                this.registrations.find((r) => r.name === ref.name && r.namespace === ref.namespace) ??
                create(ModelRegistrationSchema, {
                  name: ref.name,
                  namespace: ref.namespace,
                  conditions: [
                    {
                      type: 'Ready',
                      status: ConditionStatus.UNSPECIFIED,
                      reason: 'SavedToGit',
                      message: "Saved to Git; no cluster has reported the model's status",
                    },
                  ],
                }),
            ),
        };
      },
      create: async (request) => {
        const models = await this.enter('create', request);
        const { object } = request;
        if (!object) throw new ConnectError('object is required', Code.InvalidArgument);
        if (this.subscriptions.some((s) => s.id === object.id)) {
          throw new ConnectError(`Subscription "${object.id}" already exists`, Code.AlreadyExists);
        }
        const subscription = this.check(clone(SubscriptionSchema, object), models);
        subscription.metadata = create(MetadataSchema, {
          name: subscription.id,
          version: 1,
          labels: { ...object.metadata?.labels },
          annotations: { ...object.metadata?.annotations },
        });
        subscription.status = undefined;
        this.subscriptions.push(subscription);
        const policy = create(AuthPolicySchema, {
          id: `${subscription.id}-policy`,
          metadata: { name: `${subscription.id}-policy` },
          subjectGroups: subscription.spec?.owner?.groups ?? [],
          modelRefs: (subscription.spec?.modelRefs ?? []).map(({ name, namespace }) => ({ name, namespace })),
        });
        this.policies.push(policy);
        return { object: this.joined(subscription, models), authPolicy: policy };
      },
      update: async (request) => {
        const models = await this.enter('update', request);
        const { object, updateMask, lock } = request;
        if (!object) throw new ConnectError('object is required', Code.InvalidArgument);
        const stored = this.find(object.id);
        const version = object.metadata?.version ?? 0;
        if (lock && version === 0) throw new ConnectError('lock requires metadata.version', Code.InvalidArgument);
        if (lock && version !== stored.metadata?.version) {
          throw new ConnectError(
            `update Subscription "${object.id}": the subscription changed since it was read; reload and retry`,
            Code.Aborted,
          );
        }
        const next = clone(SubscriptionSchema, stored);
        const paths = updateMask?.paths ?? [];
        if (paths.includes('spec') && object.spec) next.spec = clone(SubscriptionSpecSchema, object.spec);
        if (paths.includes('metadata.annotations') && next.metadata) {
          next.metadata.annotations = { ...object.metadata?.annotations };
        }
        this.check(next, models);
        if (next.metadata) next.metadata.version += 1;
        this.subscriptions = this.subscriptions.map((s) => (s.id === next.id ? next : s));
        return { object: this.joined(next, models) };
      },
      delete: async (request) => {
        await this.enter('delete', request, false);
        const { id, resourceVersion } = request;
        const stored = this.find(id);
        if (resourceVersion !== 0 && resourceVersion !== stored.metadata?.version) {
          throw new ConnectError(
            `delete Subscription "${id}": the subscription changed since it was read; reload and retry`,
            Code.Aborted,
          );
        }
        this.subscriptions = this.subscriptions.filter((s) => s.id !== id);
        this.policies = this.policies.filter((p) => p.id !== `${id}-policy`);
        return {};
      },
    };
  }
}

/** The fakes of every service: one per MockConsoleService, so a test can change them. */
const fakes = new WeakMap<object, FakeSubscriptions>();

/** The subscriptions a test's service answers over Connect, joined to the service's models. */
export const subscriptionsOf = (service: SubscriptionsSource): FakeSubscriptions => {
  let fake = fakes.get(service);
  if (!fake) {
    // A MockConsoleService's own models, so a test that makes the page's Models/List fail or wait
    // leaves the subscriptions' joins as they are; another service's list otherwise.
    const own = (service as { models?: ManagedModel[] }).models;
    fake = new FakeSubscriptions(() => (own ? Promise.resolve(own) : service.listModels()));
    fakes.set(service, fake);
  }
  return fake;
};

/** Subscriptions, and Models/List and Tenants/List, over the service. */
export const subscriptionsBackend = (
  service: SubscriptionsSource,
  call: <T>(fn: () => Promise<T>) => Promise<T>,
): Pick<FakeBackend, 'subscriptions' | 'models' | 'tenants'> => ({
  subscriptions: subscriptionsOf(service).backend(),
  models: {
    list: async () => {
      const items = (await call(() => service.listModels())).map(toModel);
      return { items, size: items.length, total: items.length };
    },
  },
  tenants: {
    list: async () => {
      const items = (await call(() => service.listOrganizations())).map(toTenant);
      return { items, size: items.length, total: items.length };
    },
  },
});
