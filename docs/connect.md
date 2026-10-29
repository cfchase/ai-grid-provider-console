# The backend's API in the console: types, calls and changes

The console is moving from its own draft proto and hand-written JSON to the backend's own API,
`ai_grid.v1` in ai-grid-cloud/ai-grid-provider-backend, called from the browser over Connect
with clients generated from that proto (ADRs 0001, 0002 and 0004). This page is the working guide:
how a call travels, where the types come from, how a page uses them, how to test, and what to do
when the API has to change. The backend's side of the same rules is its
`docs/API_CONTRACT.md`.

The Clusters area (the list, a cluster's page, Add and Remove), the AI Grid map and the
Subscriptions area are on it; the other areas move one at a time (Organizations, then Models);
each move deletes that area's draft RPCs, fake data,
BFF handlers and hand-written frontend types. When the last one moves, `mock/proto`, `bff/gen`, the
console's fake backend and `frontend/src/api`'s hand-written layer go.

## How a call travels

```text
page ── generated client ──► kube-auth-proxy ──► BFF relay ──► backend :9090 ──► hub
        POST /ai_grid.v1.Clusters/List      (login,      (identity,    (connect-go:
        Content-Type: application/json       401 on       gates; never  validation,
                                             --api-route) reads bodies) handlers)
```

- **The page** calls a method on a client generated from the backend's proto
  (`frontend/src/api/connect/clients.ts`) or a generated Connect Query descriptor. The request
  and the answer are typed from the same `.proto` files the backend's Go code is generated from.
- **kube-auth-proxy** signs the user in. For paths matching `--api-route=^/ai_grid\.v1\.` it
  answers an expired session with 401 instead of a login redirect, which a Connect client can't
  follow.
- **The BFF relay** (`bff/internal/relay`) checks the caller as `/api/v1` does (signed in, provider
  admin), drops every identity header the browser sent, sets the caller's token and identity the
  way the gRPC client does, and forwards the bytes unchanged. It accepts only the Connect protocol,
  bounds the wait, and passes back only the response headers a Connect client needs. It never
  decodes a body and has no per-RPC transport code. Until the backend authorizes callers,
  its procedure allowlist requires an explicit review before a new RPC is exposed. Rules and errors:
  `docs/plan/bff-api.md`, "The Connect relay".
- **The backend** decodes the request into the same generated message, runs its checks and
  answers. Its REST surface (vanguard, `/api/v1/...` on the backend's own port) is for other tools;
  the console never uses it.

## Where the types come from

- `.backend-api-version` holds one full commit SHA of the backend. The console is built against
  that commit's `proto/` (package `ai_grid.v1`; `ai_grid/draft` is excluded).
- `make generate-api` writes `frontend/src/gen` with protoc-gen-es v2 (a pinned devDependency,
  run locally by buf through `go run`), and Connect Query descriptors, plus
  `google/rpc/error_details.proto` for field errors.
- `frontend/src/gen` is committed and never edited by hand. `make check-generated-api` regenerates
  into a temporary directory and fails CI when anything differs: stale, hand-edited, missing or
  left-over files.
- Never write a TypeScript type that repeats a message the generated code already has. A page may
  have small display helpers (formatting a quantity, a label for an enum value); anything that
  decides what data means belongs in the backend (ADR-0002, and AGENTS.md "The BFF does transport
  only").

## Using it in a page

`App` wraps every page in `BackendProvider` (`frontend/src/api/connect/BackendProvider.tsx`): the
Connect transport to the console's origin, which calls the console's `checkSession` on
Unauthenticated, and a Query v5 `QueryClient`. A page needs no provider of its own; it calls the
generated Connect Query descriptors (`frontend/src/gen/ai_grid/v1/*_connectquery.ts`, one export
per RPC) with the hooks from `@connectrpc/connect-query`:

```tsx
import { createConnectQueryKey, useMutation, useQuery } from '@connectrpc/connect-query';
import { useQueryClient } from '@tanstack/react-query';
import { Clusters } from '../gen/ai_grid/v1/clusters_service_pb';
import { list, update } from '../gen/ai_grid/v1/clusters_service-Clusters_connectquery';
import { describeError } from '../api/connect/errors';

const queryClient = useQueryClient();
const clusters = useQuery(list, { limit: 50 }, { refetchInterval: 30_000 });
const save = useMutation(update, {
  // Refetch every Clusters query once the write lands.
  onSuccess: () =>
    queryClient.invalidateQueries({ queryKey: createConnectQueryKey({ schema: Clusters, cardinality: undefined }) }),
});

save.mutate({
  object: { id: c.id, metadata: { labels: next, version: c.metadata?.version } },
  updateMask: { paths: ['metadata.labels'] },
  lock: true, // the backend answers Aborted if someone changed it since c was read
});
// clusters.error and save.error are ConnectErrors: describeError(error) gives the page's state.
```

`frontend/src/api/connect/BackendProvider.test.tsx` runs this pattern against a fake. Outside a
component (a one-off call, a script), `createConsoleClients(createConsoleTransport({ checkSession }))`
gives plain typed clients.

- **Errors.** `describeError` and `toServiceError` (`errors.ts`) turn a `ConnectError` into the
  states the pages already show: NotFound, Aborted (a conflict: reload and say so),
  PermissionDenied, Unauthenticated (the session-ended flow; the transport also calls
  `checkSession`), Unimplemented (not available on this backend), and InvalidArgument with the
  field errors from `google.rpc.BadRequest`. Only request-related codes show the backend's own
  message; server-side failures show the console's generic text, as the BFF's `/api/v1` errors do.
- **Optimistic locking.** Send the version the page read, with `lock: true` where the request has
  it; a stale version answers Aborted. `Metadata.version` is `int32` at today's pin. ADR-0003
  proposes a string; use the shipped integer contract until a compatible migration is agreed.
- **Field masks.** An Update changes only the paths in `updateMask`; a map field (labels) is
  replaced whole, so send the whole map the page edited.
- **Enums.** A value the console's pin doesn't know arrives as the field's zero value
  (`..._UNSPECIFIED`). Give every `switch` over an enum a default branch that reads as "unknown";
  an exhaustive `switch` also makes `tsc` point at the code to update when a new value appears.
- **Unknown fields** in an answer from a newer backend are ignored, so the console keeps working
  until the pin moves.

### Query v5 and the Monitoring page

Query v5 is pinned for the console and Perses plugins in `pnpm-workspace.yaml`. Perses 0.54
still declares v4 support; `e2e/perses.spec.ts` verifies the actual renderer on v5. Keep that
regression passing when updating these dependencies.

### The Clusters area

- **Reads.** `useClusterList` and `useCluster` (`frontend/src/pages/clusters/useClusters.ts`) call
  `Clusters/List` and `Clusters/Get` with Connect Query, polling every 30 s as the other pages do,
  with no retries (the page offers Retry). `toClusterView` (`clusterView.ts`) is the thin selector
  layer ADR-0002 allows: the backend decides what a cluster is, and the page words it:
  `status.ai_grid_member` (membership), `status.state` and `state_message` (Ready, Offline, or
  Unknown with the ACM state behind it), `status.location` (site name, coordinates, where they
  come from, what is wrong with them, the cloud region), `provisioning` `Compliant` as
  Provisioned, the `location`, `ai-grid/site`, `ai-grid/role` and `openshiftVersion` labels, the
  claims `ManagedClusterStatus.cluster_claims` names, and `capacity["nvidia.com/gpu"]` as a number.
  The GPU sections read `status.gpus` as generated. The Models and Subscriptions pages take their
  site names from the same list.
- **Writes.** Add and Remove call `Clusters/Update` (in the relay's allowlist): the labels map as
  read with `ai-grid/enabled`, `ai-grid/role` and `location` set (or `ai-grid/enabled` dropped),
  `update_mask: metadata.labels`, `metadata.version` with `lock: true`. Aborted is the conflict
  the dialog already handles, and the answer's `ai_grid_member` confirms the change. The BFF has
  no `/api/v1/clusters` routes any more.
- **The map** (`pages/grid/AiGridPage.tsx`) shows the members among the same list, placed where
  `status.location` says; `Grid/GetOverview`, which the backend doesn't have, serves only the
  Monitoring fallback now. It links a member to the models whose placement chose it by cluster
  name (`placement.selectedClusters` of `GET /api/v1/models`), not by `locations`, the `location`
  labels that several clusters share.

- **Where a cluster is**, read-only (`pages/clusters/ClusterSite.tsx`, `site.ts`): the list's Site
  column and the cluster page show the site name, else the cloud region marked approximate, and
  a warning with the backend's `problem` when the annotations are wrong; the cluster page adds
  the region and the map position with how a hub admin sets it (the backend's README, "Cluster
  locations"). On the map, clusters at one position share a pin labelled "site name · cluster
  name" for each, and the list counts the members that aren't on the map, by why. "Region" is
  the cloud region only: the `ai-grid/region` label isn't read.

Still worded in the page, and backend asks if another client needs them: a provisioning enum
instead of the Policy's compliance string, and typed `openshift_version`, `console_url`,
`platform` and `product`.

### The Subscriptions area

- **Reads.** `useSubscriptionList`, `useSubscription`, `useModelList` and `useTenantList`
  (`frontend/src/pages/subscriptions/useSubscriptions.ts`) call `Subscriptions/List` and `Get`,
  `Models/List` (the model picker, the models' names and locations) and `Tenants/List` (the
  organization select and the organizations' names). The lists poll every 30 s; a
  subscription's page and its edit form load `Get` once, so the form keeps what it opened with.
  `subscriptionText.ts` is the selector layer: the display name and description are the
  `openshift.io/display-name` and `openshift.io/description` annotations, the organization is
  `spec.organization.id`, the status is `status.phase` (Active or Pending in git mode, none until
  a cluster reports, which reads Unknown) with its Ready condition's message in the tooltip, and
  a referenced model's status is its `model_registrations` entry (its phase; Saved to Git for one
  with no phase and a Ready condition of reason `SavedToGit`; Not found without an entry).
- **The model join.** A ref names its Model by `SubscriptionModelRef.model_id`, which the
  backend fills (with `display_name` and `description`) for a ref to a model in its catalog; a
  ref it can't join has no model and shows its name. A model the form adds is sent with the
  model's id as `name` and no `namespace`, as the field's comment says. The Models page's delete
  dialog lists the subscriptions that use a model with the CEL filter
  `this.spec.model_refs.exists(r, r.model_id == "<id>")`. The console needs no models namespace for
  this.
- **Writes.** Create sends `id`, the annotations, and the spec (bare owner groups, the
  organization, priority, model refs with their token limits); the backend creates the managed
  `<id>-policy` with it. Update sends the whole spec, with the fields the form doesn't edit
  (users, token metadata, inference priority, guardrails, a ref's billing rate and guardrails)
  as loaded, and the whole annotations map it loaded with the display name and description
  changed, because an Update replaces a map whole: mask `spec` and `metadata.annotations`,
  `metadata.version` with `lock: true`. Delete sends `resource_version` = the version read (zero
  would skip the check). Aborted is the conflict the form and the delete dialog already show.
- **Testing.** Page tests answer from `frontend/src/__tests__/connectSubscriptions.ts`, an
  in-memory Subscriptions service over the generated messages that answers as git mode does,
  with Models/List and Tenants/List over the test's `MockConsoleService`; the browser test
  (`e2e/subscriptions.spec.ts`) runs on the backend's fakes and commits a model of its own first.

### The Subscriptions area

- **Reads.** `useSubscriptionList`, `useSubscription`, `useModelList` and `useTenantList`
  (`frontend/src/pages/subscriptions/useSubscriptions.ts`) call `Subscriptions/List` and `Get`,
  `Models/List` (the model picker, the models' names and locations) and `Tenants/List` (the
  organization select and the organizations' names). The lists poll every 30 s; a
  subscription's page and its edit form load `Get` once, so the form keeps what it opened with.
  `subscriptionText.ts` is the selector layer: the display name and description are the
  `openshift.io/display-name` and `openshift.io/description` annotations, the organization is
  `spec.organization.id`, the status is `status.phase` (Active or Pending in git mode, none until
  a cluster reports, which reads Unknown) with its Ready condition's message in the tooltip, and
  a referenced model's status is its `model_registrations` entry (its phase; Saved to Git for one
  with no phase and a Ready condition of reason `SavedToGit`; Not found without an entry).
- **The model join.** A ref names its Model by `SubscriptionModelRef.model_id`, which the
  backend fills (with `display_name` and `description`) for a ref to a model in its catalog; a
  ref it can't join has no model and shows its name. A model the form adds is sent with the
  model's id as `name` and no `namespace`, as the field's comment says. The Models page's delete
  dialog lists the subscriptions that use a model with the CEL filter
  `this.spec.model_refs.exists(r, r.model_id == "<id>")`. The console needs no models namespace for
  this.
- **Writes.** Create sends `id`, the annotations, and the spec (bare owner groups, the
  organization, priority, model refs with their token limits); the backend creates the managed
  `<id>-policy` with it. Update sends the whole spec, with the fields the form doesn't edit
  (users, token metadata, inference priority, guardrails, a ref's billing rate and guardrails)
  as loaded, and the whole annotations map it loaded with the display name and description
  changed, because an Update replaces a map whole: mask `spec` and `metadata.annotations`,
  `metadata.version` with `lock: true`. Delete sends `resource_version` = the version read (zero
  would skip the check). Aborted is the conflict the form and the delete dialog already show.
- **Testing.** Page tests answer from `frontend/src/__tests__/connectSubscriptions.ts`, an
  in-memory Subscriptions service over the generated messages that answers as git mode does,
  with Models/List and Tenants/List over the test's `MockConsoleService`; the browser test
  (`e2e/subscriptions.spec.ts`) runs on the backend's fakes and commits a model of its own first.

### Perses on Query v5

Every `@perses-dev` package up to 0.55.0 declares `@tanstack/react-query` `^4.39.1` as its peer;
the `overrides` entry in `frontend/pnpm-workspace.yaml` gives it the console's v5 instead, so
there is one Query runtime in the app. Perses's built code uses the object syntax v5 requires,
but three v4 names it still uses mean something else, or nothing, in v5 ([TanStack's migration
guide](https://tanstack.com/query/v5/docs/framework/react/guides/migrating-to-v5)):

- **The query summary table counts no active queries.**
  `node_modules/@perses-dev/dashboards/dist/components/QuerySummaryTable/QuerySummaryTable.js`
  counts queries whose `state.status` is `'loading'`; v5 renamed that status `'pending'`, so the
  count is always 0.
- **A panel plugin that fails to load shows a different error.**
  `node_modules/@perses-dev/dashboards/dist/components/Panel/PanelPluginLoader.js` and
  `PanelContent.js` pass `useErrorBoundary: true` to `usePlugin`, which hands it to `useQuery`;
  v5 renamed the option `throwOnError` and ignores the old name. The plugin's own load error is
  no longer thrown: the plugin is just missing, and the panel's error boundary shows "Missing
  PanelComponent from panel plugin for kind '...'" instead. A query's error is unaffected:
  `PanelContent.js` throws it itself. (`@perses-dev/plugin-system`'s `MultiQueryEditor.js` passes
  the same option, in the panel editor, which the console doesn't open.)
- **A disabled query without data is not loading.** v4's `isLoading` was `status === 'loading'`,
  true for a query that was disabled before it had data; v5's is `isPending && isFetching`, false
  for it (v4's `isInitialLoading`). Perses code that shows a skeleton on `isLoading`, such as
  `PanelContent.js` while `usePlugin` waits for a plugin kind, renders on instead.

Each one only changes what a dashboard shows in those cases. The exit: drop the override when the
`@perses-dev` packages declare Query v5 (Perses has already moved its code to the v5-compatible
syntax, perses/perses#2139). If the integration regresses before then, the fallback is a second
Query runtime for Perses alone.

The console also renders navigations without React transitions (`frontend/src/router.ts`),
because React 18 can drop an update that lands mid-render, which left Perses's time-range menu's
invisible popover blocking the page. That goes with React 19 and Perses 0.56 or later: Perses
supports React 19 from perses/shared#390 and perses/plugins#889 (merged 2026-10-28, first in
0.56.0-beta.0).

## Testing

`fakeClients` (`testing.ts`) gives typed clients over an in-memory backend
(`createRouterTransport`):

```ts
const { clients } = fakeClients({
  clusters: {
    list: () => ({ items: [siteA], size: 1, total: 1 }), // checked against ClustersListResponse
    update: () => { throw new ConnectError('stale', Code.Aborted); },
  },
});
```

- A method left out answers Unimplemented, like an RPC the backend doesn't have.
- A component test wraps the page in
  `<BackendProvider transport={transport} checkSession={vi.fn()}>` with the `transport` that
  `fakeClients` returns; a test of the whole console renders `<App service={...} transport={transport} />`
  (`frontend/src/__tests__/backend-root.test.tsx`).
- Page tests render through `renderAt` or `TestApp` (`frontend/src/__tests__`), which give `App`
  a transport whose Clusters service answers from the test's `MockConsoleService`
  (`connectClusters.ts`, through `fakeClients`). A test that needs another backend passes its own
  transport (`fakeClients({}).transport` for one without the RPCs).
- The browser tests of the Clusters pages and the map (`e2e/cluster-membership.spec.ts`,
  `e2e/clusters.spec.ts`, `e2e/grid.spec.ts`) run against the backend's own fakes on its PoC
  fixtures, which `frontend/playwright.config.ts` starts through `hack/backend-fakes.sh`, on ports
  offset from the console's own fake, which the other specs use.
- The fake's answers are type-checked against the generated messages and go through the same
  serialization as the wire, so a fake can't drift from the API the way the hand-written
  `MockConsoleService` could.
- For the whole stack, `make dev-fake-infra` runs the backend at the pinned commit on its own fake
  hub and fake Keycloak (its `make dev-fake`, checked out into `.cache/backend/<sha>`, or
  `BACKEND_DIR`), with the BFF and the frontend in front of it. `make dev-fake` (the console's own
  fake, which serves the draft) stays until the last area moves.

## When the page needs something the API doesn't have

1. **Change the backend first.** Add the field or RPC to `proto/ai_grid/v1` in the backend, with
   its implementation, in a backend PR that follows the backend's `docs/API_CONTRACT.md`. Don't add
   it to `mock/proto`, and don't compute it in the page or the BFF.
2. **Move the pin** to a backend commit that has it (the PR's head while it's open, `main` once it
   merges): change `.backend-api-version`, run `make generate-api`, and commit both with the page
   change.
3. **Build the page** against the generated type; test it with `fakeClients` and try it with
   `make dev-fake-infra`.

## When the pin moves and something breaks

- **`tsc` fails:** the backend changed something a page uses. Fix the page in the same change as
  the pin bump; the pin doesn't move until it compiles and the tests pass.
- **A field is marked `@deprecated`:** the backend is retiring it (expand, migrate, contract). Move
  the page to the replacement now; the backend removes the field only after the console's pin no
  longer uses it.
- **The meaning changed but the type didn't:** no compiler can see this. The backend's contract
  rules say a changed meaning is a new field; if one slips through, raise it on the backend PR.

## Not built yet

- A nightly job that proposes moving the pin to the backend's newest `main` and runs typecheck and
  tests (the pattern OSAC uses for its UI).
- Connect GET: no backend method is marked free of side effects yet, so every call is a POST.
