// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/maas-governance/SubscriptionsTab.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/maas-governance/SubscriptionsTab.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Telemetry is dropped. The page and its states are the console's (PageStateSection), and a delete
// says so in a toast, as every list does. It reads Subscriptions/List, Models/List and Tenants/List
// over Connect (useSubscriptions).
import { useCallback, useMemo, useState } from 'react';
import { Alert, AlertActionLink, Button, Stack, StackItem } from '@patternfly/react-core';
import { Link, useNavigate } from 'react-router-dom';
import { EmptyListState } from '../../components/states/EmptyListState';
import { PageStateSection } from '../../components/states/PageStateSection';
import { useConsoleSession } from '../../context/useConsoleSession';
import type { Subscription } from '../../gen/ai_grid/v1/subscription_type_pb';
import { getSubscriptionCreateUrl } from '../../utilities/maasGovernanceNavigation';
import { useClusterList } from '../clusters/useClusters';
import { siteNamesOf } from '../models/modelUtils';
import type { SubscriptionsFilterDataType } from './allSubscriptions/const';
import { initialSubscriptionsFilterData, SubscriptionsFilterOptions } from './allSubscriptions/const';
import type { ModelsState } from './allSubscriptions/ExpandedModelsPanel';
import { SubscriptionsTable } from './allSubscriptions/SubscriptionsTable';
import { SubscriptionsToolbar } from './allSubscriptions/SubscriptionsToolbar';
import { useDeleteSubscription } from './hooks/useDeleteSubscription';
import {
  descriptionOf,
  displayNameOf,
  groupsOf,
  modelForRef,
  modelRefsOf,
  organizationIdOf,
  tenantNameOf,
} from './subscriptionText';
import { useModelList, useSubscriptionList, useTenantList } from './useSubscriptions';

export const SubscriptionsList: React.FC = () => {
  const { data: subscriptions, loaded, error, refresh: refreshSubscriptions } = useSubscriptionList();
  const { data: models, loaded: modelsLoaded, error: modelsError, refresh: refreshModels } = useModelList();
  const { data: organizations } = useTenantList();
  const { user } = useConsoleSession();
  /** UI hint only; the backend enforces authorization. */
  const canWrite = !!user?.isProviderAdmin;
  const refresh = useCallback(() => {
    void refreshSubscriptions();
    void refreshModels();
  }, [refreshSubscriptions, refreshModels]);
  // The clusters name the models' locations' sites, as on the Models page. Without a site name (or
  // without the clusters) a location shows as itself.
  const { data: clusters } = useClusterList();
  const siteNames = useMemo(() => siteNamesOf(clusters), [clusters]);
  const [filterData, setFilterData] = useState<SubscriptionsFilterDataType>(initialSubscriptionsFilterData);
  const navigate = useNavigate();
  const [confirmDelete, deleteDialog] = useDeleteSubscription({
    // The delete refetches the list. Replace, so the notice doesn't add a second Subscriptions
    // entry to the browser's history.
    onDeleted: () => void navigate('.', { replace: true, state: { notice: 'Subscription deleted' } }),
  });

  const onFilterUpdate = useCallback(
    (key: SubscriptionsFilterOptions, value?: string) => setFilterData((prev) => ({ ...prev, [key]: value })),
    [],
  );
  const onClearFilters = useCallback(() => setFilterData(initialSubscriptionsFilterData), []);

  const organizationName = useCallback(
    (s: Subscription) => {
      const id = organizationIdOf(s);
      const organization = organizations.find((o) => o.id === id);
      return organization ? tenantNameOf(organization) : id;
    },
    [organizations],
  );

  // The models fill in the models' locations and let the model filter match their display name and
  // description. When their last load failed, only what the subscriptions say is known.
  let modelsState: ModelsState = 'loading';
  if (modelsLoaded) {
    modelsState = modelsError ? 'failed' : 'loaded';
  }

  const filteredSubscriptions = useMemo(() => {
    const keyword = filterData[SubscriptionsFilterOptions.keyword]?.trim().toLowerCase();
    const model = filterData[SubscriptionsFilterOptions.model]?.trim().toLowerCase();
    const group = filterData[SubscriptionsFilterOptions.group]?.trim().toLowerCase();
    const matches = (term: string, ...values: (string | undefined)[]) =>
      values.some((value) => value?.toLowerCase().includes(term));
    return subscriptions.filter(
      (sub) =>
        (!keyword || matches(keyword, sub.id, displayNameOf(sub), descriptionOf(sub))) &&
        // A model matches by its name (ID), display name or description, from the reference or the
        // model it names.
        (!model ||
          modelRefsOf(sub).some((ref) => {
            const named = modelForRef(models, ref);
            return matches(
              model,
              ref.name,
              ref.displayName,
              ref.description,
              named && displayNameOf(named),
              named && descriptionOf(named),
            );
          })) &&
        (!group || groupsOf(sub).some((g) => matches(group, g))),
    );
  }, [subscriptions, models, filterData]);

  const body = () => {
    if (subscriptions.length === 0) {
      return (
        <EmptyListState
          title="No subscriptions"
          data-testid="empty-subscriptions-page"
          action={
            canWrite && (
              <Button
                variant="primary"
                component={(props) => <Link {...props} to={getSubscriptionCreateUrl()} />}
                data-testid="create-subscription-button"
              >
                Create subscription
              </Button>
            )
          }
        >
          Subscriptions define token limits for model access. Create a subscription to control usage for each user
          group.
        </EmptyListState>
      );
    }
    return (
      <Stack hasGutter>
        {modelsState === 'failed' && (
          <StackItem>
            <Alert
              isInline
              variant="warning"
              title="Unable to load models"
              actionLinks={<AlertActionLink onClick={refresh}>Retry</AlertActionLink>}
              data-testid="subscriptions-models-unavailable"
            >
              The models' locations aren't shown, and the model filter matches only the names and descriptions the
              subscriptions give their models.
            </Alert>
          </StackItem>
        )}
        <StackItem>
          <SubscriptionsTable
            subscriptions={filteredSubscriptions}
            organizationName={organizationName}
            models={models}
            modelsState={modelsState}
            siteNames={siteNames}
            onClearFilters={onClearFilters}
            toolbarContent={
              <SubscriptionsToolbar
                filterData={filterData}
                onFilterUpdate={onFilterUpdate}
                canWrite={canWrite}
                onRefresh={refresh}
              />
            }
            canWrite={canWrite}
            onDelete={confirmDelete}
          />
        </StackItem>
      </Stack>
    );
  };

  return (
    <>
      <PageStateSection
        title="Subscriptions"
        description="Manage subscriptions to models available through Models as a Service."
        loaded={loaded}
        error={error}
        onRetry={refresh}
        subject="Subscriptions"
        loadingLabel="Loading subscriptions"
      >
        {body()}
      </PageStateSection>
      {deleteDialog}
    </>
  );
};
