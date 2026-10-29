// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/viewSubscription/SubscriptionDetailsSection.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/viewSubscription/SubscriptionDetailsSection.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The console adds the Organization, the priority and the authorization policies, leaves out the
// name the page title already shows and the status beside it, and lays the details out as every
// details page does.
import { Flex, Stack } from '@patternfly/react-core';
import { DetailsList } from '../../../components/DetailsList';
import { DetailsSection } from '../../../components/DetailsSection';
import { RelativeTime } from '../../../components/RelativeTime';
import { StatusLabel } from '../../../components/StatusLabel';
import type { AuthPolicy, Subscription } from '../../../gen/ai_grid/v1/subscription_type_pb';
import { descriptionOf, displayNameOf, isoTime, readyConditionOf } from '../subscriptionText';

type Props = {
  subscription: Subscription;
  /** The authorization policies that cover any of this subscription's models, as Subscriptions/Get lists them. */
  authPolicies: AuthPolicy[];
  /** The organization's name, or its id when the organization is unknown. */
  organization: string;
};

export const SubscriptionDetailsSection: React.FC<Props> = ({ subscription, authPolicies, organization }) => {
  const created = isoTime(subscription.metadata?.creationTimestamp);
  return (
    <div data-testid="subscription-details-section">
      <DetailsSection title="Details">
        <DetailsList
          aria-label="Subscription details"
          items={[
            { term: 'Description', value: descriptionOf(subscription) || undefined },
            { term: 'Resource name', value: subscription.id },
            { term: 'Organization', value: organization, 'data-testid': 'subscription-organization' },
            { term: 'Priority', value: subscription.spec?.priority ?? 0, 'data-testid': 'subscription-priority' },
            {
              // The backend lists every policy covering one of the models, whichever groups it
              // grants, so the term says that rather than implying these policies are this
              // subscription's own.
              term: 'Policies for its models',
              'data-testid': 'subscription-auth-policies',
              value: authPolicies.length ? (
                <Stack>
                  {authPolicies.map((policy) => (
                    <Flex key={policy.id} spaceItems={{ default: 'spaceItemsSm' }}>
                      <span>{displayNameOf(policy)}</span>
                      <StatusLabel
                        isCompact
                        status={policy.phase.trim() || 'Unknown'}
                        reason={readyConditionOf(policy.conditions).statusMessage}
                      />
                    </Flex>
                  ))}
                </Stack>
              ) : undefined,
            },
            {
              // Git mode stamps no creation time yet (a backend gap), so this is often "—".
              term: 'Created',
              value: created && <RelativeTime time={created} />,
            },
          ]}
        />
      </DetailsSection>
    </div>
  );
};
