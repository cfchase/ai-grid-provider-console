// Ported from krisv/ai-grid-cloud-provider-poc src/app/shared/AddModelsModal.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/AddModelsModal.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import { useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  SearchInput,
  Stack,
  StackItem,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { Model } from '../gen/ai_grid/v1/model_type_pb';
import { entryModelId, type SubscriptionModelEntry } from '../pages/subscriptions/hooks/useSubscriptionModels';
import { displayNameOf, modelPhaseOf } from '../pages/subscriptions/subscriptionText';
import { StatusLabel } from './StatusLabel';

type Props = {
  /** The models from Models/List. */
  availableModels: Model[];
  currentModels: SubscriptionModelEntry[];
  onAdd: (models: Model[]) => void;
  onRemove: (models: Model[]) => void;
  onClose: () => void;
};

const toggled = (set: Set<string>, key: string) => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

/**
 * Picks the models of a subscription: a checkbox per model (checked for the ones it has), with
 * each model's status, so a failed or pending model isn't added unnoticed.
 */
export const AddModelsModal: React.FC<Props> = ({ availableModels, currentModels, onAdd, onRemove, onClose }) => {
  const [filter, setFilter] = useState('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [pendingAdds, setPendingAdds] = useState<Set<string>>(new Set());
  const [pendingRemoves, setPendingRemoves] = useState<Set<string>>(new Set());

  // Pending changes are keyed by the models' ids; a subscription's ref names its model by the
  // backend's join (SubscriptionModelRef.model_id).
  const isCurrent = (model: Model) => currentModels.some((m) => entryModelId(m) === model.id);

  const isInCurrentSelection = (model: Model) =>
    (isCurrent(model) && !pendingRemoves.has(model.id)) || pendingAdds.has(model.id);

  const filteredModels = useMemo(() => {
    const lowerFilter = filter.toLowerCase();
    return availableModels
      .filter((model) => !lowerFilter || displayNameOf(model).toLowerCase().includes(lowerFilter))
      .sort((a, b) => {
        const cmp = displayNameOf(a).localeCompare(displayNameOf(b));
        return sortDirection === 'asc' ? cmp : -cmp;
      });
  }, [availableModels, filter, sortDirection]);

  const handleToggleModel = (model: Model) => {
    if (isCurrent(model)) {
      setPendingRemoves((prev) => toggled(prev, model.id));
    } else {
      setPendingAdds((prev) => toggled(prev, model.id));
    }
  };

  const handleConfirm = () => {
    const refsToAdd = availableModels.filter((model) => pendingAdds.has(model.id));
    const refsToRemove = availableModels.filter((model) => pendingRemoves.has(model.id));
    if (refsToRemove.length > 0) {
      onRemove(refsToRemove);
    }
    if (refsToAdd.length > 0) {
      onAdd(refsToAdd);
    }
    onClose();
  };

  return (
    <Modal isOpen onClose={onClose} variant="large" aria-label="Add models" data-testid="add-models-modal">
      <ModalHeader title="Add models" />
      <ModalBody>
        <Stack hasGutter>
          <StackItem>
            Select the models members of this subscription can use. You set their token limits next.
          </StackItem>
          <StackItem>
            <SearchInput
              placeholder="Filter by model name"
              value={filter}
              onChange={(_e, val) => setFilter(val)}
              onClear={() => setFilter('')}
              data-testid="add-models-filter"
            />
          </StackItem>
          <StackItem>
            <Table aria-label="Available models" data-testid="add-models-table">
              <Thead>
                <Tr>
                  <Th screenReaderText="Selected" />
                  <Th
                    sort={{
                      sortBy: { index: 0, direction: sortDirection },
                      onSort: () => setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc')),
                      columnIndex: 0,
                    }}
                  >
                    Model name
                  </Th>
                  <Th>Status</Th>
                </Tr>
              </Thead>
              <Tbody>
                {filteredModels.map((model, rowIndex) => {
                  const name = displayNameOf(model);
                  return (
                    <Tr key={model.id}>
                      {/* PatternFly's select cell names every box "Select row N"; this one names the model. */}
                      <Td className="pf-v6-c-table__check">
                        <Checkbox
                          id={`add-model-${rowIndex}`}
                          aria-label={`Select ${name}`}
                          data-testid={`toggle-model-${model.id}`}
                          isChecked={isInCurrentSelection(model)}
                          onChange={() => handleToggleModel(model)}
                        />
                      </Td>
                      <Td dataLabel="Model name">{name}</Td>
                      <Td dataLabel="Status">
                        <StatusLabel isCompact status={modelPhaseOf(model)} reason={model.status?.message} />
                      </Td>
                    </Tr>
                  );
                })}
                {filteredModels.length === 0 && (
                  <Tr>
                    <Td colSpan={3}>No models match the filter criteria.</Td>
                  </Tr>
                )}
              </Tbody>
            </Table>
          </StackItem>
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={handleConfirm} data-testid="confirm-add-models">
          {currentModels.length ? 'Update models' : 'Add models'}
        </Button>
        <Button variant="link" onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
};
