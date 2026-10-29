// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/viewSubscription/SubscriptionGroupsSection.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/viewSubscription/SubscriptionGroupsSection.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { Bullseye, Content } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { DetailsSection } from '../../../components/DetailsSection';

type Props = { groups: string[] };

export const SubscriptionGroupsSection: React.FC<Props> = ({ groups }) => (
  <div data-testid="subscription-groups-section">
    <DetailsSection
      title="Groups"
      count={groups.length}
      help="Members of these groups can use the subscription's models."
    >
      {groups.length === 0 ? (
        <Bullseye>
          <Content component="p">No groups assigned to this subscription.</Content>
        </Bullseye>
      ) : (
        <Table aria-label="Subscription groups" variant="compact" data-testid="subscription-groups-table">
          <Thead>
            <Tr>
              <Th>Name</Th>
            </Tr>
          </Thead>
          <Tbody>
            {groups.map((group) => (
              <Tr key={group}>
                <Td dataLabel="Name">{group}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </DetailsSection>
  </div>
);
