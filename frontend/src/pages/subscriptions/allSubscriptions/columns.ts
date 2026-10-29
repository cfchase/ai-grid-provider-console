// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/allSubscriptions/columns.ts at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/allSubscriptions/columns.ts
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The console adds the Organization column, sorted by the name it shows. Groups and Models show
// counts that expand the row (SubscriptionTableRow), sorted by count.
import type { ThProps } from '@patternfly/react-table';
import type { Subscription } from '../../../gen/ai_grid/v1/subscription_type_pb';
import { normalizePhase } from '../../../utilities/phaseLabelUtils';
import { displayNameOf, groupsOf, modelRefsOf } from '../subscriptionText';

export type SubscriptionColumn = {
  label: string;
  width?: ThProps['width'];
  /** A number: right-aligned. */
  isNumber?: boolean;
  sortable: (a: Subscription, b: Subscription) => number;
};

/** The list's columns; organizationName shows a subscription's organization. */
export const subscriptionsColumns = (organizationName: (s: Subscription) => string): SubscriptionColumn[] => [
  {
    label: 'Subscription',
    sortable: (a, b) => displayNameOf(a).localeCompare(displayNameOf(b)),
  },
  {
    label: 'Organization',
    width: 15,
    sortable: (a, b) => organizationName(a).localeCompare(organizationName(b)),
  },
  {
    label: 'Status',
    width: 15,
    sortable: (a, b) => normalizePhase(a.status?.phase).localeCompare(normalizePhase(b.status?.phase)),
  },
  {
    label: 'Groups',
    width: 10,
    sortable: (a, b) => groupsOf(a).length - groupsOf(b).length,
  },
  {
    label: 'Models',
    width: 10,
    sortable: (a, b) => modelRefsOf(a).length - modelRefsOf(b).length,
  },
  {
    label: 'Priority',
    width: 10,
    isNumber: true,
    sortable: (a, b) => (a.spec?.priority ?? 0) - (b.spec?.priority ?? 0),
  },
];
