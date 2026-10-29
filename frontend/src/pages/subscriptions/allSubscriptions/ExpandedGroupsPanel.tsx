// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/ExpandedGroupsPanel.tsx
// upstream commit: 6f47c0f775d19c89ef02f74d192b32dc7d3c669d
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';

/** A subscription's groups in its row's expansion. */
export const ExpandedGroupsPanel: React.FC<{ groups: string[] }> = ({ groups }) => (
  <Table aria-label="Subscription groups" variant="compact" data-testid="subscription-groups-expanded-panel">
    <Thead>
      <Tr>
        <Th>Group name</Th>
      </Tr>
    </Thead>
    <Tbody>
      {groups.length === 0 ? (
        <Tr>
          <Td>No groups</Td>
        </Tr>
      ) : (
        groups.map((group) => (
          <Tr key={group} data-testid="expanded-subscription-group-row">
            <Td dataLabel="Group name">{group}</Td>
          </Tr>
        ))
      )}
    </Tbody>
  </Table>
);
