# The draft proto

The BFF and the fake backend compile against the console's draft of the next `ai_grid.v1`
proto, kept here until the backend ships it. This page says what the draft is, what keeps it
honest against the backend's real proto, which methods the fake deliberately leaves
unimplemented, and how a change moves between the two teams. The style it follows and the
shapes it starts from are in `mock/research/backend-conventions.md` sections 5 and 6
(background reading).

## What it is

The first backend's proto had three RPCs. The console needs more than that, so it carries a
**draft** of the next proto in `mock/proto/ai_grid/v1/`, split by type as the style guide in
`mock/research/backend-conventions.md` section 5 says (`ai_grid.proto`, `condition_type.proto`,
`metadata_type.proto`, `managed_cluster_type.proto`, `managed_clusters_service.proto`,
`tenant_type.proto`, `tenants_service.proto`, `model_type.proto`, `models_service.proto`, and
`grid_service.proto`, whose `Grid/GetNetwork` and the whole of `catalog_items_service.proto` are
still placeholders; the draft's subscriptions are gone, because the Subscriptions pages call the
backend's own `ai_grid.v1.Subscriptions` over Connect). It is the
console's **proposal** to the backend team, nothing more: the shapes are the ones drafted in
section 6 of that report, every file says so in its header, and the `go_package` is the
console's own (`bff/gen/ai_grid/v1`), not the backend's.

What keeps it honest:

- **It started from the first backend's services.** `AiGrid/Ping`,
  `ManagedClusters/ListManagedClusters` and `Tenants/ListTenants` came from that backend
  unchanged; new fields and methods were only appended. The backend is now
  ai-grid-cloud/ai-grid-provider-backend, whose `ai_grid.v1` follows OSAC's shapes
  (`Clusters/List`, `id + metadata + spec + status`) instead, so the draft is the fake
  backend's contract, not a superset of the real one.
- **The real backend's proto is vendored.** `mock/proto/upstream/ai_grid/v1/*.proto` are the
  backend's `proto/ai_grid/v1` at the commit in `mock/proto/upstream/COMMIT`, and
  `mock/proto/upstream/image.binpb` is those files compiled with their imports by `buf build`.
  `hack/sync-upstream-proto.sh <ref>` refreshes all three.
- **A test guards the BFF's copy.** Against the real backend the BFF calls `Clusters`,
  `Tenants` and `Models` with a copy of their messages, `mock/proto/ai_grid/backend/v1`.
  `bff/internal/protodrift` loads the vendored image and checks that every copied message,
  field (same number, name, cardinality, presence, oneof and type) and enum value is still
  the backend's, and that the RPCs the BFF calls still take and return those messages.
  The day the backend changes one of them, the sync script plus this test name every
  difference. `TestFakeImplementsEveryProtoMethod` in
  `bff/internal/fakebackend` then calls every method of every draft service and fails on an
  `Unimplemented` answer, except for the methods listed in `intentionallyUnimplemented`
  (`fakebackend_test.go`), each with its reason: the placeholder `Grid/GetNetwork` and
  `CatalogItems` methods until they are agreed with the backend team, and `GetCurrentUser`,
  which the BFF does not need yet (`Models` and `GetHubCapabilities` are implemented and
  probed like every other method). An entry whose
  method starts answering fails the test until the entry is removed, so the allowlist is
  always exactly the set of stubs.
- **The allowlist refines `mock/README.md`.** That page says the test fails on any
  `Unimplemented` answer, which held while the fake was built from the backend's three-RPC
  proto. The draft adds services the backend has not agreed yet, so the test now fails on
  any `Unimplemented` answer except from a method in `intentionallyUnimplemented`.
- **Generated code is committed and checked.** `bff/gen/ai_grid/v1` is produced by
  `make -C bff generate` (`buf generate` with `protoc-gen-go` and `protoc-gen-go-grpc` at
  pinned versions, all run through `go run`, so nothing is installed). Both `generate` and
  `check-generated` run under `GOTOOLCHAIN` set to the `bff/go.mod` version, the one CI's
  `setup-go` installs: protoc-gen-go formats its output with the `go/printer` of the Go that
  builds it, and Go 1.26 rewrites an indented line in a message field's comment into a code
  block where 1.27 does not, so a generation with another local Go could differ from CI's.
  (The draft keeps indented lines out of field comments for that reason; the indented blocks
  in the `ModelPhase` and `ManagedClusterState` enum comments generate the same under both.) `make -C bff lint-proto`
  runs `buf lint` (STANDARD minus `SERVICE_SUFFIX`); `make -C bff check-generated` generates
  into a temporary directory and `diff -r`s it against `gen/`, so CI fails on a stale file,
  on a missing one and on one the proto no longer produces, not only on uncommitted edits.

When the backend ships an RPC from the draft, the console bumps the vendored copy, the drift
test confirms the shapes agree (or shows exactly where they do not), and the BFF keeps
working against the real server because the wire format is the same. When the backend has
shipped all of it, the console switches its import from `bff/gen/ai_grid/v1` back to the
backend's generated package, deletes `mock/proto/` and `bff/gen`, and the fake stays as it is.

The Clusters area added, additively, what `mock/research/acm.md`'s richer `ManagedCluster`
proposal needs and the fake now simulates: `taints` (with `time_added`), `generation`,
`finalizers`, `status.state_message`, and the finer `ManagedClusterState` values
(`PENDING_IMPORT`, `IMPORTING`, `IMPORT_FAILED`, `NOT_ACCEPTED`, `UNKNOWN`) with the ACM
console's derivation order documented on the enum. The flattened claim fields and the
`addon_status` map from that proposal were not added: the BFF derives them from
`cluster_claims` and the `feature.open-cluster-management.io/addon-*` labels, which the proto
already carries verbatim.

The Models area filled the placeholder `Models` service (`model_type.proto`,
`models_service.proto`) with `Model { name, metadata, spec, status }`: the spec is the subset
of a KServe `LLMInferenceService` the console writes (`model.uri/name`, `replicas` or
`scaling`, `base_refs`, `runtime`, `router` with gateway refs, a managed route and the
scheduler, the `main` container) plus an ACM `Placement` (one predicate: label selector, claim
expressions, tolerations, `number_of_clusters`, spread constraints) and a `Rollout`
(`All|Progressive|ProgressivePerGroup` with `max_concurrency`, `max_failures`,
`progress_deadline`, `min_success_time`); the status is the LLMInferenceService status of the
hub deployment (`url`, `addresses`, Knative conditions, `applied_configs`, `workloads`,
`observed_generation`), a derived `phase` with its reason and message, and for a placed model
the Placement decisions and conditions plus the ManifestWorkReplicaSet summary, conditions and
one `ManifestWorkStatus` per generated work (conditions, manifests with their conditions and
feedback, generations). The research's `Placements` and `ManifestWorkReplicaSets` services
were not drafted as separate services: the console only ever needs them through a model, so
the `Models` service wraps one Placement and one MWRS per model (`mock/research/acm.md`,
"Proposal"). `AiGrid` gained `GetHubCapabilities` (`manifest_work_replica_set_enabled`,
`observability_installed`, `acm_version`).

The Tenants area first removed two drafted fields: `Tenant.version` (field 8) and
`UpdateTenantRequest.lock` (field 3) are `reserved`, because Keycloak Organizations have no
server-side version, etag or `Last-Modified` (`mock/research/keycloak.md` 8.1). The review of
the fake server PR brought a version back under a new name and number, kept by the backend
itself in an organization attribute (`mock/areas/tenants.md`, "Version"):
`Tenant.resource_version = 10`, checked when `UpdateTenantRequest.object.resource_version` or
the new `DeleteTenantRequest.resource_version = 2` is set (no flag; `lock` stays reserved), and
`Aborted` when stale. `DeleteModelRequest` gained the same precondition (`resource_version =
3`, a Kubernetes delete precondition), and `ListTenantsResponse.total` and
`ListModelsResponse.total` became `optional`, so a backend that ignores paging and filters
(the shipped one) is visible by the missing count. The Tenants area also added `TenantDomain` and
`repeated TenantDomain domain_details = 9` (`name`, `verified`, `identity_provider_alias`,
`auto_redirect`, the fields Keycloak 26.8 keeps per domain), and kept `domains` as the list of
names. `ListTenantsRequest.filter` was first narrowed to the one CEL form that pushes down to
Keycloak's `search`; it is general CEL again, as is `ListModelsRequest.filter`: an expression
over `this` (the message, proto field names) and `now` in cel-go's standard library plus its
strings extension (`ext.Strings()`), which the client writes, the BFF forwards and the backend
evaluates before paging (the fake in memory, `bff/internal/fakebackend/celfilter`).

## Proposals from the port

The PoC port added the shapes below to the draft. **Each is a proposal for the backend owners**,
implemented in the fake so the console works today and not agreed with anyone: the owners settle
each one, field number included, when the backend work on that area starts. A field's header
comment in the draft says the same. Proposals the port first made and the fake later covered
(the tenant version, the delete preconditions) are the fake's and are described above.

| Id | Proposal | What the fake implements |
|---|---|---|
| P1 | `Tenant.identity_provider = 11`, with the port's `IdentityProvider` and `OidcConfig` messages | Validates the provider with the PoC's rules on create and on an update whose mask names `identity_provider` (`BadRequest` violations under `identityProvider.*`), trims and stores it. An organization without one is accepted. The check runs after the version check, so a stale update is `Aborted` whatever else is wrong |
| P3 | `Tenant.create_time = 12`, output only | Stamps the time at create and keeps it out of `attributes`, as the backend would in the attribute `ai-grid/create-time`; an organization created some other way has none, and the console shows "—" |
| P6 | `ModelSubscriptionRef.namespace = 8` | The namespace of the referenced model; empty means the console's models namespace (`ai-grid-models`). Pairing with auth policies, status and the delete guard all use namespace and name |
| P7 | `Models.ListLocations`, `ListLocationsResponse.locations = 1` | The names of the clusters that are AI Grid members (`ai-grid/enabled` and `ai-grid/provisioned` both `true`) with `ai-grid/role` inference or combined and Available, sorted: what the backend's `Models/ListPlacementClusters` answers (`internal/servers/models_server.go`), the values of a placement's `name In [...]` |
| P8 | So far `PlacementStatus.locations = 4` | The `location` labels of the decided clusters, unique and sorted; a decided cluster without the label adds nothing |
| P11 | The bodies of `subscriptions_service.proto` and `Grid/GetOverview`, which filled the placeholders | Subscriptions: create, read, update and delete with the CRD's rules and `BadRequest` field violations, `If-Match` as `resource_version` (set means checked, `Aborted` when stale). The overview: the PoC's metric contract with a deterministic demo generator, `range` limited to `1h`, `6h` and `24h`, a metric status per series, and the cluster inventory read from the fake's cluster state |
| P13 | `ModelPhase.MODEL_PHASE_PARTIALLY_AVAILABLE = 4`, and `ManifestWorkStatus.phase = 7`, `reason = 8` and `message = 9`, output only | Each work's phase on its cluster: READY when the spoke's `ready` feedback is True; FAILED when `Applied` is False or `Degraded` is True, with that condition's reason and message, Applied first; otherwise PENDING, with no reason before the agent reports, else `Available`'s reason and message while it is not True, else `Progressing`'s. A placed model with some works READY and others not reads PARTIALLY_AVAILABLE, reason `PartiallyAvailable`, message "<n> of <m> clusters are serving the model.", after READY and before FAILED. The console's Models page lists each cluster's phase under the model (the UX team's "models per cluster" design) |
| P12 | The MaaS status the research implies (`mock/research/models-maas.md` 8.1). `Subscription.phase = 10` is `Active`, `Degraded`, `Failed` or `Invalid`, and empty until the first reconcile (the controller never writes `Pending`), fields 11 and 12 are `reserved`, and `conditions = 16`, `model_ref_statuses = 17` and `token_rate_limit_statuses = 18` are new. `AuthPolicy` gains `conditions = 7` and `model_refs = 8` (`AuthPolicyModelRef {name, namespace}`, replacing the reserved bare names in 5). New messages `ResourceRefStatus`, `TokenRateLimitStatus` and `ModelRegistration`, and `GetSubscriptionResponse.model_registrations = 4`. All output only | The controller's phases, conditions, reasons and messages, word for word, derived on every read; the timing is in `mock/README.md`, area 4. A model ref with a namespace pairs with a policy that names the same namespace |

P2, P4 and P5 were dropped: the fake covers them (`Tenant.resource_version`,
`DeleteTenantRequest.resource_version` and `DeleteModelRequest.resource_version`). P10 (map-key
field masks) was dropped: the fake settled on whole maps. P9 (cluster `grid` fields) and the rest
of P8 are not in the draft yet.

## Working with the backend team

1. **Proto first.** A new RPC starts in the console's draft (`mock/proto/ai_grid/v1`), proposed
   to the backend as a PR that touches only its `proto/` and `gen/`; the embedded
   `Unimplemented*Server` makes it compile and answer `Unimplemented`. Both teams review the
   shape. On merge the backend tags a version.
2. **Console syncs and the fake follows.** The console runs `hack/sync-upstream-proto.sh`,
   the shipped shape is compared with the draft and the draft is reconciled, the fake gains the behaviour from the research, the BFF handler lands, the
   page switches from mock to real types. Each step is a small PR.
3. **Stubs are fine in production.** A deployed console in front of a backend that lacks an
   RPC shows "not available yet" on that page and works everywhere else.
4. **Drift is caught nightly.** `.github/workflows/drift.yaml` runs every night (and on
   demand) on a throwaway checkout: `hack/sync-upstream-proto.sh main`, then the drift test.
   Nothing is committed; a red run means the backend changed a message or RPC the BFF uses,
   and the fix is to run the sync locally, update the BFF's copy and commit both. CI on pull
   requests tests the copy against the vendored proto only, so a backend change that lands
   between syncs shows up in the nightly run, not in the pull request.
5. **The research is the shared source.** When the backend team implements an area, the
   report for that area is the specification both sides test against; disagreements go into
   the report's open questions and are resolved there before code.
