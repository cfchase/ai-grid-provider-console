// Ported from krisv/ai-grid-cloud-provider-poc src/app/shared/MaasModelsSection.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/shared/MaasModelsSection.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// Only the subscription uses are ported, so the PoC's customization props are dropped. The page
// words each row (its title, status and limits) from the backend's messages.
import { Fragment } from 'react';
import {
  Bullseye,
  Button,
  Content,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Stack,
  StackItem,
} from '@patternfly/react-core';
import { MinusCircleIcon, PlusCircleIcon } from '@patternfly/react-icons';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { formatTokenRateLimitLine, type TokenLimit } from '../utilities/rateLimits';
import { DetailsSection } from './DetailsSection';
import { StatusLabel } from './StatusLabel';
import { TableRowTitleDescription } from './TableRowTitleDescription';

/** One model of a subscription, as the section shows it. */
export type SubscriptionModelRow = {
  key: string;
  /** The model's display name, else its name. */
  title: string;
  /** The ref's name: the model's id. */
  name: string;
  /** The status label's word, and its reason in the tooltip. */
  status: string;
  reason?: string;
  tokenRateLimits: TokenLimit[];
  unlimited: boolean;
};

type Props = {
  rows: SubscriptionModelRow[];
  /** A form field with add, edit-limits and remove actions, instead of a read-only section. */
  editable?: boolean;
  onAddModels?: () => void;
  onEditLimits?: (index: number) => void;
  onRemoveModel?: (index: number) => void;
  validationError?: string;
};

/**
 * A subscription's models, their status and their token limits. In the form, a model's limits
 * open from its Token limits cell (the one way in), and a model without limits gets a hint rather
 * than an error before the user has done anything.
 */
export const MaasModelsSection: React.FC<Props> = ({
  rows,
  editable = false,
  onAddModels,
  onEditLimits,
  onRemoveModel,
  validationError,
}) => {
  const table = rows.length > 0 && (
    <Table aria-label="subscription models" variant="compact" data-testid="subscription-models-table">
      <Thead>
        <Tr>
          <Th width={40}>Name</Th>
          <Th width={20}>Status</Th>
          <Th width={30}>Token limits</Th>
          {editable && <Th screenReaderText="Actions" />}
        </Tr>
      </Thead>
      <Tbody>
        {rows.map((row, index) => {
          const tokenLimitsLines = row.tokenRateLimits.map(({ limit, window }) =>
            formatTokenRateLimitLine(limit, window),
          );
          const tokenLimitsDisplay = tokenLimitsLines.map((line, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              {line}
            </Fragment>
          ));
          let tokenLimits: React.ReactNode = tokenLimitsDisplay;
          if (row.unlimited) {
            tokenLimits = 'Unlimited';
          } else if (editable && onEditLimits) {
            tokenLimits =
              tokenLimitsLines.length > 0 ? (
                <Button variant="link" isInline onClick={() => onEditLimits(index)}>
                  {tokenLimitsDisplay}
                </Button>
              ) : (
                <Stack>
                  <StackItem>
                    <Button
                      variant="link"
                      isInline
                      icon={<PlusCircleIcon />}
                      onClick={() => onEditLimits(index)}
                      data-testid={`add-token-limit-${index}`}
                    >
                      Add token limit
                    </Button>
                  </StackItem>
                  <StackItem>
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem data-testid={`token-limit-required-${index}`}>
                          Required: add at least one.
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </StackItem>
                </Stack>
              );
          }

          return (
            <Tr key={row.key}>
              <Td dataLabel="Name">
                <TableRowTitleDescription title={<strong>{row.title}</strong>} subtitle={<code>{row.name}</code>} />
              </Td>
              <Td dataLabel="Status">
                <StatusLabel isCompact status={row.status} reason={row.reason} />
              </Td>
              <Td dataLabel="Token limits">{tokenLimits}</Td>
              {editable && (
                <Td isActionCell>
                  <Button
                    variant="plain"
                    icon={<MinusCircleIcon />}
                    aria-label={`Remove ${row.title}`}
                    onClick={() => onRemoveModel?.(index)}
                  />
                </Td>
              )}
            </Tr>
          );
        })}
      </Tbody>
    </Table>
  );

  if (editable) {
    return (
      <FormGroup label="Models" fieldId="subscription-models" isRequired data-testid="subscription-models-section">
        <Stack hasGutter>
          {table && <StackItem>{table}</StackItem>}
          <StackItem>
            <Button
              variant="link"
              isInline
              icon={<PlusCircleIcon />}
              onClick={onAddModels}
              data-testid="add-models-button"
            >
              Add models
            </Button>
          </StackItem>
          <StackItem>
            <FormHelperText>
              <HelperText>
                <HelperTextItem variant={validationError ? 'error' : 'default'}>
                  {validationError ??
                    'Add the models members of this subscription can use, then set token limits for each one.'}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </StackItem>
        </Stack>
      </FormGroup>
    );
  }

  return (
    <div data-testid="subscription-models-section">
      <DetailsSection title="Models">
        {rows.length === 0 ? (
          <Bullseye>
            <Content component="p">No models assigned to this subscription.</Content>
          </Bullseye>
        ) : (
          table
        )}
      </DetailsSection>
    </div>
  );
};
