import { useState } from 'react';
import { Stack } from '@patternfly/react-core';
import { ServiceError } from '../../api/ConsoleService';
import type { ModelsService } from '../../api/models';
import type { ManagedModel } from '../../api/types';
import { DeleteModal } from '../../components/DeleteModal';
import { ReferencingSubscriptions } from './ModelReferences';

export type ModelDeleteService = ModelsService;

const deleteErrorOf = (err: unknown) =>
  err instanceof ServiceError && err.isNotImplemented
    ? new Error('Deleting models is not available on this backend yet.')
    : err instanceof Error
      ? err
      : new Error('The deployment could not be deleted.');

/**
 * Deleting a model deployment, the same from its list row and its page: returns `confirmDelete`
 * and the modal to render. `refresh` reloads the page after a failed delete.
 */
export const useDeleteModel = (
  service: ModelDeleteService,
  { refresh, onDeleted }: { refresh: () => void; onDeleted: () => void },
): [(model: ManagedModel) => void, React.ReactNode] => {
  const [selected, setSelected] = useState<ManagedModel>();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<Error>();
  const [reloadError, setReloadError] = useState<Error>();
  const [inUse, setInUse] = useState(false);

  const confirmDelete = (model: ManagedModel) => {
    setSelected(model);
    setError(undefined);
    setReloadError(undefined);
    setInUse(false);
  };

  const remove = async () => {
    if (!selected || deleting) return;
    setDeleting(true);
    setError(undefined);
    setReloadError(undefined);
    // The first attempt sends the version the user confirmed. After a failed delete the dialog
    // loads the model again and stays busy until it has, so a retry sends the version the backend
    // has now.
    try {
      await service.deleteModel(selected.namespace, selected.name, selected.resourceVersion);
      setSelected(undefined);
      onDeleted();
    } catch (err) {
      setError(deleteErrorOf(err));
      refresh();
      try {
        setSelected(await service.getModel(selected.namespace, selected.name));
      } catch (reloadErr) {
        setReloadError(reloadErr instanceof Error ? reloadErr : new Error(String(reloadErr)));
      }
    } finally {
      setDeleting(false);
    }
  };

  const modal = selected && (
    <DeleteModal
      title="Delete model deployment?"
      deleteName={selected.displayName ?? selected.name}
      onClose={() => {
        if (!deleting) {
          setSelected(undefined);
          setError(undefined);
        }
      }}
      onDelete={() => void remove()}
      deleting={deleting}
      error={error}
      reloadError={reloadError}
      testId="delete-deployment-modal"
      // Only a guide: while the subscriptions load, or if they fail to, Delete stays enabled. The
      // backend refuses to delete a model a subscription uses, and stays the authority.
      disabledReason={inUse ? 'Remove this model from its subscriptions first' : undefined}
    >
      <Stack hasGutter>
        <p>
          Delete this model, its saved deployment, and its location placement resources? Remove references from
          subscriptions and authorization policies first.
        </p>
        <ReferencingSubscriptions model={selected} onInUse={setInUse} />
      </Stack>
    </DeleteModal>
  );

  return [confirmDelete, modal];
};
