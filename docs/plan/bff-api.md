# BFF plan

> **Most of this page is scheduled for deletion.** It documents a hand-written REST API that
> [ADR-0002](../adr/0002-connect-end-to-end-with-vanguard-for-rest.md) replaces with Connect:
> the `{"data"}`/`{"meta"}` envelope, the `ETag`/`If-Match`/428 protocol, the error-status
> table and the endpoint table all go. What survives is the deployment topology and the
> identity flow. See also [ADR-0001](../adr/0001-the-contract-lives-in-the-backend.md)
> (the contract moves to the backend) and
> [ADR-0004](../adr/0004-the-bff-is-a-thin-relay.md) (what the BFF keeps doing).
>
> Current boundary (verified 2026-10-27):
>
> - The backend is **`ai-grid-cloud/ai-grid-provider-backend`**. The vendored source in
>   `mock/proto/upstream/COMMIT` and the drift guard now track that repository; the old target, an
>   earlier copy in a personal repository, was corrected.
> - The backend now uses `connect.NewServer()` and vanguard for REST. It still has no
>   authentication or authorization interceptor and uses its own Kubernetes ServiceAccount.
>   The BFF's `requireProviderAdmin` hub access review protects the console path today.
>   [ADR-0004](../adr/0004-the-bff-is-a-thin-relay.md) records the target ownership and a
>   proposed impersonation model; the identity mechanism remains to be agreed.

The console is a React and PatternFly frontend served by a thin Go backend-for-frontend
(BFF). The BFF owns login, static assets and the JSON API the browser uses. Everything
else, every call to the ACM hub, to Keycloak and to metrics, is the job of
`ai-grid-backend`, a gRPC service in its own repository.

```
browser --JSON--> kube-auth-proxy + bff --gRPC--> ai-grid-backend --> hub API, Keycloak, Thanos
```

The feature plan that this implements is `ai-grid-provider-portal-ui-plan.md` (Steps 0 to
11), written against Kris Verlaenen's Node POC (`krisv/ai-grid-cloud-provider-poc`). Its
page designs and ACM conventions are kept. Its backend is replaced by two pieces: the
backend service for cluster access and this BFF for the browser.

## The backend

- Repository: https://github.com/ai-grid-cloud/ai-grid-provider-backend. The Go module path is
  `github.com/osac-project/ai-grid-provider-backend`; the console does not import the module.
- Contract: `proto/ai_grid/v1` in the backend repository. The console pins it by a vendored
  copy in `mock/proto/upstream` with its commit in `mock/proto/upstream/COMMIT`
  (`hack/sync-upstream-proto.sh <ref>` refreshes both).
- What the BFF compiles against: the console's draft proto in `mock/proto/ai_grid/v1`,
  generated into `bff/gen/ai_grid/v1` (`make -C bff generate`), which the fake backend serves;
  and, for the real backend's Clusters, Tenants and Models RPCs, a copy of their messages in
  `mock/proto/ai_grid/backend/v1` (see "Against a real backend" below).
  `bff/internal/protodrift` fails when that copy stops matching the vendored backend proto.
  When the console generates its types from the backend's proto, the copy, the draft and the
  drift test go. See `mock/proto/README.md`.
- Runs with its own ServiceAccount (`get/list/watch` on `ManagedCluster`) and Keycloak admin
  credentials. It is aligned with OSAC's fulfillment-service and is the "OSAC-like API
  layer" from the 2026-10-14 thread.
- RPCs on 2026-10-15: `AiGrid/Ping`, `ManagedClusters/ListManagedClusters` (name, labels,
  hubAcceptsClient), `Tenants/ListTenants` (Keycloak Organizations in the `ai-grid` realm).


### Against a real backend (stopgap)

Until the console moves to Connect and the backend's generated contract (issues 20–27 and the
ADRs in `docs/adr/`), the BFF calls a real backend's `ai_grid.v1.Clusters` `List`, `Get` and
`Update`, `Tenants` `List`, `Get`, `Create`, `Update` and `Delete`, and `Models`
`List`, `Get`, `Create`, `Update` and `Delete` for the clusters, tenants, models and
locations routes, and maps them onto the draft types, so the handlers and the JSON above are
unchanged (`bff/internal/backend/v1.go` and `v1_models.go`, messages in
`mock/proto/ai_grid/backend/v1`). The fake backend still serves the draft, so `--fake-backend`
keeps the draft clients. `If-Match` maps to `metadata.version` with `lock: true`, and the
`labels` and `annotations` mask paths to `metadata.labels` and `metadata.annotations`. The
cluster state is derived from `spec.hub_accepts_client`, `status.joined` and
`status.available_condition` only. The cluster list forwards `offset` and `limit`, which the
backend pages by; it doesn't evaluate `filter` yet and counts every cluster in `total`, so a
filtered cluster list answers 501 without calling it. The tenant list forwards `offset`, `limit` and `filter`; the
backend pages but doesn't evaluate `filter` yet, so a filtered list answers 501. A tenant write
sends `name` as `metadata.name` and `domains` as `spec.domains` (mask paths likewise), and the
`If-Match` version as `metadata.version` with `lock: true`. The backend requires a version
(`internal/servers/tenants_server.go`):
every tenant reads as version 1 or more, and an update or delete at version 0 is `InvalidArgument`
(422, with the backend's message). A write that sets a field the backend's `Tenant` lacks
(`description`, `enabled: false`, `attributes`, `identityProvider`) answers 501 before any call,
and so does an `alias`: on create, one other than the name; on PATCH, any alias. A
PATCH that leaves only no-op fields sends the mask `id`, which the backend answers with the
stored tenant after checking the version, writing nothing. DELETE sends the `If-Match` version as
`TenantsDeleteRequest.version`. The backend refuses a change to a label or annotation
outside `ai-grid/*` and the `location` label, and a bad coordinate, with `InvalidArgument` (422),
after it checks the version: a stale one is `Aborted` (409) whatever the labels.

The Subscriptions pages call the backend's `Subscriptions` RPCs over Connect, through the relay
(`docs/connect.md`, "The Subscriptions area"); the BFF has no `/api/v1/subscriptions` routes.

Models follow the backend's `internal/servers/models_server.go` and `models_git.go`. Its models have an `id` and no namespace (it keeps them
in one namespace of its own), so the BFF reports every model in its `--models-namespace` and
answers 404 for a model in any other; against a real backend, set it to the backend's subscription
namespace (`AI_GRID_SUBSCRIPTION_NAMESPACE`, default `models-as-a-service`), where the backend
publishes the models. `GET /locations` answers `Models/ListPlacementClusters` (`internal/servers/models_server.go`): the names of the
clusters a model can run on. The console places a model by those names, `name In [...]` over the
ACM `name` label, as the backend's git mode stores it, so a placement goes as it is, except claim
expressions, tolerations and spread constraints, which the backend lacks (501). A location is the
value of the `location` label, which a model's `placement.locations` reports; several clusters can
share one. A list with a filter or an order
answers 501, because the backend's filter uses its own field names. PATCH sends the draft's mask
unchanged, with the `If-Match` version and `lock: true`, and DELETE sends the `If-Match` version.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Language | Go, standard library `net/http` router, `google.golang.org/grpc` client against the draft `ai_grid.v1` package generated in `bff/gen` from `mock/proto`. No `client-go`, no backend module dependency. | The BFF reads nothing from the hub; its one Kubernetes call is a `SelfSubjectAccessReview` over plain HTTPS (`internal/hub`). One dependency less to keep in step with the hub. Compiling against the draft lets the BFF, the fake and the UI move ahead of the backend; the drift test keeps the draft honest against the vendored backend proto. |
| Identity | kube-auth-proxy authenticates the browser and sets `x-forwarded-user`, `x-forwarded-email`, `x-forwarded-groups` and `x-forwarded-access-token`. The BFF reads them (`internal/identity`) and forwards the token as `authorization: Bearer` plus the user, email and groups as gRPC metadata on every RPC (`internal/backend`): `x-forwarded-user`, `x-forwarded-email` and `x-forwarded-groups` (the groups joined with `,`). gRPC metadata values must be printable ASCII, and an OpenShift user or group name need not be, so the BFF percent-encodes each value (each group on its own, before the join): `%` and every byte outside 0x20–0x7E become `%XX` with upper-case hex, and nothing else changes, so an ASCII value without `%` is sent byte for byte (`équipe-ops` is sent as `%C3%A9quipe-ops`, `100%` as `100%25`). The proposed decoding, not yet agreed with the backend team: split the groups on `,`, then percent-decode each value (Go: `url.PathUnescape`, which leaves `+` alone) to get the UTF-8 name back. The fake does so where it reads the user; the shipped backend doesn't decode yet, so it sees a non-ASCII name still encoded (an ASCII name without `%`, the usual case, is unchanged either way). These values are advisory: the backend authorizes with `authorization` only. The draft proto's `AiGrid/GetCurrentUser` is the RPC that will return the backend's view of the caller. | The backend decides what the caller may do, and the BFF has no credential of its own. Until the backend authorizes the caller, the BFF makes one decision itself: only a provider admin (see `isProviderAdmin`) reaches `/api/v1` beyond `GET /user` and `GET /config`, and others get 403 (`AGENTS.md`, known exceptions). The proxy's provider can change (OpenShift OAuth today, a Keycloak realm later) without touching the BFF. |
| `isProviderAdmin` | The hub's answer to a `SelfSubjectAccessReview` for `patch` on `managedclusters`, asked with the caller's own token (`HUB_API_URL`, in-cluster by default). | The user's RBAC decides, not a console setting (review of 2026-10-15). The UI uses it to show or hide actions, and until the backend authorizes the caller the BFF also refuses non-admins on `/api/v1` with it (see Identity). A `GetCurrentUser` RPC can take this over once the backend acts as the caller. |
| Login in development | The Vite dev server and `hack/api.sh` set the same headers from `oc whoami` and `oc whoami -t`. `make dev-cluster` forwards the backend of the console deployed on the hub (`hack/forward-backend.sh`); `make dev` uses one run from the backend repository with `--kubeconfig`. | Any developer who has run `oc login` works against a real hub. |
| Deployment | One pod: kube-auth-proxy (:8443), bff on `127.0.0.1:8080`, ai-grid-backend on `127.0.0.1:9090`. The BFF dials the backend in plaintext over loopback; plaintext to any other address is refused unless `BACKEND_INSECURE=true`. The kubelet probes `/readyz` through the proxy (`--skip-auth-route=^/readyz$`); neither the BFF nor the backend has a probe of its own. The rollout strategy is `Recreate`: the backend serializes each organization's writes with in-process locks (ai-grid-cloud/ai-grid-provider-backend#16), which hold only with one backend, so an upgrade stops the pod before the new one starts and the console is unavailable until it's ready. That covers rollouts only, not a pod deleted by hand or evicted. Client-side `kubectl apply` and `helm upgrade` switch an existing Deployment to `Recreate`; server-side apply refuses it while the defaulted `rollingUpdate` is there. | Nothing on the pod network can reach the BFF with forged identity headers or the backend at all. When the backend gets its own Deployment, set `BACKEND_ADDRESS` to its Service and `BACKEND_CA_FILE` to its serving CA. |
| Cluster labels | `ai-grid/enabled`, `ai-grid/role` (`combined`, `ingress` or `inference`: what the hub installs on a member; the Clusters table shows it, `ingress` as "MaaS (ingress)", the clusters tenants send requests to), `ai-grid/provisioned`, `location`, `ai-grid/site`, `ai-grid/region`, and ACM's `openshiftVersion`. | The POC's conventions (site and region were added to the POC on 2026-10-14) so that Placements written by either tool select the same clusters. The BFF derives fields from the labels the backend returns. |
| Response envelope | Success: `{"data": ...}`; a paged list adds `"meta": {"size", "total", "offset", "limit"}` next to `data` (`limit` omitted when the caller asked for everything, `total` omitted when it is unknown; see "Writes, versions and lists"). Error: `{"error": {"code": "<http status>", "message": "..."}}`. `DELETE` answers 204 with no body. | Same as the odh-dashboard BFFs; `meta` is only on list endpoints that page, so the shape of `data` never changes. |
| Tests | `httptest` against an in-memory backend (`internal/backend/backendtest`, gRPC over `bufconn`). | No cluster, no binaries; the fake records incoming metadata so identity forwarding is tested. `hack/smoke.sh` checks a live backend. |

## Modules

```
bff/
  cmd/                  flags, server start and graceful stop
  internal/config       flags and env vars
  internal/identity     Identity from proxy headers, context helpers
  internal/backend      gRPC client, identity-forwarding interceptor; backendtest/ fake server
  internal/relay        reverse proxy for the browser's Connect calls to the backend (/ai_grid.v1.*)
  internal/api          App, routes, middleware, gRPC-to-HTTP error mapping, handlers, SPA
```

Each setting is a flag with an environment variable as its fallback (`--port`, `PORT`); a flag
given on the command line wins. A variable whose value does not parse (`PORT=8o80`) stops the
BFF at startup with an error naming it, unless its flag was given (`PORT=8o80 bff --port=9000`
listens on 9000).

Adding an endpoint: draft the RPC in `mock/proto/ai_grid/v1` (and propose it to the backend),
`make -C bff generate`, implement or stub it in the fake, map it in a handler under `internal/api`, add it to the table below and to
`frontend/src/api/ConsoleService.ts`.
The handler does transport only; validation, defaults, versions, filtering and derived fields
belong to the backend (the root `AGENTS.md`, which also lists the exceptions the BFF still has).

## Endpoints

Paths are under `/api/v1`, except `/healthcheck` and `/readyz` at the root, the Perses relay
under `/perses/api`, and the Connect relay to the backend's own RPCs under `/ai_grid.v1.`
("The Connect relay" below).

### Implemented

| Method | Path | Returns | Backend RPC |
|---|---|---|---|
| GET | `/healthcheck` | `{status, version}` | none; no identity and no backend call: a check, by a person or a script on the pod, that the BFF process serves HTTP and which build it is (`version`). No probe uses it: the kubelet probes only `/readyz` (below), and there is deliberately no liveness probe, which would restart the BFF whenever the proxy in front of it is down. Through the route it is behind the login like any page (the proxy skips auth for `/readyz` only) |
| GET | `/readyz` | `{status, version, backend}` | `AiGrid/Ping`; readiness, 503 when the backend does not answer. The pod is then unready, and with the one replica the chart runs, the Service has no endpoint left: the OpenShift router answers every request with its own 503 page (HTML, not this API's JSON error), until the backend answers again |
| GET | `/api/v1/user` | `{username, email?, groups, isProviderAdmin}` (`email` omitted when the proxy sends none) | none; the identity from the proxy headers, `isProviderAdmin` from a hub `SelfSubjectAccessReview` |
| GET | `/api/v1/config` | `{gridEndpoint, mapTileUrl, mapTileAttribution, billingUrl, version, modelsNamespace, fakeBackend, monitoring: {enabled, persesProject}}`: `modelsNamespace` is the namespace the console creates models in (default `models-as-a-service`, the backend's subscription namespace; `make dev-fake` sets `ai-grid-models` for the fake's fixtures), `fakeBackend` makes the UI show its fake-backend banner, `monitoring.enabled` says the BFF relays `/perses/api` (it has a `PERSES_URL`) and `monitoring.persesProject` names the one Perses project the relay reads, whose `dashboard-*` objects are the Monitoring tabs (always set when `monitoring.enabled`) | none; env `GRID_CONSUMER_URL`, `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION` (the attribution shown with `MAP_TILE_URL`'s tiles; with no `MAP_TILE_URL` the map draws a bundled land outline), `BILLING_URL`, `MODELS_NAMESPACE`, `FAKE_BACKEND`, `PERSES_URL`, `PERSES_PROJECT` |
| GET | `/api/v1/tenants?offset=&limit=&filter=` | `Tenant[]` in Keycloak's order (by name, the realm database's collation) plus `meta`; `filter` is a CEL expression the client writes, over `this` (a Tenant), see "Writes, versions and lists"; `limit` omitted returns everything; the removed `search` is 422 | `Tenants/ListTenants` with `offset`, `limit` and `filter` exactly as sent |
| GET | `/api/v1/tenants/{id}` | `Tenant`, `ETag: "<resourceVersion>"` | `Tenants/GetTenant`; 404 with the backend's message when absent |
| POST | `/api/v1/tenants` | 201, `Tenant` as created, `Location: /api/v1/tenants/{id}`, `ETag` | `Tenants/CreateTenant`; 422 with Keycloak's message on a bad name, alias or domain, 409 on a taken name or alias |
| PATCH | `/api/v1/tenants/{id}` | `Tenant` after the write, with its `ETag` | `Tenants/UpdateTenant` with the present body fields as the mask (`alias` included) and the `If-Match` version as `object.resource_version`; an empty body is 422; 422 "Cannot change the alias", 409 on a taken or blank name (Keycloak's own answer to a blank one) or a stale `If-Match`, 428 without `If-Match` |
| DELETE | `/api/v1/tenants/{id}` | 204 | `Tenants/DeleteTenant` with the `If-Match` version as `resource_version`; 404 when absent, 409 on a stale `If-Match`, 428 without `If-Match` |
| GET | `/api/v1/models?offset=&limit=&filter=` | `Model[]` by namespace and name plus `meta`; `filter` is CEL over `this` (a Model) as for tenants; the removed `namespace` and `label` are 422 | `Models/ListModels` with `offset`, `limit` and `filter` exactly as sent |
| GET | `/api/v1/models/{namespace}/{name}` | `Model`, `ETag: "<resourceVersion>"` | `Models/GetModel`; 404 with the backend's message (`object with identifier '<ns>/<name>' not found`) |
| POST | `/api/v1/models` | 201, `Model` with no conditions yet, `Location: /api/v1/models/{namespace}/{name}`, `ETag` | `Models/CreateModel`; 422 with the API server's or the CRD's message (a name that is not a DNS-1123 subdomain, a negative `replicas`, `replicas` with `scaling`, `scaling` without `maxReplicas`, without a trigger, with `maxReplicas` below 1 or a negative `minReplicas` (`minReplicas: 0` counts as unset and defaults to 1) or with `minReplicas` above `maxReplicas`) or the console's own (URI scheme, Placement operators, rollout fields, `rollout` without `placement`), 409 on a taken name, 412 `ManifestWorkReplicaSet feature gate disabled on hub` when `placement` is set on a hub without the controller |
| PATCH | `/api/v1/models/{namespace}/{name}` | `Model` after the write, with its `ETag` | `UpdateModel` (no read first) with every present field as the mask (`spec.replicas`, `spec.main.image`, `spec.main.env`, `spec.placement`, `spec.rollout`, `metadata.labels`, `metadata.annotations`) and `lock: true` on the `If-Match` version; an empty body is 422; 409 when the object is not at that version, 428 without `If-Match`, 412 when a placement is added on a gated hub |
| DELETE | `/api/v1/models/{namespace}/{name}` | 204; the model is gone at once (the MWRS cascades `Background`, its works drain out of sight) | `Models/DeleteModel` with the `If-Match` version as `resource_version`; 404 when absent, 409 on a stale `If-Match`, 428 without `If-Match`, 412 while a catalog entry, a subscription or an auth policy references the model (on the fake, subscriptions and auth policies block it; catalog entries don't exist yet) |
| GET | `/api/v1/capabilities` | `{manifestWorkReplicaSetEnabled, observabilityInstalled, acmVersion}` | `AiGrid/GetHubCapabilities`; 501 against a backend without the RPC, which a client reads as "unknown" |
| GET, POST | `/perses/api/<Perses API path>` | Perses's own answer, status and body unchanged, with only its `Content-Type`, `Content-Encoding`, `Content-Length`, `Vary`, `Cache-Control`, `Date`, `Age` and `Expires` headers; a redirect from Perses is 502 | none; the Monitoring page's relay to the hub's Perses (`PERSES_URL`), see "The Perses relay" |
| GET | `/api/v1/locations` | `string[]`: the names of the clusters a model can be placed on (the values of the placement's `name In [...]`), in the backend's order; despite the path, not `location` labels | `Models/ListLocations` (proposal P7, `mock/proto/README.md`); against the backend, `Models/ListPlacementClusters` |
| GET | `/api/v1/grid/overview?range=1h\|6h\|24h&site=&metrics=false` | (Only the Monitoring fallback, without a Perses relay; the map reads `Clusters/List`.) `GridOverview`: `{updatedAt, inventorySource?, demo, metricsSource?, clusters, metrics}`; `inventorySource` (`acm\|git`) and `metricsSource` (`thanos\|demo`) are omitted when the backend does not say, and each metric's `status` (`ok\|no-data\|unavailable\|not-configured`) likewise | `Grid/GetOverview`; `range` is forwarded as sent (the backend defaults it to `1h` and refuses anything but `1h`, `6h` and `24h` with 422), an empty `site` selects every site and only `metrics=false` leaves the metrics out |

`GridCluster`, each of the clusters of `GET /api/v1/grid/overview` (the Monitoring fallback;
the Clusters pages read `Clusters/List`). Fields the backend does not fill are omitted or empty,
so a client also works against a backend that only returns `name`, `labels`, `hubAcceptsClient`:

```json
{
  "name": "site-paris-1",
  "aiGridEnabled": true,
  "provisioned": true,
  "hubAcceptsClient": true,
  "location": "paris",
  "site": "paris-dc1",
  "region": "europe-west",
  "openshiftVersion": "4.22.15",
  "status": "ready",
  "statusMessage": "Managed cluster is available",
  "consoleUrl": "https://console-openshift-console.apps.site-paris-1.example.com",
  "kubernetesVersion": "v1.35.6",
  "platform": "BareMetal",
  "product": "OpenShift",
  "gpuCapacity": 32,
  "capacity": {"cpu": "192", "memory": "1572864Mi", "nvidia.com/gpu": "32", "...": "..."},
  "allocatable": {"cpu": "186", "memory": "1540000Mi", "nvidia.com/gpu": "32", "...": "..."},
  "gpus": {
    "total": 32, "nodeCount": 4,
    "configurations": [{"vendor": "NVIDIA", "product": "NVIDIA-H200", "memoryMib": 143771, "gpusPerNode": 8, "nodeCount": 4, "sharing": {"strategy": "none", "replicas": 1, "migCapable": true}}],
    "nodes": [{"name": "gpu-h200-0.paris.example", "vendor": "NVIDIA", "product": "NVIDIA-H200", "count": 8, "memoryMib": 143771, "family": "hopper", "computeCapability": "9.0", "driverVersion": "580.105.08", "cudaRuntimeVersion": "13.0", "sharing": {"strategy": "none", "replicas": 1, "migCapable": true}, "instanceType": "p5en.48xlarge", "ready": true}, "..."]
  },
  "creationTimestamp": "2026-10-01T09:00:00Z",
  "siteName": "Paris DC1",
  "latitude": 48.8566,
  "longitude": 2.3522,
  "addons": {"work-manager": "available", "cluster-proxy": "available", "...": "..."},
  "conditions": [{"type": "ManagedClusterConditionAvailable", "status": "True", "reason": "ManagedClusterAvailable", "message": "Managed cluster is available", "lastTransitionTime": "2026-10-01T09:00:08Z"}],
  "resourceVersion": "48811204",
  "labels": {"ai-grid/enabled": "true", "...": "..."},
  "annotations": {"ai-grid/site-name": "Paris DC1", "...": "..."}
}
```

- `status` is the backend's `status.state`, derived server-side from the conditions in the
  ACM console's order (`mock/research/acm.md` section 1), in the ACM console's words:
  `ready | offline | unknown | pendingimport | importing | importfailed | detaching | notaccepted`.
  `statusMessage` is the message of the condition that decided it. When the backend reports
  no state (`MANAGED_CLUSTER_STATE_UNSPECIFIED`: a cluster with no conditions, or today's
  backend that sends no status at all) `status` is omitted. The ACM console shows `failed`
  for a cluster with no conditions; the BFF deliberately does not, because the same value also means "the backend did not derive one".
- `consoleUrl`, `platform`, `product` come from the claims
  `consoleurl.cluster.open-cluster-management.io`, `platform.open-cluster-management.io`,
  `product.open-cluster-management.io`; `gpuCapacity` from `status.capacity["nvidia.com/gpu"]`
  (0 when absent); `addons` from the `feature.open-cluster-management.io/addon-*` labels.
- `capacity` and `allocatable` are `status.capacity` and `status.allocatable` as the backend
  sends them (Kubernetes quantity strings by resource name), and `creationTimestamp` is the
  hub object's; each is omitted when the backend sends none. A real backend without its
  cluster status details (conditions, Kubernetes version, capacity, allocatable, claims)
  sends the creation time only, so the page shows those as not reported.
- `gpus` is the backend's `status.gpus`, the cluster's GPU inventory, passed through: `total`
  GPU devices as GPU Feature Discovery counts them (physical GPUs, but MIG devices on a node with
  MIG strategy `single`, where GFD reports no physical count) and `nodeCount` GPU nodes; `configurations`, the distinct node configurations
  (vendor, product, memory in MiB per GPU, GPUs per node, sharing) with how many nodes have
  each, most nodes first; and every GPU `node` (product, count, memory, architecture `family`,
  `computeCapability`, `driverVersion`, `cudaRuntimeVersion`, `sharing`, `instanceType`,
  `ready`). `sharing.strategy` is `none`, `time-slicing`, `mps` or `mig` (with `migStrategy`
  `single` or `mixed`), and `replicas` the schedulable units per GPU. The backend reads it from
  ACM Search's index of the spoke's nodes and their NVIDIA GPU Feature Discovery labels
  (`ManagedClusterInfo` carries none); the BFF derives nothing. Omitted when the backend has no
  inventory for the cluster (no GPU nodes, or Search unavailable or not yet indexed);
  `gpuCapacity` still counts the schedulable GPUs then. A real backend sends it from ai-grid-provider-backend's `feat/cluster-gpus` on (`status.gpus`, field 10), and `bff/internal/backend/v1.go` copies it onto the draft field for field (`fromV1GPUs`); an older one sends none.
- `siteName`, `latitude`, `longitude` come from the `ai-grid/site-name`, `ai-grid/latitude`,
  `ai-grid/longitude` annotations; coordinates are omitted when absent or not a finite number
  in range (`NaN` and `Inf` parse but cannot be encoded, so they count as absent).
- `conditions[].lastTransitionTime` is omitted when the hub recorded none; it is never the
  Unix epoch.

`Tenant` (a Keycloak Organization in the `ai-grid` realm, `mock/research/keycloak.md` section 4;
the collections are always present even though Keycloak omits an empty `domains`):

```json
{
  "id": "3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c",
  "name": "acme-robotics",
  "alias": "acme-robotics",
  "enabled": true,
  "description": "Acme Robotics, EU region",
  "domains": ["acme-robotics.example.com", "acme.example.org"],
  "domainDetails": [
    {"name": "acme-robotics.example.com", "verified": true, "autoRedirect": true},
    {"name": "acme.example.org", "verified": false, "autoRedirect": false}
  ],
  "attributes": {"ai-grid/region": "europe-west", "billing-account": "ACME-0042"},
  "identityProvider": {"...": "..."},
  "resourceVersion": "1",
  "createTime": "2026-10-10T08:00:00Z"
}
```

- `alias` is the URL-safe handle: it defaults to `name` on create and cannot change
  afterwards. Against today's backend (fields `id`, `name`, `domains` only) the BFF leaves it
  empty (after a rename it no longer equals `name`), derives `domainDetails` from `domains` and
  reads the absent `enabled` as true (Keycloak's default), so a client does not see every tenant
  as disabled.
- `domains` are the names of `domainDetails`, lower-case, unique across tenants; Keycloak
  accepts the domain part of an e-mail address or one wildcard `*.base.tld`.
  `identityProviderAlias` is present only for a domain routed to one of the organization's
  identity providers; the fake realm has none, so the fake never returns it.
- `identityProvider` is the organization's OIDC identity provider as the console's organization
  wizard configures it (proposal P1, `Tenant.identity_provider = 11`); omitted for an
  organization without one. A write that sets it is validated by the backend, whose field
  violations come back as `fieldErrors` under `identityProvider.*`.
- `createTime` is when the backend created the organization (proposal P3,
  `Tenant.create_time = 12`, output only); omitted for an organization created some other way,
  which the console shows as "—".
- `resourceVersion` is the version the backend keeps for the tenant (Keycloak has none), also
  sent as the `ETag`; omitted from a backend that keeps none (today's).

`POST /api/v1/tenants` body: `{"name": "acme-robotics", "alias": "acme", "description": "...",
"enabled": true, "domains": ["acme.example.com"], "attributes": {"k": "v"}}`; only `name` is
required, `alias` defaults to the name, an omitted `enabled` is passed through as unset and
the backend applies Keycloak's default (true). Unknown fields, trailing content after the JSON
value and malformed JSON are rejected (422), a body over 1 MiB with 413; everything else is
validated by the backend, whose Keycloak message comes back as the 422 or 409 message.

`PATCH /api/v1/tenants/{id}` body, every field optional: `{"name": "...", "description": "...",
"enabled": false, "domains": ["..."], "attributes": {"k": "v"}, "alias": "<unchanged>"}`. An
absent field is left alone; a present field replaces the stored one as a whole (`domains: []`
removes every domain, `attributes: {}` every attribute; a domain that stays keeps its `verified`
and identity-provider metadata); `null` is the same as absent. The present fields become the
field mask of one `UpdateTenant` call, `alias` included: the backend keeps the stored alias and
answers a different one with Keycloak's 422 "Cannot change the alias", so a form can send back
the alias it loaded. Today's backend has no `alias`, so against it any `alias` is 501. A body that names no field is 422, before any call. The backend skips a PUT
that would change nothing (console proposal, so Keycloak writes no admin event) and answers the
tenant with its stored `resourceVersion`. Keycloak Organizations carry no version; the backend
keeps one for them (see "Writes, versions and lists").

`Model` (a KServe `LLMInferenceService`, `mock/research/models-maas.md` 2.1, with the ACM
`Placement` and `ManifestWorkReplicaSet` the backend keeps for a multi-site model,
`mock/research/acm.md` 3 and 4; close to the POC's `ManagedModel` without its inventions:
no `revision`, `status: Saved`, `hasDeployment`; collections are always present). Abridged
(fewer conditions, times elided); `mock/examples/get-models.json` has the full objects:

```json
{
  "name": "granite-8b-instruct", "namespace": "ai-grid-models",
  "displayName": "Granite 8B Instruct", "description": "Served on every enrolled and provisioned site.",
  "modelUri": "hf://example-org/granite-8b-instruct", "modelName": "example-org/granite-8b-instruct",
  "runtimeImage": "quay.io/example/vllm-cuda:v0.11.0", "replicas": 1,
  "baseRefs": ["v3-6-0-kserve-config-llm-template"],
  "requests": {"cpu": "8", "memory": "32Gi", "nvidia.com/gpu": "1"}, "limits": {"nvidia.com/gpu": "1"}, "env": [],
  "gateways": [{"name": "openshift-ai-inference", "namespace": "openshift-ingress"}],
  "phase": "ready", "reason": "Complete",
  "addresses": [], "conditions": [], "appliedConfigs": [],
  "placement": {
    "clusterSets": ["global"], "matchLabels": {"ai-grid/enabled": "true", "ai-grid/provisioned": "true"},
    "selectedClusters": ["site-paris-1"], "locations": ["paris"], "satisfied": true, "reason": "AllDecisionsScheduled", "message": "All cluster decisions scheduled",
    "conditions": [{"type": "PlacementSatisfied", "status": "True", "reason": "AllDecisionsScheduled", "message": "All cluster decisions scheduled", "lastTransitionTime": "..."}]
  },
  "rollout": {
    "strategy": "All", "progressDeadline": "15m",
    "summary": {"total": 1, "applied": 1, "available": 1, "progressing": 0, "degraded": 0},
    "rolledOut": true, "applied": true, "reason": "AsExpected",
    "conditions": [{"type": "PlacementVerified", "status": "True", "reason": "AsExpected"}, {"type": "PlacementRolledOut", "status": "True", "reason": "Complete"}, {"type": "ManifestworkApplied", "status": "True", "reason": "AsExpected"}],
    "works": [{
      "cluster": "site-paris-1", "workName": "model-granite-8b-instructx7k2p",
      "applied": "True", "available": "True", "progressing": "False", "degraded": "False",
      "feedback": {"ready": "True", "url": "https://openshift-ai-inference.apps.site-paris-1.example.com/ai-grid-models/granite-8b-instruct"},
      "phase": "ready",
      "conditions": [{"type": "Applied", "status": "True", "reason": "AppliedManifestWorkComplete", "message": "Apply manifest work complete"}],
      "generation": 1, "observedGeneration": 1
    }]
  },
  "labels": {"ai-grid/family": "granite"}, "annotations": {"openshift.io/display-name": "Granite 8B Instruct"},
  "resourceVersion": "48760230", "generation": 1, "creationTimestamp": "2026-10-10T08:00:00Z"
}
```

- `phase` is the backend's derivation (`ModelPhase` in `mock/proto/ai_grid/v1/model_type.proto`):
  for a hub deployment from the `Ready` condition (True `ready`; False with a reason that does
  not recover on its own, `ConfigNotFound`, `RefsInvalid` or `GatewaysNotReady`, `failed` with
  its reason and message; False with any other reason, absent or Unknown `pending` with the
  condition's reason); for a placed model from the ManifestWorkReplicaSet conditions
  (`PlacementRolledOut` and `ManifestworkApplied` True `ready`; some works `ready` and others
  not `partiallyavailable`, reason `PartiallyAvailable`, message "<n> of <m> clusters are
  serving the model." (proposal P13); `ManifestworkApplied` False/`NotAsExpected` with a
  degraded or unapplied work `failed`; otherwise `pending` with the deciding reason). KServe reports `Ready=False` with `WaitingForGateway`, `Progressing` or
  `MinimumReplicasUnavailable` while a healthy model starts, so those read `pending`. A
  workload that never becomes available keeps `MinimumReplicasUnavailable`, which no condition
  tells apart from a slow start, so it stays `pending` with that reason, as a stuck spoke does.
- `url`, `addresses`, `conditions` and `appliedConfigs` are the hub LLMInferenceService's
  and stay empty for a placed model (`url` is then omitted, as it is for a hub model until
  KServe has written its route, about 5 s after creation, or when its Gateway does not
  exist), whose per-site state is in `rollout.works[]`:
  `applied`, `available`, `progressing`, `degraded` are the work's condition statuses
  (`True|False|Unknown`, absent until the agent writes them) and `feedback` the `ready` and
  `url` values the agent scraped from the spoke object. `phase`, `reason` and `message` are the
  backend's summary of the model on that cluster (proposal P13, `ManifestWorkStatus.phase`):
  `ready` when the `ready` feedback is True; `failed` when `Applied` is False or `Degraded` is
  True, with that condition's reason and message; otherwise `pending`, with no reason before the
  agent reports, else `Available`'s while it is not True, else `Progressing`'s. The Models page
  lists them per cluster. `workName` is `model-<name>` plus five
  random characters, no separator (the API server's `generateName` on the MWRS name, cut to 58
  characters).
- `placement.locations` are the `location` labels of the decided clusters, unique and sorted
  (proposal P8, `PlacementStatus.locations = 4`); a decided cluster without the label adds
  nothing. The console shows a model's locations from it, whatever selected the clusters.
- `rollout.summary` counts the works at the current template; the CRD's `desiredTotal` and
  `updated` are never written by OCM, so the JSON leaves them out. `maxConcurrency` applies to
  `Progressive` only (`All` and `ProgressivePerGroup` have no such field; the backend refuses
  it there).
- `displayName` and `description` are the `openshift.io/display-name` and
  `openshift.io/description` annotations; a client sets them through `annotations`, on
  create and on PATCH alike.

`POST /api/v1/models` body (the POC deploy wizard's inputs mapped to the spec,
`mock/research/models-maas.md` 7.3): `{"name", "namespace", "modelUri", "modelName",
"runtimeImage", "runtime", "replicas" | "scaling": {"minReplicas", "maxReplicas", "triggers":
[{"type", "metadata"}]}, "baseRefs": ["..."], "cpu": "8", "memory": "32Gi", "gpuCount": 1,
"env": [{"name", "value"}], "gateway": {"name", "namespace"}, "placement": {"clusterSets",
"matchLabels", "matchExpressions": [{"key", "operator", "values"}], "claimExpressions",
"tolerations": [{"key", "operator", "value", "effect", "tolerationSeconds"}],
"numberOfClusters"}, "rollout": {"strategy": "All|Progressive|ProgressivePerGroup",
"maxConcurrency", "maxFailures", "progressDeadline", "minSuccessTime"}, "labels",
"annotations"}`. `name`, `namespace` and `modelUri` are required by the backend; `cpu`, `memory`
and `gpuCount` become the main container's requests (the GPU also its limit); `scaling` becomes
a `spec.scaling.keda` block and is refused with the CRD's own messages when it comes with
`replicas`, without `maxReplicas`, without a trigger, with `maxReplicas` below 1 or a negative
`minReplicas` (`minReplicas: 0` counts as unset and defaults to 1) or with `minReplicas` above
`maxReplicas`; the gateway defaults to `openshift-ingress/openshift-ai-inference`, the route and
the scheduler are always managed; `rollout` without `placement` is 422. The display name and
description go in `annotations` (`openshift.io/display-name`, `openshift.io/description`), as on
PATCH; `displayName` and `description` are not body fields (422 unknown field). The same body
rules as the other POSTs apply (unknown fields 422, over 1 MiB 413). Open question: a `namespace` that does not exist. The fake creates the model anyway, a real API server answers NotFound, and the backend has not decided whether it creates the namespace (`mock/areas/models.md`, "Remaining").

`PATCH /api/v1/models/{namespace}/{name}` body, every field optional: `{"replicas", "runtimeImage",
"env": [...], "placement": {...} | null, "rollout": {...}, "labels", "annotations"}`. A present
field replaces the stored one as a whole (`env: []` removes every variable, `placement: null`
makes the model a hub deployment again, `labels` and `annotations` are whole maps) and goes into
the mask whatever the stored value; the BFF does not read the model first. `displayName` and
`description` are not body fields (422 unknown field), here as on POST: a page edits the
`openshift.io/display-name` and `openshift.io/description` keys of the `annotations` map it
loaded. A rollout is sent only when the client sends one; the backend drops the stored rollout
when the placement is removed without a new one. A body that names no field is 422, before any
call. A spec change bumps `generation`; a change of
anything but `placement` and `rollout` also rolls the Deployment out again and makes a placed
model re-apply its works, while a change of only `rollout` or `placement` re-applies none (a new
placement adds and removes the works of clusters entering and leaving the decision). An update
that leaves the spec, labels and annotations as stored is not written and keeps the
`resourceVersion`.

The list response:

```json
{"data": [...], "meta": {"size": 10, "total": 42, "offset": 0, "limit": 10}}
```

### Writes, versions and lists

Rules every handler shares; the BFF only moves them between HTTP and the RPCs, the backend
decides.

- **Request bodies must be JSON.** Every POST, PATCH and PUT whose `Content-Type` is not
  `application/json` (case-insensitive, parameters such as `charset` allowed) is 415
  `request body must be JSON: send Content-Type: application/json`, before the body is read
  and before the hub or the backend is called. A browser sends an HTML form or a `text/plain`
  `fetch` cross-site without a CORS preflight; this is what keeps another app under the
  cluster's `apps` domain from writing with an admin's session.
- **`ETag` and `If-Match`.** `GET` of one cluster, tenant or model, and the answer to its POST
  or PATCH, carry `ETag: "<resourceVersion>"` (the same value as `resourceVersion` in the
  JSON; no header when the backend reports no version, as today's backend does for tenants).
  The draft's backend must return a non-empty `resource_version` on every object it serves:
  with If-Match required, an object without one could never be updated or deleted.
  Every PATCH and DELETE must send it back as `If-Match`; the BFF passes it to the backend as
  the request's expected version and the backend refuses a stale one with `Aborted`, 409, so a
  tab opened before a colleague's change cannot overwrite or delete it:

  | Request | `If-Match` becomes |
  |---|---|
  | PATCH `/clusters/{name}` | `object.resource_version` with `lock: true` |
  | PATCH `/models/{namespace}/{name}` | `object.metadata.resource_version` with `lock: true` |
  | PATCH `/tenants/{id}` | `object.resource_version` (the draft's precondition: set means checked) |
  | DELETE `/tenants/{id}` | `DeleteTenantRequest.resource_version` |
  | DELETE `/models/{namespace}/{name}` | `DeleteModelRequest.resource_version` |

  A PATCH, PUT or DELETE without `If-Match` is 428 Precondition Required (RFC 6585) before the body
  is read and before any call: `this write needs an If-Match header: send the ETag that GET
  answered (the object's resourceVersion), for example If-Match: "42"`; `If-Match: *`, which
  names no version, is 428 too (`If-Match: * names no version: ...`). So every write carries the
  version its client read. After the provider-admin check (403 for a non-admin), the checks run in this order: 415 for a
  body that is not JSON, then 428, then the body (422, 413). `If-Match` must be one strong entity tag exactly as `ETag` sent
  it (`"42"`); a bare value, a weak tag (`W/"42"`) or a list is 422 `If-Match must be one entity
  tag as the ETag header sent it, for example "42"` before any call. The tenant version is the
  backend's (`Tenant.resource_version`, kept in an organization attribute;
  `mock/areas/tenants.md`, "Version"), so it changes only on writes through the backend.
- **Every PATCH is one update; the backend decides what changes.** The BFF reads nothing before
  a PATCH: each field present in the body goes into the update's object and its mask, whatever
  the stored value, and the backend applies the mask under optimistic locking. A body that names
  no field is 422 `the request body names no field to change` before any call (a non-admin gets
  403 from the provider-admin check first) (there is nothing
  to send; answering it like the GET would skip the version check). Whether an update changes
  anything is the backend's answer: a cluster or model update that leaves the object as stored
  is not written and comes back with the stored `resourceVersion` (the Kubernetes API server
  does the same with an unchanged update), and a tenant update that changes nothing is not PUT
  to Keycloak (console proposal). The version is still checked first, so a stale `If-Match` is
  409 even when nothing would change, and a viewer's update is 403.
- **`filter` is the client's CEL.** `GET /tenants` and `GET /models` take `filter`, a CEL
  expression over `this` (the proto message, `ai_grid.v1.Tenant` or `ai_grid.v1.Model` with its
  status, fields by their proto names) and `now` (the backend's time), in cel-go's standard
  library plus its strings extension (`ext.Strings()`). The BFF puts the decoded query value in
  the request's `filter` with surrounding whitespace trimmed (an empty or whitespace-only
  `filter=` is no filter; a repeated `filter` is 422 `query parameter "filter" must be sent
  once; join the conditions with && in one expression`) and never builds, rewrites or checks it;
  the backend evaluates it over the whole list before paging, so `meta.total` counts the
  matches. The client writes it, for example:

  | The page wants | `filter` |
  |---|---|
  | tenants whose name or a domain contains `acme`, ignoring ASCII case (the client lowers the term: `lowerAscii()` folds A-Z only) | `this.name.lowerAscii().contains("acme") \|\| this.domains.exists(d, d.lowerAscii().contains("acme"))` |
  | disabled tenants | `!this.enabled` |
  | models in one namespace | `this.metadata.namespace == "ai-grid-models"` |
  | models with a label, guarded | `"ai-grid/family" in this.metadata.labels && this.metadata.labels["ai-grid/family"] == "granite"` |
  | failed models | `this.status.phase == ai_grid.v1.ModelPhase.MODEL_PHASE_FAILED` |

  Values are CEL string literals (escape `"` and `\`), and the whole expression is URL-encoded
  in the query. The field names are the proto's (`this.metadata.labels`, `this.domains`), so
  they are part of this HTTP contract: renaming a proto field breaks the filters clients have
  written. No backend evaluates a cluster `filter` yet. CEL is strict: `contains` is a literal
  substring (`%` and `_` match themselves), and indexing a missing map key is a `no such key`
  error, not false, so a label term without the `in` guard fails on the first model that lacks
  the label. A filter that does not compile, is not a bool or fails on an object is the
  backend's `InvalidArgument`, 422 with its message: `filter <f> is not a valid CEL expression:
  <cel-go's error>`, `filter <f> must evaluate to a bool, not <type>`, `filter <f> failed on
  '<id>': no such key: <key>`. The parameters earlier versions of the BFF turned into CEL
  themselves, `search` on tenants and `namespace` and `label` on models, are 422 `query
  parameter "<name>" is not supported; send a CEL filter in "filter"`, so a client written for
  them gets an error, not the unfiltered list.
- **`meta.total` and backends that do not page.** `total` is the backend's count over the whole
  filtered list. The list responses carry it as an optional field: the draft's backends always
  set it, and a backend without it (today's: its `ListTenantsRequest` is empty, so `offset`,
  `limit` and `filter` are dropped on the wire) returns every item unfiltered. When the caller
  sent a `filter`, a `limit` or an `offset` above 0 and the answer has no `total`, the BFF
  answers 501 `the AI Grid backend does not support filtering or paging tenants yet; list them
  without filter, offset or limit` (`models` for the models list) instead of showing unfiltered
  rows as the result. Without those parameters the list is the whole list and `total` falls
  back to `offset + size`; in general the BFF omits `total` (unknown) when a page without a
  count is full (`size == limit`), because more may follow. This is compatibility with the
  shipped backend, not a check of the filter: the BFF only notices the missing count.

- **Field errors.** An `InvalidArgument` answer (422) that carries `BadRequest` field violations
  also carries `error.fieldErrors`, a map from the JSON path of the request body (for example
  `domains` or `modelRefs.0.tokenRateLimits.0.window`) to the backend's message, so the form
  can show each next to its field; when a path has several violations the first wins. No other
  code carries `fieldErrors`, whatever details the backend attached.
- **Lists.** The console's pages send none of the list parameters (`offset`, `limit`,
  `filter`): Clusters, Organizations and Models fetch the whole list and filter, sort and page
  in the browser; the Subscriptions pages call the backend over Connect. A repeated `offset` or `limit` is 422, like a repeated `filter`.

### Headers, caching and compression

- **The SPA** (every path outside `/api`, `/perses/api`, `/healthcheck` and `/readyz`:
  `index.html`, the client routes that fall back to it, and the files under `/assets/`) is
  sent with `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`. The console must not
  be framed by any page, including another app under the cluster's `*.apps` domain: that is
  same-site, so `SameSite=Lax` on the proxy's cookie does not stop it.
- **Caching.** Every file under `/assets/` is `Cache-Control: public, max-age=31536000,
  immutable`: Vite writes only content-hashed names there (`index-BPyNsiKc.css`, with
  base64url hashes), so a new build has new URLs. `index.html`, the client routes and the
  other root files (the favicon) are `no-cache`, so a browser revalidates them and picks up a
  new bundle at once.
- **The JSON API** answers carry `Content-Type: application/json`, `X-Content-Type-Options:
  nosniff` and `Cache-Control: no-store`, but no CSP: they are not pages. `/perses/api` answers
  keep the headers the relay sets.
- **Compression.** Every answer, the API, the SPA and the relay alike, is gzipped
  (`Content-Encoding: gzip`, no `Content-Length`) when the request's `Accept-Encoding` accepts
  gzip (RFC 9110 12.5.3: a `gzip` entry decides with its q, `*` counts only when `gzip` is
  not listed, a q of 0 or one that does not parse refuses), its type is `text/html`, `text/css`,
  `application/javascript`, `text/javascript`, `application/json` or `image/svg+xml`, and the
  body is 1 KiB or more. It is sent as it is for a `HEAD`, a request with `Range` (the ranges
  are of the uncompressed file), a 204 or 304, and an answer that already has a
  `Content-Encoding` (Perses's own gzip passes through the relay unchanged). Answers of those
  types carry `Vary: Accept-Encoding`. A handler that flushes (the relay streaming an answer)
  sends each part as it flushes, compressed, without waiting for the end.
- **A panic** in a handler is logged with its stack (`panic serving request`). Before anything
  was sent it answers a plain JSON 500. Once the status was sent (a gzip stream started, a part
  flushed), the connection is cut instead, without a gzip trailer: a 500 written into an answer
  under way would leave the client a body it cannot decode, or one that looks complete.

### Logs

One `request` line per request (method, path, status, duration) with `id`, the `X-Request-Id`
the client also gets, and `user`, the forwarded user name, once the proxy headers have been
read (never the token). The lines a handler writes about a change (`cluster updated`,
`tenant created`, `model deleted`, `subscription updated`, ...) and `request failed` carry the
same `id` and `user`, so the log says which admin changed what. A successful `/readyz` or
`/healthcheck` logs at Debug; a failed one stays at Info (and `backend not ready` at Warn).
`request failed` (Error) is for a 5xx other than 501. A 501, which a backend without the RPC
or option answers and the frontend shows as not available yet, logs its detail at Debug, as a
4xx does (`request rejected`); its `request` line still says `status=501`.

### The BFF is thin

The BFF does transport only (the root `AGENTS.md`), and the port's handlers follow it.
**`ai-grid-backend` must therefore validate every write RPC before that RPC goes live behind
the console.** The BFF forwards what it decodes. A write RPC that does not validate stores
whatever a client sends, and the page's inline messages, which only repeat the PoC's rules
before submit, are no protection. The fake's `BadRequest` field violations are the reference
for what to check and which message to send.

### The Perses relay

The Monitoring page embeds the hub's Perses dashboards the way the OpenShift AI dashboard's
Observability page does (odh-dashboard `packages/observability`): the browser calls only
`/perses/api`, and the server forwards the call with the user's own token
(`bff/internal/perses`). It is transport like the rest of the BFF. Perses authenticates the token
and authorizes each project (the Cluster Observability Operator's Perses uses Kubernetes authn
and authz: projects are namespaces), and its datasource proxy runs the queries.

**Where the caller's token goes.** The token reaches Perses, and does not stop there. With
Kubernetes authorization, Perses's datasource proxy sends the caller's `Authorization` header
unchanged to the datasource's URL (perses `internal/api/impl/proxy`,
`forwardCallerAuthorization`). So a query through a datasource hands a provider admin's hub token
to whatever server that datasource names, and whoever can write the datasource chooses that
server. That is why the relay reads one project, `PERSES_PROJECT` (required with `PERSES_URL`),
and the global datasources, and nothing else: not every project's dashboard list, not another
project, and not a datasource that a dashboard defines inside itself. The relay can't check
where a datasource points, so the operator must make sure that only provider admins can write
that project's dashboards and datasources, and that the global datasources point only at the
hub's own Thanos and Loki.

What the relay owns is the boundary:

- Only the provider-admin check's callers pass, as on `/api/v1` (401 without a token, 403 for a
  non-admin), until Perses or the backend can tell provider views from tenant ones: an
  organization admin must never reach the provider dashboards.
- Only the reads the Perses React components make, in the configured project `{P}`:
  `GET /api/v1/projects/{P}/dashboards[/{d}]`, `/api/v1/projects/{P}/datasources[/{d}]`,
  `/api/v1/globaldatasources[/{d}]`, and the Prometheus and Loki query APIs behind those
  datasources' proxies (`/proxy/projects/{P}/datasources/{d}/api/v1/query…`,
  `/proxy/globaldatasources/{d}/…`). Any other path is 404, `/api/v1/dashboards`, another
  project and `/proxy/projects/{P}/dashboards/{d}/datasources/…` included; a method other than
  `GET` is 405, except `POST` on a query path, which the Prometheus plugin sends as a form
  (`application/x-www-form-urlencoded`, else 415; at most 1 MiB, else 413). A path with an
  encoded slash, a dot segment or a doubled slash is 404, so Perses never sees another path than
  the one checked. `PERSES_PROJECT` must itself be one path segment of letters, digits, `-`, `_`
  and `.`, or the BFF doesn't start.
- Only `Accept`, `Accept-Encoding`, `Accept-Language`, `Content-Type` and `Authorization: Bearer
  <the caller's token>` reach Perses: no cookies, no proxy identity headers, no client-sent
  `Authorization`. With the browser's `Accept-Encoding`, a compressed answer passes through as
  Perses sent it.
- Only Perses's `Content-Type`, `Content-Encoding`, `Content-Length`, `Vary`, `Cache-Control`,
  and the `Date`, `Age` and `Expires` a cache needs to tell how fresh an answer is, reach the browser, plus the relay's own `X-Content-Type-Options: nosniff` and a sandbox
  `Content-Security-Policy`. Everything else stays behind: a `Set-Cookie` for the console's origin,
  a CORS grant (the console reads these answers from its own origin, so it would only open them to
  other sites), a datasource's `WWW-Authenticate` challenge (the browser would ask for a password on
  the console's origin), and a `Refresh` or `Link` that would send the browser elsewhere. A 3xx
  from Perses is 502 "the hub's Perses answered with a redirect, which the console doesn't follow",
  so its `Location` never reaches the browser either; the relay sends no conditional request, so
  Perses has no reason to answer 304.
  Nor do an informational answer (a `103 Early Hints` and its `Link`) or trailers, which Go's
  reverse proxy forwards outside the final answer's headers.
- Without `PERSES_URL`, every `/perses/api` path is 404 "monitoring is not configured on this
  console" and `GET /config` says `monitoring.enabled: false`.

Settings: `PERSES_URL` (https; `http://` only for loopback unless `PERSES_INSECURE=true`),
`PERSES_CA_FILE` (the hub's service CA for the operator's Perses), `PERSES_SERVER_NAME` (for a
port-forward to `127.0.0.1`), `PERSES_TIMEOUT` (30s, at most 50s, for the exchange with Perses from connecting to the last byte of its answer: past it the relay answers 504, or cuts an answer already started; the ceiling keeps it, with the provider-admin check before it, inside the server's 60s write timeout, which also cuts a browser that stops reading),
`PERSES_PROJECT` (required with `PERSES_URL`). To turn Monitoring on in the hub pod, set
`PERSES_URL` to `https://perses.openshift-cluster-observability-operator.svc:8080`,
`PERSES_PROJECT`, and `PERSES_CA_FILE` to the service CA
(`/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt` in an OpenShift pod): the
operator's Perses has a service-CA certificate, so without the CA file the relay answers 502.
The chart sets them from `console.perses` (`url`, `project`, and `caFile`, which defaults to that
service CA), and fails to render with a `url` and no `project`; its default `url` is empty, as
`manifests/base` sets neither, so a deployed console has Monitoring off until its values set
`url`. `make dev-cluster` forwards that Service when `PERSES_PROJECT` is set and your login may
(`hack/forward-perses.sh`); without `PERSES_PROJECT` it runs with Monitoring off. A `PERSES_URL`
you set yourself without `PERSES_PROJECT` stops the BFF at startup.

What a dashboard needs to appear on the page, for the team that writes them:

- It is a `PersesDashboard` in `PERSES_PROJECT` (the chart's `console.perses.project`) whose name
  starts with `dashboard-`, such as `dashboard-usage`. The prefix is how the console tells the
  dashboards meant as tabs from anything else kept in the project; the tab shows the dashboard's
  display name, or its name, and tabs are ordered by name.
- Its queries name a `PersesDatasource` in the same project or a `PersesGlobalDatasource` (by kind,
  or kind and name; one marked `default: true` is used when a query names only the kind), which
  reaches Prometheus or Loki through its `proxy`, not `directUrl`: the browser can't reach the
  hub's services. A datasource defined inside the dashboard itself fails in its panel.
- Its panels are among the bundled ones listed below.
- Only provider admins may create or edit the `PersesDashboard`s and `PersesDatasource`s in that
  project and the `PersesGlobalDatasource`s: Perses sends the signed-in admin's hub token to every
  datasource it queries, so whoever can point a datasource somewhere can collect that token.

The page (`frontend/src/pages/monitoring`): with `monitoring.enabled`, `/monitoring` lists the
dashboards of `monitoring.persesProject` through the relay and shows each `dashboard-*` one as a
tab, ordered by name and selected with `?dashboard=<name>`. A panel whose datasource the dashboard
defines itself shows an error in the panel instead of querying it. It renders the selected one with
Perses's own React components and the plugins bundled in `persesPlugins.ts` (Prometheus and
Loki datasources and queries; time series, stat, table, gauge, pie and markdown panels), loaded
with the page only. Not the bar chart: its tooltip is HTML built from unescaped series names, which
are label values. Not the logs table either: its 0.54-compatible package imports a stylesheet it
doesn't ship. Without
`monitoring.enabled`, `/monitoring` keeps the AI Grid overview's metrics (`Grid/GetOverview`).

### The Connect relay

The console is moving from the BFF's JSON API to the backend's own RPCs, called from the browser
over Connect with clients generated from the backend's proto (ADRs 0002 and 0004 in
`docs/adr/`; the generated code and its pin in `docs/dev-setup.md`, "The backend's API in the
frontend"). The BFF relays those calls (`bff/internal/relay`): an `httputil.ReverseProxy` for the
paths under `/ai_grid.v1.`, to the backend at `BACKEND_ADDRESS`, which serves Connect, gRPC and
gRPC-Web on its gRPC port over HTTP/1.1 and h2c. It is transport and nothing else: it compiles
against no contract and never reads a body. A new RPC needs no transport implementation;
until backend authorization lands it requires review for the procedure allowlist. The Clusters
pages and the AI Grid map use it (`Clusters/List`, `Get`, `Update`); every `/api/v1` route stays
as it is.

What the relay owns is the boundary:

- **Who may call.** The same checks as `/api/v1`, before anything else: the token header (401
  without one), then the provider-admin check (401 for a token the hub rejects, 403 for a
  caller who isn't a provider admin, 502 when the hub can't answer). On these paths the BFF's
  own refusals are Connect errors, `{"code": "unauthenticated" | "permission_denied" | ..., "message"}`
  with the same HTTP status, which the browser's Connect client reads; the backend's own errors
  pass through as it sent them.
- **What reaches the backend about the caller.** Of the browser's request, `Authorization`,
  `Proxy-Authorization`, `Cookie`, `Forwarded`, every `X-Forwarded-*` and `X-Auth-Request-*`
  header and the configured `AUTH_*_HEADER`s are dropped (Go's reverse proxy also drops the
  hop-by-hop headers). Then the relay sets the caller as the BFF read them from the proxy's
  headers, exactly as on every gRPC call (`internal/backend`, `forwardIdentity`):
  `Authorization: Bearer <token>`, and `x-forwarded-user`, `x-forwarded-email` and
  `x-forwarded-groups`, each percent-encoded and the groups joined with `,` (see Identity under
  "Decisions"); a field the caller doesn't have is not sent. The rest of the request (the
  Connect headers such as `Connect-Protocol-Version` and `Connect-Timeout-Ms`, `Content-Type`,
  `Accept-Encoding`, the query of a Connect GET) passes unchanged.
- **Which calls.** Only a path `/ai_grid.v1.<Service>/<Method>` (letters, digits and `_`; no
  further segment, dot segment or escape), so the backend routes the path that was checked, and
  never its REST gateway, health or reflection on the same port: any other path under the
  prefix is 404 (`unimplemented`). The explicit allowlist permits the existing console
  operations: `AiGrid/Ping`, Clusters List/Get/Update, Tenants CRUD/List, Models CRUD/List
  and ListPlacementClusters, and Subscriptions CRUD/List (the Subscriptions pages, and the
  Models page's list of the subscriptions that use a model). Clusters Create/Delete, the
  deprecated `Models/ListLocations`, `Tenants/ListMembers`
  (the console never lists an organization's members: one organization is one tenant, and the
  provider must not see a company's internals), unknown services and future methods return 404
  until reviewed (AGENTS.md, "Known exceptions"). Only `POST` (Connect unary and streaming calls) and `GET`
  (Connect's GET, for methods the proto marks free of side effects): any other method is 405
  (`unimplemented`) with `Allow: GET, POST`, after the caller checks, as on `/api/v1`. Only the
  Connect protocol, the one the browser's client speaks: a POST's `Content-Type` must be
  `application/json` or `application/proto` (unary) or `application/connect+json` or
  `application/connect+proto` (streaming), parameters such as `charset` allowed; gRPC, gRPC-Web
  (which the backend also serves on that port) and anything else are 415 (`unimplemented`)
  before the backend is called. A GET needs none.
- **How much.** A body of at most 1 MiB, as for the JSON API: a declared larger one is 413
  (`resource_exhausted`) before the backend is called, an undeclared one is cut at 1 MiB with
  the same answer. Compressed requests (`Content-Encoding`, `Connect-Content-Encoding`,
  or GET `compression`) are refused with 415, so compression cannot bypass the decoded-size
  bound. Identity encoding remains allowed; response compression is unchanged.
- **How long.** A unary call (every GET, and a unary POST) is bounded by `BACKEND_TIMEOUT` (10s,
  at most 50s so that the 504 fits in the server's 60s write timeout), as an RPC from the BFF
  is: past it the relay answers 504 (`deadline_exceeded`). Every call, a stream included, waits
  at most `BACKEND_TIMEOUT` for the backend's headers (504 likewise). A stream whose headers came
  runs until it ends or the server's 60s write timeout cuts it, and reaches the browser as the
  backend flushes it; when the browser goes away, the backend's call is canceled. A backend that
  can't be reached, or whose certificate isn't trusted, is 502 (`unavailable`), with the detail
  in the BFF's log.
- **What comes back.** The backend's status and body as it sent them, and of its headers only
  `Content-Type`, `Content-Encoding`, `Content-Length`, `Accept-Encoding`, `Vary`,
  `Cache-Control`, `Date` and those starting with `Connect-`, `Grpc-` or `Trailer-` (a Connect
  unary call's trailers), plus the relay's own `X-Content-Type-Options: nosniff`. Anything else
  stays behind: a `Set-Cookie` for the console's origin, a CORS grant, a `WWW-Authenticate`
  challenge, a `Location` or `Refresh`, and the backend's say on the security headers. The BFF's
  gzip applies as to any answer: a unary JSON answer of 1 KiB or more is compressed, a stream
  isn't.
- **Where to.** The gRPC client's rules (`backend.Config.TLS`): plaintext to a loopback address
  (the pod's `127.0.0.1:9090`) or with `BACKEND_INSECURE=true`; HTTPS verified against
  `BACKEND_CA_FILE` (with `BACKEND_SERVER_NAME`) when it is set; no plaintext across the network
  otherwise.

kube-auth-proxy runs with `--api-route=^/ai_grid\.v1\.` (the chart, `manifests/base`), so a call
without a valid session on these paths is 401, not a redirect to the login page that `fetch`
can't follow; the frontend's transport (`frontend/src/api/connect/transport.ts`) then asks the
console to check its session, as a 401 from the Perses relay does. The Vite dev server proxies
the same paths to the BFF. Try it on the backend's own fakes with `make dev-fake-infra`
(`docs/dev-setup.md`): the console's own fake (`make dev-fake`) serves only the draft over gRPC,
so the relay answers 502 there.

```sh
curl -s -H 'x-forwarded-access-token: dev-token' -H 'x-forwarded-user: dev-user' \
  -H 'Content-Type: application/json' -d '{"limit":2}' \
  http://127.0.0.1:8080/ai_grid.v1.Clusters/List
```

### Waiting on backend RPCs

Each row is a request to the backend repository. The BFF mapping is small once the RPC
exists; the frontend uses the mock service meanwhile.

| Method | Path | Needs in the proto | Feature plan |
|---|---|---|---|
| GET | `/api/v1/user` (`isProviderAdmin`) | Optional: `AiGrid/GetCurrentUser` returning roles, once the backend acts as the caller; today the BFF asks the hub directly | Step 1 |
| GET/POST/PATCH/DELETE | `/api/v1/tenants[/{id}]` (on the backend's `Tenants` RPCs) | the draft `Tenant`'s `alias`, `enabled`, `description`, `attributes`, `domain_details` and `identity_provider`, if the console keeps them; `filter` evaluated on `List`; mutations gated on the provider-admin check | Step 6 |
| GET/POST/PATCH/DELETE | `/api/v1/models[/{namespace}/{name}]`, GET `/api/v1/capabilities` (implemented against the draft) | The backend has to ship the draft's `Models` service and `Model` message (`mock/proto/ai_grid/v1/model*.proto`) over LLMInferenceService, Placement and ManifestWorkReplicaSet with the status derived server-side (including proposal P13: each work's `phase`, `reason` and `message`, and `MODEL_PHASE_PARTIALLY_AVAILABLE`), and `AiGrid/GetHubCapabilities`; the `ManifestWorkReplicaSet` feature gate on the hub for multi-site models (`FailedPrecondition` otherwise) | Steps 3, 4 |
| GET/POST/PUT/DELETE | `/api/v1/catalog[/{name}]` | `Catalog/*` on ConfigMaps | Step 9 |
| GET | `/api/v1/grid/overview` (implemented against the draft) | The backend has to ship the draft's `Grid/GetOverview` (`grid_service.proto`) with the POC's metric contract (requests, errors, latency, gpu from Thanos with a `cluster` label) | Steps 8, 10 |
| GET/POST/DELETE | `/api/v1/tenants/{id}/members[/{userId}]` | Member RPCs on `Tenants` (not drafted yet; `mock/research/keycloak.md` open question 3) | Step 6 |
| GET | `/api/v1/grid` | `Grid/GetNetwork` from `grid.praxis.fast/v1alpha1` once the RHOAI AI Gateway component installs the CRDs | Step 10a |

## Errors

| Situation | Status |
|---|---|
| A path under `/api/v1` that no route has | 404, `the requested resource could not be found` |
| A known `/api/v1` path with a method it has no route for (`POST /locations`) | 405 with `Allow` (`GET, HEAD`; a GET route also answers HEAD) and the JSON error shape, `POST is not allowed on /api/v1/locations; use GET, HEAD`. It is checked after the identity and provider-admin checks, so a non-admin gets 403 |
| Missing or malformed token header | 401 |
| Hub rejects the token in the access review | 401 |
| Hub unreachable, failing or slower than 5 s during the access review | 502, `the hub could not confirm the caller's permissions; try again`, detail in the BFF log (a slow hub is not the backend's 504) |
| The access review says the caller is not a provider admin (may not patch ManagedClusters): every `/api/v1` request but `GET` (or `HEAD`) `/user` and `/config` (the provider-admin check, until the backend authorizes the caller) | 403, `this console is only for provider admins, users who may patch ManagedClusters on the hub, and the hub says you are not one` |
| Backend `Unauthenticated` | 401 |
| Backend `PermissionDenied` (the hub's RBAC denies the caller) | 403, backend message kept |
| Backend `NotFound` | 404, backend message kept (`object with identifier '<name>' not found`) |
| Invalid POST, PATCH or PUT body (unknown field, wrong type, trailing content), bad or repeated `offset`/`limit` query (`query parameter "offset" must be sent once`), a removed list parameter (`search`, `namespace`, `label`), malformed `If-Match` | 422, BFF message |
| POST, PATCH or PUT body not declared `application/json` | 415, BFF message |
| PATCH, PUT or DELETE without `If-Match`, or with `If-Match: *` | 428, BFF message |
| `filter`, `limit` or `offset` against a backend whose list answer has no `total` | 501, BFF message |
| Request body over 1 MiB | 413 |
| `/perses/api` without `PERSES_URL`, or a Perses path the relay does not pass | 404, BFF message |
| `/perses/api` with a method other than `GET` (or `POST` on a query path) | 405, `the console reads Perses only` |
| `/perses/api` query `POST` not declared `application/x-www-form-urlencoded` | 415, BFF message |
| Perses unreachable or its certificate untrusted; Perses slower than `PERSES_TIMEOUT` | 502, `the hub's Perses could not be reached; try again`; 504 |
| Any answer from Perses (its 401, 403 and 404 included) | Perses's status and body unchanged |
| `/ai_grid.v1.*` without a token, with one the hub rejects, from a caller who isn't a provider admin, or with the hub unreachable | 401, 401, 403, 502 as on `/api/v1`, as a Connect error (`unauthenticated`, `permission_denied`, `unavailable`) |
| `/ai_grid.v1.*` path that is not `/ai_grid.v1.<Service>/<Method>`; a method other than `POST` and `GET` | 404, 405 with `Allow: GET, POST`; Connect error `unimplemented` |
| `/ai_grid.v1.*` body over 1 MiB | 413, Connect error `resource_exhausted` |
| `/ai_grid.v1.*` POST that is not the Connect protocol (gRPC, gRPC-Web, any other `Content-Type`) | 415, Connect error `unimplemented` |
| `/ai_grid.v1.*` backend unreachable or untrusted; a unary call slower than `BACKEND_TIMEOUT`, or any call whose headers take longer | 502 `unavailable`; 504 `deadline_exceeded` |
| Any answer from the backend on `/ai_grid.v1.*` (its Connect errors included) | the backend's status and body unchanged, with only the headers a Connect client needs |
| Backend `InvalidArgument`, `OutOfRange`: Keycloak's validation messages ("Name can not be null", "Invalid domain format: x", "Cannot change the alias", "Domain x is already linked to organization y in realm ai-grid"), the API server's and the CRD's for a model (the DNS-1123 name message, the schema's "spec.replicas: Invalid value: -1: spec.replicas in body should be greater than or equal to 0" and "spec.scaling.maxReplicas: Required value", "replicas and scaling are mutually exclusive; ...", "at least one trigger is required when using direct KEDA scaling", "minReplicas cannot exceed maxReplicas"), and the backend's own checks with the console's proposed wording (URI scheme, Placement operators, rollout fields, `spec.rollout requires spec.placement`, the reserved tenant version attribute, an `ai-grid/latitude` or `ai-grid/longitude` annotation that is not a number in range, a list `filter` that does not compile, is not a bool or fails on an object) | 422, backend message kept; with `fieldErrors` for `InvalidArgument` only |
| Backend `AlreadyExists` (Keycloak: "A organization with the same name already exists.", also for a blank name on update), `Aborted` (the object is not at the `If-Match` version) | 409, backend message kept |
| Backend `FailedPrecondition` (hub feature gate missing, e.g. "ManifestWorkReplicaSet feature gate disabled on hub"; a model still referenced by a catalog entry or subscription; Keycloak realm missing or organizations disabled) | 412, backend message kept |
| Backend `ResourceExhausted` | 429 |
| Backend `Unimplemented` | 501 |
| Backend `Unavailable` (hub or Keycloak unreachable), `Canceled` | 503 |
| Backend `DeadlineExceeded` or BFF timeout (`BACKEND_TIMEOUT`, 10s) | 504 |
| Any other backend code | 502, generic message, detail in the BFF log |

## Out of scope for the BFF

- No Kubernetes client and no hub resources. The backend owns them. The one exception is
  the `SelfSubjectAccessReview` behind `isProviderAdmin`, which asks the hub about the
  caller with the caller's own token and reads nothing.
- No session handling. The proxy owns login and cookies.
- No billing data. Nothing in the platform stores it (confirmed 2026-10-14) and
  whether AI Grid gets a cost or spend view is an open product question. `billingUrl` in
  `/api/v1/config` is a plain external link that stays empty until a page exists.
- No metering. Praxis AI's `external_metering` filter emits CloudEvents to a metering
  service; nothing on the dev hub receives them yet.
- No OSAC integration in this round; the backend is the OSAC-like layer.
