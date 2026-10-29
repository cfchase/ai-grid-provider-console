import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Alert, List, ListItem } from '@patternfly/react-core';
import type { ManagedModel } from '../../api/types';
import { displayNameOf } from '../subscriptions/subscriptionText';
import { useSubscriptionsUsingModel } from '../subscriptions/useSubscriptions';

/**
 * The subscriptions that still give access to the model, which the user should change first:
 * Subscriptions/List filtered by the backend's join of a ref to its model (model_id), the model's
 * name being its id. `onInUse` hears whether any were found; while they load, or if they fail to,
 * none are.
 */
export const ReferencingSubscriptions: React.FC<{
  model: ManagedModel;
  onInUse?: (inUse: boolean) => void;
}> = ({ model, onInUse }) => {
  const { data: using, loaded, error } = useSubscriptionsUsingModel(model.name);
  const inUse = loaded && !error && using.length > 0;
  useEffect(() => onInUse?.(inUse), [onInUse, inUse]);
  if (!inUse) {
    return null;
  }
  return (
    <Alert isInline isPlain variant="warning" title="Subscriptions still use this model" data-testid="model-references">
      <p>Remove the model from these subscriptions first, or their members lose access to it:</p>
      <List>
        {using.map((subscription) => (
          <ListItem key={subscription.id}>
            <Link to={`/subscriptions/view/${encodeURIComponent(subscription.id)}`}>{displayNameOf(subscription)}</Link>
          </ListItem>
        ))}
      </List>
    </Alert>
  );
};
