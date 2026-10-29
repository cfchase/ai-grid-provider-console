// Ported from krisv/ai-grid-cloud-provider-poc src/app/utilities/authpolicies.ts at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/utilities/authpolicies.ts
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4

type ModelName = { name: string; namespace?: string };

/** A key for a model reference in sets and React lists. */
export const modelKey = (ref: ModelName): string => `${ref.namespace ?? ''}/${ref.name}`;
