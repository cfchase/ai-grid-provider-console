import { Alert, Breadcrumb, BreadcrumbItem, Flex, List, ListItem, Stack } from '@patternfly/react-core';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ServiceError } from '../../api/ConsoleService';
import { DetailsList } from '../../components/DetailsList';
import { DetailsSection } from '../../components/DetailsSection';
import { RelativeTime } from '../../components/RelativeTime';
import { PageStateSection } from '../../components/states/PageStateSection';
import { SectionEmptyState } from '../../components/states/SectionEmptyState';
import { SimpleMenuActions } from '../../components/SimpleMenuActions';
import { useConsoleSession } from '../../context/useConsoleSession';
import { locationLabel, modelNotFound, modelPath, siteNamesOf } from './modelUtils';
import { ModelLocationsTable } from './ModelLocationsTable';
import { ModelStatusDetails, ModelStatusLabel } from './ModelStatus';
import { PARTIALLY_AVAILABLE, hasModelStatusDetails, modelPhase, modelStatusTitle } from './modelStatusInfo';
import { titleOf } from './modelView';
import { useDeleteModel } from './useDeleteModel';
import { useModel } from './useModels';
import { hardwareProfileLabel, modelServerLabel, modelServerOf, PRESET_IMAGE, useServingOptions } from './modelServers';
import { useClusterList } from '../clusters/useClusters';

/** A model deployment at /models/:id: its status explained, its configuration and its locations. */
export const ModelDetailsPage: React.FC = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: loadedModel, loaded, error, refresh } = useModel(id);
  // The model server's display name, when the backend's list has its preset.
  const { data: servingOptions } = useServingOptions();
  const { data: clusters } = useClusterList();
  const { user } = useConsoleSession();
  // A 404 means the deployment is gone, even when an earlier answer is still held (PageStateSection
  // shows the not-found state then).
  const model = error instanceof ServiceError && error.status === 404 ? undefined : loadedModel;
  const [confirmDelete, deleteModal] = useDeleteModel({
    refresh: () => void refresh(),
    onDeleted: () => navigate('/models', { state: { notice: 'Model deleted' } }),
  });
  const title = model ? titleOf(model) : id;
  const siteNames = siteNamesOf(clusters);

  const body = () => {
    if (!model) {
      return null;
    }
    const phase = modelPhase(model);
    const edit = user?.isProviderAdmin ? () => navigate(`${modelPath(model)}/edit`) : undefined;
    return (
      <Flex direction={{ default: 'column' }} flexWrap={{ default: 'nowrap' }} spaceItems={{ default: 'spaceItemsXl' }}>
        {/* Saved to Git says all the backend knows yet; the status label shows it, so no alert repeats it. */}
        {phase !== 'Ready' && phase !== 'Saved to Git' && hasModelStatusDetails(model) && (
          <Alert
            isInline
            variant={phase === 'Failed' ? 'danger' : phase === PARTIALLY_AVAILABLE ? 'warning' : 'info'}
            title={modelStatusTitle(model)}
            data-testid="model-status-alert"
          >
            <ModelStatusDetails model={model} />
          </Alert>
        )}
        <DetailsSection title="Deployment">
          <DetailsList
            aria-label="Deployment"
            items={[
              { term: 'Resource name', value: model.id },
              { term: 'Description', value: model.description },
              { term: 'Model', value: model.modelName },
              { term: 'Model URI', value: model.modelUri },
              { term: 'Model server', value: modelServerLabel(model.baseRefs, servingOptions.servers) || undefined },
              { term: 'Hardware profile', value: hardwareProfileLabel(model.hardwareProfile, servingOptions.profiles) },
              {
                term: 'Runtime image',
                // As the wizard reads it: a model on a preset may leave the image to it.
                value: model.runtimeImage || (modelServerOf(model.baseRefs)?.setsImage ? PRESET_IMAGE : undefined),
              },
              { term: 'Replicas', value: model.autoscaled ? 'Autoscaled' : model.replicas },
              { term: 'Endpoint', value: model.url },
              { term: 'Created', value: model.creationTimestamp && <RelativeTime time={model.creationTimestamp} /> },
            ]}
          />
        </DetailsSection>
        <DetailsSection title="Locations">
          {model.clusters.length || model.selectedClusters.length || model.locations.length ? (
            // model-locations names the section either way: each cluster's status once one reports,
            // the clusters the placement chose until then.
            <Stack hasGutter data-testid="model-locations">
              {model.clusters.length || model.selectedClusters.length ? (
                <ModelLocationsTable model={model} clusters={clusters} siteNames={siteNames} onEdit={edit} />
              ) : (
                <List>
                  {model.locations.map((location) => (
                    <ListItem key={location}>{locationLabel(location, siteNames)}</ListItem>
                  ))}
                </List>
              )}
              <Link to={`/ai-grid?model=${encodeURIComponent(model.id)}`}>View on the AI Grid map</Link>
            </Stack>
          ) : (
            <SectionEmptyState title="No locations selected">
              No AI Grid cluster matches this model&apos;s placement.
            </SectionEmptyState>
          )}
        </DetailsSection>
      </Flex>
    );
  };

  return (
    <>
      <PageStateSection
        title={title}
        status={model && <ModelStatusLabel model={model} />}
        headerAction={
          model &&
          user?.isProviderAdmin && (
            <SimpleMenuActions
              toggleLabel="Actions"
              ariaLabel={`Actions for ${title}`}
              testId="model-actions"
              dropdownItems={[
                { key: 'edit', label: 'Edit', onClick: () => navigate(`${modelPath(model)}/edit`) },
                { isSpacer: true },
                { key: 'delete', label: 'Delete', isDanger: true, onClick: () => confirmDelete(model) },
              ]}
            />
          )
        }
        breadcrumb={
          <Breadcrumb>
            <BreadcrumbItem>
              <Link to="/models">Models</Link>
            </BreadcrumbItem>
            <BreadcrumbItem isActive>{title}</BreadcrumbItem>
          </Breadcrumb>
        }
        loaded={loaded}
        error={error}
        onRetry={() => void refresh()}
        subject="Models"
        object="model"
        loadingLabel="Loading model"
        notFound={modelNotFound(id)}
      >
        {body()}
      </PageStateSection>
      {deleteModal}
    </>
  );
};
