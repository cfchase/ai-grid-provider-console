// The Subscriptions pages' calls to the backend over Connect (docs/connect.md): Subscriptions/List,
// Get, Create, Update and Delete, and Models/List and Tenants/List for the model picker, the
// models' locations and the organization select.
import { useCallback, useMemo } from 'react';
import { callUnaryMethod, createConnectQueryKey, useMutation, useQuery, useTransport } from '@connectrpc/connect-query';
import { useQueryClient } from '@tanstack/react-query';
import { toServiceError } from '../../api/connect/errors';
import { useConsoleSession } from '../../context/useConsoleSession';
import type { Model } from '../../gen/ai_grid/v1/model_type_pb';
import { list as listModels } from '../../gen/ai_grid/v1/models_service-Models_connectquery';
import type { Subscription } from '../../gen/ai_grid/v1/subscription_type_pb';
import { Subscriptions, type SubscriptionsGetResponse } from '../../gen/ai_grid/v1/subscriptions_service_pb';
import {
  create,
  delete$ as remove,
  get,
  list,
  update,
} from '../../gen/ai_grid/v1/subscriptions_service-Subscriptions_connectquery';
import type { Tenant } from '../../gen/ai_grid/v1/tenant_type_pb';
import { list as listTenants } from '../../gen/ai_grid/v1/tenants_service-Tenants_connectquery';

/** The lists poll as the other pages do. */
const POLL_MS = 30_000;

export type Loaded<T> = {
  data: T;
  /** The answer has arrived (or failed) at least once. */
  loaded: boolean;
  error?: Error;
  /** Loads again. True when the load succeeded. */
  refresh: () => Promise<boolean>;
};

/**
 * A failure as the ServiceError LoadError and the pages read. An ended session (401) after a
 * successful load shows nothing: the console shows the session-ended page once.
 */
const errorOf = (hasData: boolean, raw: unknown): Error | undefined => {
  if (!raw) return undefined;
  const err = toServiceError(raw);
  return hasData && err.isUnauthenticated ? undefined : err;
};

/** Poll until the session ends (`poll`), and no retries: the page offers Retry. */
const useLoadOptions = (poll: boolean) => {
  const { sessionEnded } = useConsoleSession();
  return { refetchInterval: poll && !sessionEnded ? POLL_MS : (false as const), retry: false };
};

const useList = <T>(query: {
  data?: { items: T[] };
  error: unknown;
  isFetched: boolean;
  refetch: () => Promise<{ isSuccess: boolean }>;
}): Loaded<T[]> => {
  const { data: answer, error, isFetched, refetch } = query;
  const data = useMemo(() => answer?.items ?? [], [answer]);
  const refresh = useCallback(async () => (await refetch()).isSuccess, [refetch]);
  return { data, loaded: isFetched, error: errorOf(!!answer, error), refresh };
};

/** Every subscription, from Subscriptions/List. */
export const useSubscriptionList = (): Loaded<Subscription[]> => useList(useQuery(list, {}, useLoadOptions(true)));

/** Every model, from Models/List: the model picker, and the models' names and locations. */
export const useModelList = (): Loaded<Model[]> => useList(useQuery(listModels, {}, useLoadOptions(true)));

/** Every organization, from Tenants/List: the organization select, and the organizations' names. */
export const useTenantList = (): Loaded<Tenant[]> => useList(useQuery(listTenants, {}, useLoadOptions(true)));

/**
 * One subscription with its auth policies and model registrations, from Subscriptions/Get, loaded
 * once: an edit form keeps what it opened with.
 */
export const useSubscription = (id: string): Loaded<SubscriptionsGetResponse | undefined> => {
  const query = useQuery(get, { id }, useLoadOptions(false));
  const { data, error, isFetched, refetch } = query;
  const refresh = useCallback(async () => (await refetch()).isSuccess, [refetch]);
  return { data: data?.object ? data : undefined, loaded: isFetched, error: errorOf(!!data, error), refresh };
};

/**
 * The subscriptions whose model refs name this model, by the backend's join
 * (SubscriptionModelRef.model_id; the CEL filter is the backend README's). Loaded once, for the
 * model's delete dialog.
 */
export const useSubscriptionsUsingModel = (modelId: string): Loaded<Subscription[]> =>
  useList(
    useQuery(
      list,
      { filter: `this.spec.model_refs.exists(r, r.model_id == ${JSON.stringify(modelId)})` },
      useLoadOptions(false),
    ),
  );

/** Refetches every Subscriptions query once a write lands. */
const useInvalidate = () => {
  const queryClient = useQueryClient();
  return useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: createConnectQueryKey({ schema: Subscriptions, cardinality: undefined }),
      }),
    [queryClient],
  );
};

/** Subscriptions/Create, Update and Delete; each refetches the subscriptions once it lands. */
export const useSubscriptionWrites = () => {
  const onSuccess = useInvalidate();
  const transport = useTransport();
  const createSubscription = useMutation(create, { onSuccess });
  const updateSubscription = useMutation(update, { onSuccess });
  const deleteSubscription = useMutation(remove, { onSuccess });
  /** The subscription as the backend has it now, for a retry after a failed delete. */
  const reload = useCallback(async (id: string) => (await callUnaryMethod(transport, get, { id })).object, [transport]);
  return { createSubscription, updateSubscription, deleteSubscription, reload };
};
