// Ported from krisv/ai-grid-cloud-provider-poc src/app/hooks/useDeleteSubscription.ts and
// src/app/pages/subscriptions/DeleteSubscriptionModal.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/DeleteSubscriptionModal.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// In the shape of the console's other deletes (useDeleteModel, useDeleteOrganization), over
// Subscriptions/Delete.
import { useState } from 'react';
import { Stack, StackItem } from '@patternfly/react-core';
import { toServiceError } from '../../../api/connect/errors';
import { DeleteModal } from '../../../components/DeleteModal';
import type { Subscription } from '../../../gen/ai_grid/v1/subscription_type_pb';
import { displayNameOf } from '../subscriptionText';
import { useSubscriptionWrites } from '../useSubscriptions';

const deleteErrorOf = (err: unknown) => {
  const error = toServiceError(err);
  if (error.isNotImplemented) {
    return new Error('Deleting subscriptions is not available on this backend yet.');
  }
  // Aborted: the version sent is not the stored one (gitDelete, internal/servers/subscriptions_git.go).
  if (error.status === 409) {
    return new Error('This subscription changed since you opened this dialog. Check it and try again.');
  }
  return error;
};

/**
 * Deleting a subscription, the same from its list row and its page: returns `confirmDelete`, which
 * opens the typed-name confirmation, and the dialog to render.
 */
export const useDeleteSubscription = ({
  onDeleted,
}: {
  onDeleted: () => void;
}): [(subscription: Subscription) => void, React.ReactNode] => {
  const { deleteSubscription, reload } = useSubscriptionWrites();
  const [selected, setSelected] = useState<Subscription>();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<Error>();
  const [reloadError, setReloadError] = useState<Error>();

  const confirmDelete = (subscription: Subscription) => {
    setSelected(subscription);
    setError(undefined);
    setReloadError(undefined);
  };

  const remove = async () => {
    if (!selected || deleting) return;
    setDeleting(true);
    setError(undefined);
    setReloadError(undefined);
    // After a failed delete the dialog loads the subscription again, so a retry sends the version
    // the backend has now (as a model's delete does) while the typed name stays. The dialog stays
    // busy until that reload is in, so a retry never sends the old version.
    try {
      // The version read; the backend refuses a stale one (zero would skip the check).
      await deleteSubscription.mutateAsync({ id: selected.id, resourceVersion: selected.metadata?.version ?? 0 });
      setSelected(undefined);
      onDeleted();
    } catch (err) {
      setError(deleteErrorOf(err));
      try {
        const current = await reload(selected.id);
        if (current) setSelected(current);
      } catch (reloadErr) {
        setReloadError(toServiceError(reloadErr));
      }
    } finally {
      setDeleting(false);
    }
  };

  const name = selected && displayNameOf(selected);
  const dialog = selected && name && (
    <DeleteModal
      title="Delete subscription?"
      onClose={() => {
        if (!deleting) {
          setSelected(undefined);
          setError(undefined);
        }
      }}
      deleting={deleting}
      onDelete={() => void remove()}
      deleteName={name}
      error={error}
      reloadError={reloadError}
      testId="delete-subscription-modal"
    >
      <Stack hasGutter>
        <StackItem data-testid="delete-modal-confirmation-message">
          Are you sure you want to delete the subscription <strong>{name}</strong>?
        </StackItem>
        <StackItem>The automatically created authorization policy will also be deleted.</StackItem>
      </Stack>
    </DeleteModal>
  );

  return [confirmDelete, dialog];
};
