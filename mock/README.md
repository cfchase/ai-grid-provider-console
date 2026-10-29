# Developing the console without the backend

This directory is the console's stand-in for everything that will one day come from
`ai-grid-backend` and the hub: fixtures for a fake gRPC backend, the research that says how
the real systems behave, and a plan per area for keeping the fake faithful. The fixtures are
fictional: every name, id, host and number in them is invented.

To build pages or clients against the fake, start at [AGENTS.md](AGENTS.md): it lists the
endpoints, the tokens, the seeded states, the timed scenarios and the errors you can provoke.
This file explains why the fake exists and how it grows.

## Why this exists

The frontend and the BFF live in this repository. The backend is written by another team
in another repository and lands RPC by RPC. If the console only worked against a real
backend on a real hub, every page would wait for its RPC, every developer would need a
cluster, and every demo would depend on a hub being healthy.

So the console runs against a fake. The point of the fake is not convenience; it is
**faithfulness**. When the real backend arrives, the BFF mapping and the UI must need only
small changes, because the fake already produced the same field names, the same condition
and reason strings, the same error codes and the same timing the hub produces. Anything
the fake invents is a future bug, so nothing in it is invented without a source: every
behaviour comes from a CRD on the dev hub, from upstream controller source, from vendor
documentation, from the POC, or from the backend's own conventions. The sources are in
`research/`.

## Principles

1. **The proto is the contract.** The BFF and the fake compile against one generated
   `ai_grid.v1` package (`bff/gen`), built from the console's draft proto in `proto/`. The
   draft began as a superset of the first backend's services. Against the real backend the
   BFF uses a copy of its Clusters and Tenants messages (`proto/ai_grid/backend/v1`), and
   `bff/internal/protodrift` fails if the backend's proto, vendored in `proto/upstream`,
   no longer matches that copy. `TestFakeImplementsEveryProtoMethod` calls every method of the
   draft over an in-memory connection and fails on any that answers `Unimplemented`, except
   the deliberate stubs listed with a reason in `intentionallyUnimplemented` (today
   `GetCurrentUser` and the `Grid` and `CatalogItems` services), so the fake
   can never silently fall behind the proto. It guards against stubs, not behaviour; the
   per-area tests cover behaviour. `proto/README.md` has the details.
2. **Mirror the real objects, not the POC's inventions.** ACM `ManagedCluster`, `Placement`,
   `ManifestWorkReplicaSet`, Keycloak Organizations, KServe `LLMInferenceService`, MaaS
   `MaaSModelRef`, `MaaSSubscription`, `MaaSAuthPolicy`, Kuadrant policies and the Praxis
   grid CRDs are the objects the console's pages stand for. Wherever the fake models one of
   them (today clusters, tenants and models), it carries their fields, phases, condition
   types and reason strings verbatim. Fields the POC invented (`revision`, `status: Saved`,
   `hasDeployment`) do not exist here.
3. **"Not implemented yet" is a normal state.** RPCs that are not agreed yet answer
   `Unimplemented`, exactly as the real server does for a stub. The BFF maps it to 501 and
   the UI shows "not available on this backend yet", so a page can ship before its RPC.
4. **Errors use the same codes the backend will use.** `NotFound`, `AlreadyExists`,
   `InvalidArgument` with the CRD's own validation message, `FailedPrecondition` when the
   hub lacks a feature gate or Keycloak lacks the realm, `Unavailable` when Keycloak is down,
   `Aborted` for a stale version, `PermissionDenied`, `Unauthenticated`, and `Unimplemented`
   for stubs. The BFF maps all of them to HTTP, so the UI's error paths are exercised against
   the fake, not discovered in production. The shipped backend still answers every Keycloak
   failure `Unknown` (`502`); the fake's `tenants.json` modes answer what the backend should,
   `Unavailable` (`503`) or `FailedPrecondition` (`412`).
5. **Time passes.** Objects do not appear Ready. They go through the same transitions the
   controllers drive, on a clock the fixtures control (`settings.json` `speed`): a cluster
   joins, imports and gains its add-ons in stages, a lost lease recovers, a cluster detaches
   and goes away (`scenarios.json`); a model walks KServe's conditions to `Ready` or stops at
   a failure, and a placed model rolls out site by site.
6. **No real data, ever.** Fixtures use `example.com`, invented UUIDs and fictional sites.
   Research notes quote field paths, string constants, versions and in-cluster object names
   from the real systems, never the dev hub's routes, cluster ids or people.

## How to run it

```sh
make install     # once: frontend dependencies
make dev-fake    # fake backend :9090 and hub :9091, BFF :8080, frontend :9000
```

```
browser → Vite :9000 → BFF :8080 → fake ai-grid-backend :9090 (gRPC)
                          └──────→ fake hub API :9091 (SelfSubjectAccessReview)
```

No `oc login`, no cluster. Open http://127.0.0.1:9000. You're signed in as `dev-user`, a provider
admin. To see the console as another kind of user, set `AUTH_TOKEN` to a token from
`fixtures/access.json`. The fake hub decides by token alone; `AUTH_USER` only changes the name in
the masthead:

| Command | You get |
|---|---|
| `make dev-fake` | A provider admin |
| `AUTH_TOKEN=viewer-token AUTH_USER=viewer make dev-fake` | A signed-in user who isn't a provider admin |
| `AUTH_TOKEN=expired-token AUTH_USER=expired make dev-fake` | A rejected token: `/api/v1/user` returns `401` |

The browser tests (`make e2e`) start the same fake on `fixtures-poc/` instead of `fixtures/`,
from `frontend/playwright.config.ts`: the PoC's four sites
(`site1` San Francisco, `site2` New York, `site3` Brussels and the unenrolled `site4` Sydney),
its three models and three organizations, with no scenario events, so
nothing changes over time. Organizations that a fixture lists without a version are loaded at
version "1" (the fake's fixture loader, `bff/internal/fakebackend`), so a stale save is refused on every seeded organization.
`fixtures-poc/README.md` lists the files. The browser tests run on
this preset.

To run the pieces separately, see `docs/dev-setup.md`, "Run the pieces separately".
`bff/cmd/fake-backend` reads `mock/fixtures` and serves:

- the `ai_grid.v1` gRPC services on `127.0.0.1:9090`, with health and reflection registered
  like the real server, a per-RPC latency that honours cancellation, and each call logged
  with its method, `x-forwarded-user`, whether a token was forwarded, and the result code;
- the one slice of the Kubernetes API the BFF itself calls, `SelfSubjectAccessReview`, on
  `127.0.0.1:9091`, answering allowed, denied or 401 by token as `fixtures/access.json` says.
  It returns `403` for every other path and does not look at the requested verb or resource,
  so every access check gets the same answer for a given token.

The fake's flags are `--fixtures`, `--listen-address`, `--hub-address` and `--log-level`; run
`go run ./cmd/fake-backend --help` in `bff/` for the full list. `bff/internal/fakebackend` is
the implementation; `bff/internal/backend/backendtest` is its in-memory sibling for Go tests.
Both grow together as RPCs are added.

## Fixtures (`fixtures/`)

`fixtures/README.md` describes every file and field. In short:

| File | Shape | What it seeds |
|---|---|---|
| `managedclusters.json` | `{"clusters": [ai_grid.v1.ManagedCluster...]}` in protojson | Full hub objects: the labels ACM writes, the console's `ai-grid/*` and `location` labels and `ai-grid/*` annotations, and a `status` with every condition. The hub's own `local-cluster` and at least one cluster in each state the ACM console distinguishes (ready, unknown, offline, importing, pending import, import failed, not accepted, detaching). |
| `tenants.json` | `{"tenants": [ai_grid.v1.Tenant...]}` in protojson, or one error mode | Six fictional Keycloak organizations. In place of `tenants`, `{"unavailable": "<text>"}` makes every tenant RPC that passes the token and permission checks `Unavailable` (Keycloak cannot be reached), `{"realmMissing": true}` makes it `FailedPrecondition` as on the dev hub, where the `ai-grid` realm does not exist, and `{"organizationsDisabled": true}` does the same for a realm without Organizations. |
| `models.json` | `{"models": [ai_grid.v1.Model...]}` in protojson, plus `bindings` | `LLMInferenceService` models, some placed on clusters, and the cluster sets bound into each model namespace. |
| `presets.json` | plain JSON | The installed `LLMInferenceServiceConfig` presets that a model's `baseRefs` resolve against. |
| `scenarios.json` | `{"events": [...]}` | Timed cluster transitions: an import in stages, a lease recovery, a detach. |
| `access.json` | plain JSON | Who the fake hub treats as a provider admin; `viewer-token` is denied and `expired-token` rejected. |
| `settings.json` | plain JSON | The per-RPC latency, the scenario clock's `speed`, and the hub capabilities `GetHubCapabilities` reports (the ManifestWorkReplicaSet gate, observability, ACM version). |

The cluster, tenant and model entries are protojson, so they use the field names grpcurl
shows and fail to load on any unknown field; a fixture that fails to load stops the fake with
an error. The file envelopes and the other files are plain JSON and ignore unknown keys, so
check their spelling: while `defaultAllowed` is true, a misspelled `deniedTokens` makes that
token a provider admin. A missing file leaves its part empty or at its default, except
`access.json`: without it every token is a provider admin. The directory itself must exist.
A test loads the shipped directory and checks the ACM labels are present. Fixture names,
labels and ids must never be real: this repository is public.

## What the research found, in one paragraph each

The full reports are in `research/`. Read them before changing a fixture or adding a
simulated behaviour; they cite the CRD path or source file for every string.

**ACM hub** (`research/acm.md`). A `ManagedCluster`'s health is five conditions with fixed
reason strings, written by three actors (the hub's registration controller, the spoke agent
and ACM's import controller); the ACM console derives
`pendingimport | importing | importfailed | ready | offline | unknown | detaching | notaccepted`
from them, and the fake derives the same state on every read. ACM auto-labels every imported
cluster; the hub adds `unreachable`/`unavailable` taints, which a Placement must tolerate to
keep such a cluster selected through an outage. Placements only see
cluster sets bound into their namespace, write `PlacementDecision`s named
`<placement>-decision-<n>` sorted by cluster name, and recompute within seconds when labels
change. `ManifestWorkReplicaSet` fans one `ManifestWork` per selected cluster with
`Applied`/`Available` and rule-driven `Progressing`/`Degraded` conditions and a summary. On
the dev hub the MWRS feature gate is off: the CRD accepts objects that nothing reconciles,
so the backend must detect that and answer `FailedPrecondition`.

**Keycloak tenants** (`research/keycloak.md`). The hub runs Keycloak 26.8 with Organizations
available but no `ai-grid` realm. The Organizations admin API lists by name with offset
paging (default page 10), returns 201 plus a `Location` header on create, replaces `name`,
`enabled`, `description` and `redirectUrl` on update but keeps the `attributes` and domains a
body omits, enforces unique `name`, `alias` and domains with exact 409 and 400 messages, and
needs `view-organizations` to return anything (`query-organizations` alone yields an empty
list). The backend today logs in as the master realm admin with a password
grant on every call and returns every failure as `Unknown`. The report proposes the
`Tenants` CRUD proto, the gRPC code for each Keycloak outcome, and the bootstrap steps for a
realm plus a scoped service-account client.

**Models, MaaS, Kuadrant, Praxis** (`research/models-maas.md`). Models are KServe
`LLMInferenceService` (v1alpha2) with Knative-style conditions; there is no phase, so
Pending/Ready/Failed is derived from `Ready`, and the reason strings on failure are known.
MaaS entitlement is a dual check: `MaaSAuthPolicy` grants access by group or user,
`MaaSSubscription` sets quota per model; a `MaaSModelRef` stays `Pending/NoPairingFound` until
both reference it, and the controller materialises one Kuadrant `TokenRateLimitPolicy` per model
(`maas-trlp-<model>`), shared by every subscription that lists the model. On the hub the
model MaaS serves is an `ExternalModel` pointing at the Praxis grid gateway, not a local
model. Praxis grid CRDs are documented but not installed; their phase machines are in the
report. API keys live in `maas-api`, not in a CRD. The POC stores CR-shaped JSON in Git and
does not use ConfigMaps for the catalog.

**Observability** (`research/observability.md`). The fleet Thanos behind ACM's
`rbac-query-proxy` is the right endpoint and labels every series with `cluster=<ManagedCluster
name>`. AI metrics reach it through RHOAI's OpenTelemetry collector at a 300 second cadence,
so rate windows must be 15 minutes or more. vLLM metrics with `model_name` are real and
fleet-visible today, but two scrape configs collect them, so every unfiltered collector
counter is doubled: every query on collector metrics must pin
`scrape_source="rhai-metrics-sourced"`. The gateway request, error and latency metrics the POC
assumed do not exist; Istio ones are wired but empty, and GPU utilisation arrives divided by
100. No metric carries a tenant label yet, so per-tenant usage is `unavailable` until a Kuadrant
`TelemetryPolicy` or the Praxis metering service exists. The POC's overview JSON and its
deterministic demo generator are transcribed so the fake can reproduce them sample for sample.

**Backend conventions** (`research/backend-conventions.md`). The backend is a single-file
proto with three RPCs, generated code committed by hand, no interceptors and errors returned
as plain Go errors. It says it is aligned with OSAC's fulfillment-service, whose conventions
are precise:
`List/Get/Create/Update/Delete`, offset and limit paging with `size` and `total`, CEL
filters, field masks with optimistic locking, `id/metadata/spec/status` objects, a shared
condition type, and a fixed gRPC error table. The report proposes a style guide that keeps
the shipped method names, drafts the next proto files in that style, and describes the
two-repository workflow: proto first with `Unimplemented` stubs, tag, console bumps, fake
implements, nightly drift build.

## Plan per area

Each area lists what the fake simulates, what the frontend builds against it, and what the
backend has to agree to. Areas 1 to 3 are implemented in the fake and the BFF;
`areas/<area>.md` is the reference for what each implements, where it deviates from the real
systems and what remains, and the UI for them is being ported separately. Areas 4 to 6 are
plans: their RPCs in the draft are stubs that answer `Unimplemented`.

### 1. Clusters (ACM ManagedCluster), implemented

Fake: `ManagedCluster` with annotations, conditions, claims, capacity, taints, finalizers and
a `status.state` derived on every read in the ACM console's order; seeded clusters in every
state the console distinguishes; `scenarios.json` drives join, import, add-ons, lease loss and
recovery, an API-server outage, detaching and removal; `UpdateManagedCluster` edits labels,
annotations and hub acceptance, then puts back the labels the hub owns. See
`areas/clusters.md`.
Frontend: cluster status badges from the derived state, console link from the claim, GPU
capacity, enrol and location editing. The map belongs to area 5.
Backend ask: `GetManagedCluster`, `UpdateManagedCluster` and the richer message as drafted in
`proto/ai_grid/v1/managed_cluster*.proto`, with the state derived server-side as in
`research/acm.md`.

### 2. Tenants (Keycloak Organizations), implemented

Fake: an in-memory organization store with UUID ids that answers like the backend's mapping of
Keycloak 26.8: Keycloak's checks in Keycloak's order with its messages (unique name, alias and
domains, alias defaulting to the name and immutable, domain format); without a field mask an
update replaces `name`, `enabled` (true when omitted) and `description` and keeps everything
else; case-insensitive search on name and domains, offset paging, delete; a version kept in an
organization attribute, checked on update and delete; and the `tenants.json` error modes for
an unreachable Keycloak (`Unavailable`) and a missing realm or Organizations feature
(`FailedPrecondition`). Members are not drafted yet. See `areas/tenants.md`.
Frontend: tenant list with search and paging, create and edit forms whose validation errors
are the ones Keycloak would send, delete with confirmation, and a members view once the member
RPCs exist.
Backend ask: the `Tenants` CRUD proto as drafted in `proto/ai_grid/v1/tenant*.proto`, keyed by
`id`; the gRPC code table in `research/keycloak.md` section 8.2 (today every failure is
`Unknown`); a scoped service-account client instead of the master admin.

### 3. Models (LLMInferenceService, Placement, ManifestWorkReplicaSet), implemented

Fake: `CreateModel` admits a model with the API server's and the CRD's own validation messages
and returns it with no conditions; the model then walks KServe's condition set to `Ready` on
timers, or stops at a failure: an unknown `baseRef` (`ConfigNotFound`), an image or model name
containing `oom` or `fail` (`MinimumReplicasUnavailable`), a Gateway that does not exist
(`RefsInvalid`). A placed model gets a Placement whose decision is recomputed from cluster
labels, taints and the cluster sets bound into its namespace, and a ManifestWorkReplicaSet
whose per-cluster works are applied all at once or progressively; a cluster labelled
`ai-grid-mock/fail-apply=true` (or one naming the model) fails to apply its work. Each work
carries its phase, and a model served on some clusters but not all is partially available
(proposal P13). `settings.json` reproduces the dev
hub's disabled ManifestWorkReplicaSet gate with `FailedPrecondition`. See `areas/models.md`.
Frontend: model list and detail with per-site status from the works, create wizard with the
POC's inputs mapped to the real spec, delete blocked while a subscription references the
model.
Backend ask: the `Models` service and `Model` message as drafted in
`proto/ai_grid/v1/model*.proto`, with the phase derived server-side;
`AiGrid/GetHubCapabilities` so the UI can explain a disabled gate; the ManifestWorkReplicaSet
feature gate on the hub.

### 4. Catalog and subscriptions (MaaSModelRef, MaaSSubscription, MaaSAuthPolicy)

Removed from the fake: the Subscriptions pages call the backend's own `ai_grid.v1.Subscriptions`
over Connect (`docs/connect.md`, "The Subscriptions area"), and the backend's fakes serve them
(`make dev-fake-infra`). What follows is the plan as the fake implemented it, for the record.

Fake: a catalog entry starts `Pending/NoPairingFound` and becomes `Ready` once a
subscription and an auth policy reference it (in any phase; the pairing check ignores
`status.phase`) and its model is ready, turns `Unhealthy` when its model fails; a
subscription validates the CRD rules (`tokenRateLimits` or `unlimited`, window regex, limit
range), has no phase until its first reconcile, is `Degraded`
(`Ready=False/PartialFailure`) while the `TokenRateLimitPolicy` of any of its models isn't
accepted, flips to `Active` once they all are, and optionally creates its `<name>-policy` auth
policy with the same description annotation the hub uses. Whether the console creates the auth
policy together with the subscription or leaves it to be managed separately is a product
decision the research does not settle, so the fake should make the pairing a mode switch.

The port implements this area from the research (`research/models-maas.md` 3.4 to 3.6, 8.1
and 8.2), not from the PoC, whose `Saved` phase does not exist on the hub. What the fake does:

- **Subscription lifecycle.** No phase is stored; it is derived on every read from the
  scenario clock (`speed` in `settings.json` scales it). The controller never writes a
  `Pending` phase: `status.phase` has no default, so a new subscription has none until its
  first reconcile, which maas-api treats as unreconciled. After that it is `Degraded`
  (`Ready=False`, `PartialFailure`, "1 of 1 TokenRateLimitPolicies not accepted"; the count
  is the number of model references) only while its generated `TokenRateLimitPolicy` is not
  `Accepted`, and then `Active`. Nothing checks that the policy is enforced, so an accepted
  policy reads `Active`. The console shows `Active` as "Ready", as odh-dashboard does. A subscription whose models are all
  missing is `Failed`, and one with some missing is `Degraded` with "N of M model references
  are invalid or unavailable" (each missing one `NotFound`, "MaaSModelRef <ns>/<name> not
  found"). Every reference has a `TokenRateLimitPolicy` status, as `checkTokenRateLimitHealth`
  reports it: an unlimited one too (its policy carries the shared unlimited limit), and a
  missing model's is `BackendNotReady`. One timer runs from create; an update does not restart
  it. An update replaces the subscription: a field sent empty is cleared, and an update that
  changes nothing keeps the version. A fixture
  subscription without `createTime` plays the same lifecycle from the fake's start, and one
  with a past `createTime` reads as settled. The fake never derives `Invalid`, and it models
  only the `Ready` condition.
- **Auth policies and registrations.** A managed policy (`<name>-policy`) goes `Pending`, then
  `Active`; a policy whose models are all missing is `Failed`, and one with some missing is
  `Degraded` ("N of M model references are missing"). Every model counts as registered through
  a `MaaSModelRef` of the same name, whose status is returned with a subscription: `Pending`
  until a subscription and an auth policy both name it, `Ready` when its model is ready and
  `Unhealthy` when the model has failed (`Ready=False/BackendNotReady` in both, and
  `RuntimeReady=False/RuntimeHealthFailure` while the model isn't ready).
- **CRD messages, unverified.** The token rate limit rules (the window pattern
  `^[1-9]\d{0,3}(s|m|h)$`, so `1d` is refused, and the limit range) use the wording of the
  Kubernetes schema validator, because the research gives none. The two CEL messages
  ("tokenRateLimits is required unless unlimited is true" and "tokenRateLimits must not be set
  when unlimited is true") are the CRD's. **The window and limit messages are unverified
  against a hub**: check them with a server-side dry run once one is at hand.
- **Models are undeletable while referenced.** `DeleteModel` is `FailedPrecondition` while a
  subscription or an auth policy references the model, including the fixtures' unmanaged
  policies, which are never deleted with a subscription. The message names each referrer, for
  example "auth policy engineering-policy, subscription engineering". A policy's bare model
  names, and a reference without a namespace, count as the console's models namespace.

Frontend: subscriptions table keyed on phase, create and edit with per-model quotas,
tenant linkage through `tokenMetadata.organizationId`, a visible consistency check between a
subscription's owners and the auth policies that cover its models.
Backend ask: the `Catalog` and `Subscriptions` services in `research/models-maas.md`
section 8.1, and a decision on the subscription and auth policy pairing.

### 5. Grid overview and monitoring (Thanos)

Fake: the POC's `GetOverview` contract with the four metric series, per-metric status
(`ok`, `no-data`, `unavailable`, `not-configured`), the deterministic demo generator ported
verbatim so browser mock and fake agree, 300 second sample cadence when emulating the fleet,
clusters that are not Ready emitting nothing, and a fake Thanos HTTP server that reproduces
the observed error cases (JSON `bad_data`, plain-text resolution error, 302 on a bad token,
warnings, more than one series), with every series both labelled
`scrape_source="rhai-metrics-sourced"` and as an unlabelled twin, so the queries' filter is
exercised. Per-model usage from the vLLM metric names that exist;
per-tenant usage `unavailable` until the platform has a tenant label.
Frontend: map and monitoring pages with a simulation banner driven by `metricsSource`, charts
that show gaps rather than zeros.
Backend ask: the `Grid` RPCs and PromQL in `research/observability.md`, the fleet endpoint
and credential choice, and the two gateway and tenant-label questions listed there.

### 6. Grid network (Praxis CRDs)

Fake: default to "CRDs not installed" with the `AIGateway` condition the hub shows; a flag
flips to a network with one local site stuck `Pending/AwaitingDiscovery`, remote sites
cycling through the documented phases, and one `InferenceProvider` per Ready model with the
values the ODH bridge writes.
Frontend: a grid topology view that renders the not-installed state as information.
Backend ask: `Grid/GetNetwork` once the CRDs ship through the AI Gateway component.

## Working in parallel with the backend team

`proto/README.md` has the full steps; in short:

1. **Proto first.** A new RPC starts in the console's draft (`proto/ai_grid/v1`) and is
   proposed to the backend as a PR that touches only its `proto/` and `gen/`; the embedded
   `Unimplemented*Server` makes it compile and answer `Unimplemented`. Both teams review the
   shape.
2. **Console syncs and the fake follows.** `hack/sync-upstream-proto.sh` refreshes the vendored
   copy, the shipped shape is compared with the draft and the draft is reconciled, the fake implements the new methods (or lists them as intentional stubs) with
   the behaviour from the research, the BFF handler lands, the page switches from mock to real
   types. Each step is a small PR.
3. **Stubs are fine in production.** A deployed console in front of a backend that lacks an
   RPC shows "not available yet" on that page and works everywhere else.
4. **Drift is caught nightly.** `.github/workflows/drift.yaml` syncs the vendored copy from the
   backend's `main` every night and runs the drift test, so a change to a message or RPC the
   BFF uses shows up within a day of its merge.
5. **The research is the shared source.** When the backend team implements an area, the
   report for that area is the specification both sides test against; disagreements go into
   the report's open questions and are resolved there before code.

## Open questions that affect the mock

- Subscription and auth policy: created together by the provider console (the POC's
  `<name>-policy` convention), or managed separately? The UI differs; the fake should
  support both.
- Which Keycloak realm holds tenants: a new `ai-grid` realm, or the organization-enabled
  realm the hub already imports?
- Will the backend act as the caller on the hub (so hub RBAC decides) or validate tokens
  and apply its own policy? This decides what `GetCurrentUser.is_provider_admin` means.
- Method naming: keep `ListManagedClusters` or move to OSAC's bare `List` while the console
  is the only consumer?
- Field masks on maps: whole-map replacement or per-key paths for a single label toggle?
- Which gateway carries AI Grid traffic, and who adds the tenant label to metrics?
- Can the MWRS feature gate be enabled on an MCE-owned `ClusterManager` without being
  reverted?

The other lists, with context, are at the end of each report in `research/`; the
subscription question is the console's own.
