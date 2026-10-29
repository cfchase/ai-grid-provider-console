// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/CreateSubscriptionPage.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/CreateSubscriptionPage.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The PoC's preSelectedModel and breadcrumbLabel router state are dropped: nothing sets them.
import { Link, useLocation } from 'react-router-dom';
import { Breadcrumb, BreadcrumbItem } from '@patternfly/react-core';
import { PageStateSection } from '../../components/states/PageStateSection';
import { getBackUrl } from '../../utilities/maasGovernanceNavigation';
import { CreateSubscriptionForm } from './createSubscription/CreateSubscriptionForm';
import { useModelList } from './useSubscriptions';

export const CreateSubscriptionPage: React.FC = () => {
  const { data: models, loaded, error, refresh } = useModelList();
  const { state } = useLocation();
  const backUrl = getBackUrl(state, 'subscriptions');

  return (
    <PageStateSection
      title="Create subscription"
      description="Give groups of an organization's users access to models, with token limits for each model."
      breadcrumb={
        <Breadcrumb>
          <BreadcrumbItem
            render={() => (
              <Link to={backUrl} data-testid="breadcrumb-subscriptions-link">
                Subscriptions
              </Link>
            )}
          />
          <BreadcrumbItem isActive>Create subscription</BreadcrumbItem>
        </Breadcrumb>
      }
      loaded={loaded}
      error={error}
      onRetry={() => void refresh()}
      subject="Subscriptions"
      loadingLabel="Loading subscription form"
      hasBodyWrapper={false}
    >
      <CreateSubscriptionForm models={models} returnTo={backUrl} />
    </PageStateSection>
  );
};
