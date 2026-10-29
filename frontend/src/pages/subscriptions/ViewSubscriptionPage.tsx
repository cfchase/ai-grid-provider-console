// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/ViewSubscriptionPage.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/ViewSubscriptionPage.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Telemetry is dropped; a viewer gets no actions; the console adds the Organization. The page
// has one view, so it shows its sections without odh-dashboard's single "Details" tab, and its status
// beside its title, as every details page does. It reads Subscriptions/Get over Connect.
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Breadcrumb, BreadcrumbItem, Flex } from '@patternfly/react-core';
import { MaasModelsSection } from '../../components/MaasModelsSection';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import { PageStateSection } from '../../components/states/PageStateSection';
import { useConsoleSession } from '../../context/useConsoleSession';
import type { Subscription } from '../../gen/ai_grid/v1/subscription_type_pb';
import { getBackUrl, getSubscriptionEditUrl, subscriptionNotFound } from '../../utilities/maasGovernanceNavigation';
import { useDeleteSubscription } from './hooks/useDeleteSubscription';
import { PhaseLabel } from './Phase/PhaseLabel';
import {
  displayNameOf,
  groupsOf,
  isDeleting,
  modelRefsOf,
  organizationIdOf,
  readyConditionOf,
  refKey,
  refTitleOf,
  registrationStatusOf,
  tenantNameOf,
  toTokenLimits,
} from './subscriptionText';
import { useSubscription, useTenantList } from './useSubscriptions';
import { SubscriptionDetailsSection } from './viewSubscription/SubscriptionDetailsSection';
import { SubscriptionGroupsSection } from './viewSubscription/SubscriptionGroupsSection';

type ActionsProps = { subscription: Subscription; returnTo: string };

const SubscriptionActions: React.FC<ActionsProps> = ({ subscription, returnTo }) => {
  const navigate = useNavigate();
  const [confirmDelete, deleteDialog] = useDeleteSubscription({
    onDeleted: () => void navigate(returnTo, { state: { notice: 'Subscription deleted' } }),
  });
  const deleting = isDeleting(subscription);
  return (
    <>
      <SimpleMenuActions
        toggleLabel="Actions"
        testId="subscription-actions-toggle"
        ariaLabel={`Actions for ${displayNameOf(subscription)}`}
        dropdownItems={[
          {
            key: 'edit',
            label: 'Edit',
            onClick: () => navigate(getSubscriptionEditUrl(subscription.id), { state: { returnTo } }),
            isDisabled: deleting,
          },
          { isSpacer: true },
          {
            key: 'delete',
            label: 'Delete',
            isDanger: true,
            onClick: () => confirmDelete(subscription),
            isDisabled: deleting,
          },
        ]}
      />
      {deleteDialog}
    </>
  );
};

export const ViewSubscriptionPage: React.FC = () => {
  const { subscriptionName = '' } = useParams<{ subscriptionName: string }>();
  const location = useLocation();
  const { data: info, loaded, error, refresh } = useSubscription(subscriptionName);
  const { data: organizations } = useTenantList();
  const { user } = useConsoleSession();
  const canWrite = !!user?.isProviderAdmin;
  const subscription = info?.object;
  const title = subscription ? displayNameOf(subscription) : subscriptionName;
  const backUrl = getBackUrl(location.state, 'subscriptions');
  const organizationId = subscription ? organizationIdOf(subscription) : '';
  const ready = readyConditionOf(subscription?.status?.conditions);
  const tenant = organizations.find((o) => o.id === organizationId);
  const organization = tenant ? tenantNameOf(tenant) : organizationId;

  return (
    <PageStateSection
      title={title}
      status={
        subscription && (
          <span data-testid="subscription-phase">
            <PhaseLabel phase={subscription.status?.phase} statusMessage={ready.statusMessage} reason={ready.reason} />
          </span>
        )
      }
      breadcrumb={
        <Breadcrumb>
          <BreadcrumbItem>
            <Link to={backUrl} data-testid="breadcrumb-subscriptions-link">
              Subscriptions
            </Link>
          </BreadcrumbItem>
          <BreadcrumbItem isActive>{title}</BreadcrumbItem>
        </Breadcrumb>
      }
      headerAction={subscription && canWrite && <SubscriptionActions subscription={subscription} returnTo={backUrl} />}
      loaded={loaded}
      error={error}
      onRetry={() => void refresh()}
      subject="Subscriptions"
      object="subscription"
      loadingLabel="Loading subscription"
      notFound={subscriptionNotFound(subscriptionName, backUrl)}
    >
      {info && subscription && (
        <Flex
          direction={{ default: 'column' }}
          flexWrap={{ default: 'nowrap' }}
          spaceItems={{ default: 'spaceItemsXl' }}
        >
          <SubscriptionDetailsSection
            subscription={subscription}
            authPolicies={info.authPolicies}
            organization={organization}
          />
          <SubscriptionGroupsSection groups={groupsOf(subscription)} />
          <MaasModelsSection
            rows={modelRefsOf(subscription).map((ref) => ({
              key: refKey(ref),
              title: refTitleOf(ref),
              name: ref.name,
              ...registrationStatusOf(info.modelRegistrations, ref),
              tokenRateLimits: toTokenLimits(ref.tokenRateLimits),
              unlimited: ref.unlimited,
            }))}
          />
        </Flex>
      )}
    </PageStateSection>
  );
};
