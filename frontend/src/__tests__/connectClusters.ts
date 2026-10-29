// The backend's Clusters API for page tests, over the clusters of a MockConsoleService: they answer
// Clusters/List, Get and Update over Connect (fakeClients: the generated messages, serialized as
// JSON), so a test that changes `service.clusters`, or replaces `listClusters`, `getCluster`,
// `enrollCluster` or `removeClusterFromGrid`, changes what the pages read.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import type { TransportWith } from '../api/connect/BackendProvider';
import { ServiceError } from '../api/ConsoleService';
import type { GridMembership } from '../api/clusters';
import { fakeClients, type FakeBackend } from '../api/connect/testing';
import type { GridCluster } from '../api/types';
import { subscriptionsBackend, type SubscriptionsSource } from './connectSubscriptions';
import {
  ManagedClusterLocationSource,
  ManagedClusterSchema,
  ManagedClusterState,
  type ManagedCluster,
} from '../gen/ai_grid/v1/managed_cluster_type_pb';

/** The mock's clusters, as the tests' Clusters backend reads them. */
export type ClusterSource = {
  listClusters: () => Promise<GridCluster[]>;
  getCluster: (name: string) => Promise<GridCluster>;
};

/** The writes a MockConsoleService makes; a service without them refuses Update. */
type Writes = {
  enrollCluster?: (cluster: GridCluster, membership: GridMembership) => Promise<GridCluster>;
  removeClusterFromGrid?: (cluster: GridCluster) => Promise<GridCluster>;
};

const codes: Record<number, Code> = {
  401: Code.Unauthenticated,
  403: Code.PermissionDenied,
  404: Code.NotFound,
  409: Code.Aborted,
  412: Code.FailedPrecondition,
  422: Code.InvalidArgument,
  500: Code.Internal,
  501: Code.Unimplemented,
  503: Code.Unavailable,
};

/** A ServiceError as the backend's Connect error with the same meaning. */
const asConnectError = (err: unknown) =>
  err instanceof ServiceError
    ? new ConnectError(err.message, codes[err.status] ?? Code.Unknown)
    : ConnectError.from(err);

export const call = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (err) {
    throw asConnectError(err);
  }
};

const availableCondition = { Ready: 'True', Offline: 'False', Unknown: '' } as const;

/** The backend's lifecycle state for the mock's status and the ACM state behind its Unknown. */
const stateOf = (c: GridCluster): ManagedClusterState => {
  switch (c.state) {
    case 'Pending import':
      return ManagedClusterState.PENDING_IMPORT;
    case 'Importing':
      return ManagedClusterState.IMPORTING;
    case 'Import failed':
      return ManagedClusterState.IMPORT_FAILED;
    case 'Not accepted':
      return ManagedClusterState.NOT_ACCEPTED;
    case 'Detaching':
      return ManagedClusterState.DETACHING;
  }
  return {
    Ready: ManagedClusterState.READY,
    Offline: ManagedClusterState.OFFLINE,
    Unknown: ManagedClusterState.UNKNOWN,
  }[c.status];
};

/**
 * A GridCluster as the backend's ManagedCluster: the fields clusterView.ts reads back. The mock's
 * coordinates are the hub admin's annotations, and its region the cluster's cloud region.
 */
export const toManagedCluster = (c: GridCluster): ManagedCluster => {
  const labels: Record<string, string> = { ...c.labels };
  if (c.location) labels.location = c.location;
  if (c.site) labels['ai-grid/site'] = c.site;
  if (c.openshiftVersion) labels.openshiftVersion = c.openshiftVersion;
  const mapped = c.latitude !== undefined && c.longitude !== undefined;
  const claims = [
    ['consoleurl.cluster.open-cluster-management.io', c.consoleUrl],
    ['platform.open-cluster-management.io', c.platform],
    ['product.open-cluster-management.io', c.product],
  ].flatMap(([name, value]) => (value ? [{ name, value }] : []));
  // The mock's capacity is undefined without one; its gpuCapacity is the device plugin's count.
  const capacity =
    c.capacity && c.gpuCapacity !== undefined ? { ...c.capacity, 'nvidia.com/gpu': String(c.gpuCapacity) } : c.capacity;
  return create(ManagedClusterSchema, {
    id: c.name,
    metadata: {
      name: c.name,
      labels,
      version: Number(c.resourceVersion ?? 0),
      ...(c.creationTimestamp ? { creationTimestamp: timestampFromDate(new Date(c.creationTimestamp)) } : {}),
    },
    spec: { hubAcceptsClient: c.state !== 'Not accepted' },
    status: {
      availableCondition: availableCondition[c.status],
      provisioning: c.provisioned ? 'Compliant' : '',
      kubernetesVersion: c.kubernetesVersion ?? '',
      capacity: capacity ?? {},
      allocatable: c.allocatable ?? {},
      clusterClaims: claims,
      aiGridMember: c.aiGridEnabled,
      state: stateOf(c),
      stateMessage: c.statusMessage ?? '',
      location: {
        siteName: c.siteName ?? '',
        ...(mapped ? { latitude: c.latitude, longitude: c.longitude } : {}),
        source: mapped ? ManagedClusterLocationSource.ANNOTATIONS : ManagedClusterLocationSource.NONE,
        region: c.region ?? '',
      },
      ...(c.gpus
        ? {
            gpus: {
              ...c.gpus,
              configurations: c.gpus.configurations.map((g) => ({ ...g, memoryMib: BigInt(g.memoryMib) })),
              nodes: c.gpus.nodes.map((n) => ({ ...n, memoryMib: BigInt(n.memoryMib) })),
            },
          }
        : {}),
    },
  });
};

/** Clusters/List, Get and Update over the service's clusters. */
export const clustersBackend = (service: ClusterSource & Writes) =>
  ({
    list: async () => {
      const items = (await call(() => service.listClusters())).map(toManagedCluster);
      return { items, size: items.length, total: items.length };
    },
    get: async ({ id }) => ({ object: toManagedCluster(await call(() => service.getCluster(id))) }),
    update: async ({ object }) => {
      const id = object?.id ?? '';
      const labels = object?.metadata?.labels ?? {};
      const version = object?.metadata?.version ?? 0;
      // What the mock's writes read of the cluster they are given: its name, labels and version.
      const cluster: GridCluster = {
        name: id,
        status: 'Unknown',
        aiGridEnabled: false,
        provisioned: false,
        provisioningStatus: 'Not provisioned',
        addons: {},
        conditions: [],
        labels,
        resourceVersion: version ? String(version) : undefined,
      };
      const updated = await call(async () => {
        if (labels['ai-grid/enabled'] === 'true' && service.enrollCluster) {
          return service.enrollCluster(cluster, {
            location: labels.location ?? '',
            role: labels['ai-grid/role'] as GridMembership['role'],
          });
        }
        if (service.removeClusterFromGrid) return service.removeClusterFromGrid(cluster);
        throw new ServiceError(501, 'the AI Grid backend does not support this operation yet');
      });
      return { object: toManagedCluster(updated) };
    },
  }) satisfies FakeBackend['clusters'];

/**
 * A Connect transport whose Clusters service is the service's clusters, and whose Subscriptions,
 * Models/List and Tenants/List are connectSubscriptions.ts's over the service, built with the console's
 * interceptors, so an Unauthenticated answer checks the session as the browser's transport does.
 */
export const transportFor =
  (service: ClusterSource & Writes & SubscriptionsSource): TransportWith =>
  (interceptors) =>
    fakeClients({ clusters: clustersBackend(service), ...subscriptionsBackend(service, call) }, { interceptors })
      .transport;
