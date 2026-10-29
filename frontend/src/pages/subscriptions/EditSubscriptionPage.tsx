// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/EditSubscriptionPage.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/EditSubscriptionPage.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Breadcrumb, BreadcrumbItem } from '@patternfly/react-core';
import { PageStateSection } from '../../components/states/PageStateSection';
import { getBackUrl, getSubscriptionViewUrl, subscriptionNotFound } from '../../utilities/maasGovernanceNavigation';
import { CreateSubscriptionForm } from './createSubscription/CreateSubscriptionForm';
import { displayNameOf } from './subscriptionText';
import { useModelList, useSubscription } from './useSubscriptions';
import type { SubscriptionsGetResponse } from '../../gen/ai_grid/v1/subscriptions_service_pb';

export const EditSubscriptionPage: React.FC = () => {
  const { subscriptionName = '' } = useParams<{ subscriptionName: string }>();
  const { state } = useLocation();
  const returnTo = getBackUrl(state, 'subscriptions');
  const {
    data: loadedInfo,
    loaded: infoLoaded,
    error: infoError,
    refresh: reloadInfo,
  } = useSubscription(subscriptionName);
  // The first subscription that arrives stays the form's: an edit is checked against the version it
  // started from (lock), so a later answer mustn't replace it underneath the user.
  const [info, setInfo] = useState<SubscriptionsGetResponse>();
  if (loadedInfo && !info) setInfo(loadedInfo);
  const { data: models, loaded: modelsLoaded, error: modelsError, refresh: reloadModels } = useModelList();

  const loaded = infoLoaded && modelsLoaded;
  // A later reload's error doesn't replace a form that is already open.
  const error = (info ? undefined : infoError) || modelsError;
  const displayName = info?.object ? displayNameOf(info.object) : subscriptionName;

  return (
    <PageStateSection
      title={`Edit ${displayName}`}
      description={
        displayName ? `Edit the subscription configuration for ${displayName}.` : 'Edit the subscription configuration.'
      }
      breadcrumb={
        <Breadcrumb>
          <BreadcrumbItem render={() => <Link to={returnTo}>Subscriptions</Link>} />
          <BreadcrumbItem render={() => <Link to={getSubscriptionViewUrl(subscriptionName)}>{displayName}</Link>} />
          <BreadcrumbItem isActive>Edit</BreadcrumbItem>
        </Breadcrumb>
      }
      loaded={loaded}
      error={error}
      subject="Subscriptions"
      object="subscription"
      loadingLabel="Loading subscription"
      hasBodyWrapper={false}
      notFound={subscriptionNotFound(subscriptionName, returnTo)}
      onRetry={() => {
        void reloadInfo();
        void reloadModels();
      }}
    >
      {info && <CreateSubscriptionForm models={models} subscriptionInfo={info} returnTo={returnTo} />}
    </PageStateSection>
  );
};
