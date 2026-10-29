import { Fragment, lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import type { ConsoleService } from './api/ConsoleService';
import { NotFoundPage } from './components/NotFoundPage';
import { PageErrorBoundary } from './components/PageErrorBoundary';
import { PageLoading } from './components/PageLoading';
// Every page loads when it is first opened, so the first download is the shell alone: the landing
// page (/ goes to /ai-grid, the map) brings Leaflet, which no other page needs.
const ClustersPage = lazy(() => import('./pages/clusters/ClustersPage').then((m) => ({ default: m.ClustersPage })));

const ClusterDetailsPage = lazy(() =>
  import('./pages/clusters/ClusterDetailsPage').then((m) => ({ default: m.ClusterDetailsPage })),
);
const AiGridPage = lazy(() => import('./pages/grid/AiGridPage').then((m) => ({ default: m.AiGridPage })));
const MonitoringPage = lazy(() =>
  import('./pages/monitoring/MonitoringPage').then((m) => ({ default: m.MonitoringPage })),
);
const ModelDetailsPage = lazy(() =>
  import('./pages/models/ModelDetailsPage').then((m) => ({ default: m.ModelDetailsPage })),
);
const ModelEditPage = lazy(() => import('./pages/models/ModelEditPage').then((m) => ({ default: m.ModelEditPage })));
const ModelWizard = lazy(() => import('./pages/models/ModelWizard').then((m) => ({ default: m.ModelWizard })));
const ModelsPage = lazy(() => import('./pages/models/ModelsPage').then((m) => ({ default: m.ModelsPage })));
const OrganizationDetailsPage = lazy(() =>
  import('./pages/organizations/OrganizationDetailsPage').then((m) => ({ default: m.OrganizationDetailsPage })),
);
const OrganizationListPage = lazy(() =>
  import('./pages/organizations/OrganizationListPage').then((m) => ({ default: m.OrganizationListPage })),
);
const OrganizationWizardPage = lazy(() =>
  import('./pages/organizations/OrganizationWizardPage').then((m) => ({ default: m.OrganizationWizardPage })),
);
const CreateSubscriptionPage = lazy(() =>
  import('./pages/subscriptions/CreateSubscriptionPage').then((m) => ({ default: m.CreateSubscriptionPage })),
);
const EditSubscriptionPage = lazy(() =>
  import('./pages/subscriptions/EditSubscriptionPage').then((m) => ({ default: m.EditSubscriptionPage })),
);
const SubscriptionsPage = lazy(() =>
  import('./pages/subscriptions/SubscriptionsPage').then((m) => ({ default: m.SubscriptionsPage })),
);
const ViewSubscriptionPage = lazy(() =>
  import('./pages/subscriptions/ViewSubscriptionPage').then((m) => ({ default: m.ViewSubscriptionPage })),
);

type Props = { service: ConsoleService };

/** Mounts its page afresh for each record, so another :id loads that record and resets its form. */
const ByParams: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Fragment key={Object.values(useParams()).join('/')}>{children}</Fragment>
);

// Ported from krisv/ai-grid-cloud-provider-poc src/app/App.tsx at 62319b8.
export const AppRoutes: React.FC<Props> = ({ service }) => (
  <PageErrorBoundary resetKey={useLocation().pathname}>
    <Suspense fallback={<PageLoading label="Loading page" />}>
      <Pages service={service} />
    </Suspense>
  </PageErrorBoundary>
);

const Pages: React.FC<Props> = ({ service }) => (
  <Routes>
    <Route path="/" element={<Navigate to="/ai-grid" replace />} />
    {/* Keyed, so moving between the map and monitoring mounts a fresh page with its own loads. */}
    <Route path="/ai-grid" element={<AiGridPage key="ai-grid" service={service} />} />
    <Route path="/monitoring" element={<MonitoringPage service={service} />} />
    <Route path="/clusters" element={<ClustersPage />} />
    <Route
      path="/clusters/:name"
      element={
        <ByParams>
          <ClusterDetailsPage />
        </ByParams>
      }
    />
    <Route path="/organizations" element={<OrganizationListPage service={service} />} />
    <Route path="/organizations/create" element={<OrganizationWizardPage service={service} />} />
    <Route
      path="/organizations/:id"
      element={
        <ByParams>
          <OrganizationDetailsPage service={service} />
        </ByParams>
      }
    />
    <Route
      path="/organizations/:id/edit"
      element={
        <ByParams>
          <OrganizationWizardPage service={service} />
        </ByParams>
      }
    />
    <Route path="/models" element={<ModelsPage service={service} />} />
    <Route path="/models/deploy" element={<ModelWizard service={service} />} />
    <Route
      path="/models/:namespace/:name"
      element={
        <ByParams>
          <ModelDetailsPage service={service} />
        </ByParams>
      }
    />
    <Route
      path="/models/:namespace/:name/edit"
      element={
        <ByParams>
          <ModelEditPage service={service} />
        </ByParams>
      }
    />
    {/* The subscription pages read the backend over Connect (useSubscriptions), not the service. */}
    <Route path="/subscriptions" element={<SubscriptionsPage />} />
    <Route path="/subscriptions/create" element={<CreateSubscriptionPage />} />
    <Route
      path="/subscriptions/view/:subscriptionName"
      element={
        <ByParams>
          <ViewSubscriptionPage />
        </ByParams>
      }
    />
    <Route
      path="/subscriptions/edit/:subscriptionName"
      element={
        <ByParams>
          <EditSubscriptionPage />
        </ByParams>
      }
    />
    <Route path="*" element={<NotFoundPage />} />
  </Routes>
);
