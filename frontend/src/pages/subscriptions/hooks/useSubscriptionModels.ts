// Ported from krisv/ai-grid-cloud-provider-poc src/app/hooks/useSubscriptionModels.ts at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/hooks/useSubscriptionModels.ts
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { useCallback, useState } from 'react';
import { create } from '@bufbuild/protobuf';
import type { Model } from '../../../gen/ai_grid/v1/model_type_pb';
import { SubscriptionModelRefSchema, type SubscriptionModelRef } from '../../../gen/ai_grid/v1/subscription_type_pb';
import type { TokenLimit } from '../../../utilities/rateLimits';

/**
 * A model in the subscription form: the ref as the subscription has it (or a new one for a model
 * added here), with its token limits.
 */
export type SubscriptionModelEntry = {
  ref: SubscriptionModelRef;
  /** The model the ref names, when the backend joined it or it was added here. */
  model?: Model;
  /** Whether the subscription had the ref when the form opened. */
  saved: boolean;
  unlimited: boolean;
  tokenRateLimits: TokenLimit[];
};

/**
 * The model an entry names: the backend's join (model_id) for a saved ref, the name for a new one,
 * which names the model by its id with no namespace (SubscriptionModelRef.model_id).
 */
export const entryModelId = (entry: SubscriptionModelEntry): string | undefined =>
  entry.ref.modelId || (entry.ref.namespace ? undefined : entry.ref.name);

/** A key for an entry: its model, or the ref's namespace and name when the backend couldn't join it. */
export const entryKey = (entry: SubscriptionModelEntry): string =>
  entryModelId(entry) ?? `${entry.ref.namespace}/${entry.ref.name}`;

/** A new entry for a model added in the form: the model's id as name, no namespace. */
const newEntry = (model: Model): SubscriptionModelEntry => ({
  ref: create(SubscriptionModelRefSchema, { name: model.id }),
  model,
  saved: false,
  unlimited: false,
  tokenRateLimits: [],
});

/** Returns the corrected edit-modal row index after deletions, or null if that row was removed. */
export const reindexAfterRemove = (targetIndex: number | null, removedIndices: number[]): number | null => {
  if (targetIndex === null || removedIndices.length === 0) {
    return targetIndex;
  }
  if (removedIndices.includes(targetIndex)) {
    return null;
  }
  return targetIndex - removedIndices.filter((i) => i < targetIndex).length;
};

/** The form's model list, the add-models modal and the token-limit modal. */
export const useSubscriptionModels = (initialModels: SubscriptionModelEntry[] = []) => {
  const [models, setModels] = useState<SubscriptionModelEntry[]>(initialModels);
  const [isAddModelsModalOpen, setIsAddModelsModalOpen] = useState(false);
  const [editLimitsTarget, setEditLimitsTarget] = useState<number | null>(null);

  const allModelsHaveRateLimits = models.every((m) => m.unlimited || m.tokenRateLimits.length > 0);
  const editingModel = editLimitsTarget != null ? models[editLimitsTarget] : null;

  const handleAddModels = useCallback((selected: Model[]) => {
    setModels((prev) => [
      ...prev,
      ...selected.filter((model) => !prev.some((m) => entryModelId(m) === model.id)).map(newEntry),
    ]);
  }, []);

  const handleRemoveModel = useCallback((index: number) => {
    setModels((prev) => prev.filter((_, i) => i !== index));
    setEditLimitsTarget((current) => reindexAfterRemove(current, [index]));
  }, []);

  const handleRemoveModels = useCallback(
    (removed: Model[]) => {
      const isRemoved = (m: SubscriptionModelEntry) => removed.some((model) => entryModelId(m) === model.id);
      const removedIndices = models.flatMap((m, i) => (isRemoved(m) ? [i] : []));
      setModels((prev) => prev.filter((m) => !isRemoved(m)));
      setEditLimitsTarget((current) => reindexAfterRemove(current, removedIndices));
    },
    [models],
  );

  const handleSaveRateLimits = useCallback(
    (rateLimits: TokenLimit[]) => {
      if (editLimitsTarget == null) {
        return;
      }
      setModels((prev) =>
        prev.map((entry, i) => (i === editLimitsTarget ? { ...entry, tokenRateLimits: rateLimits } : entry)),
      );
      setEditLimitsTarget(null);
    },
    [editLimitsTarget],
  );

  const handleCloseRateLimitsModal = useCallback(() => setEditLimitsTarget(null), []);

  return {
    models,
    isAddModelsModalOpen,
    setIsAddModelsModalOpen,
    editLimitsTarget,
    setEditLimitsTarget,
    editingModel,
    allModelsHaveRateLimits,
    handleAddModels,
    handleRemoveModel,
    handleRemoveModels,
    handleSaveRateLimits,
    handleCloseRateLimitsModal,
  };
};
