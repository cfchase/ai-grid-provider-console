# Working in this repository

Rules for every coding agent (and person) changing this repository. There is no root
`CLAUDE.md`; this file applies to all agents. To build console pages against the fake backend,
read [mock/AGENTS.md](mock/AGENTS.md); for how every page looks and behaves (its loading, error,
empty and not-found states, lists, status labels and forms), read
[frontend/AGENTS.md](frontend/AGENTS.md).

## This architecture is being replaced

On 2026-10-19 we decided to consolidate the contract into the backend and move the console to
Connect end to end. The backend now serves Connect, with vanguard for REST; the console
migration is in progress. The rules below still apply to the legacy JSON API. Read the
decisions before designing anything new:

- [ADR-0001](docs/adr/0001-the-contract-lives-in-the-backend.md): the contract lives in
  `ai-grid-cloud/ai-grid-provider-backend`, reconciled to the OSAC service standards. The
  draft and fake were copied into the backend (`ai_grid.draft.v1`, `internal/fakeinfra/draft/`); their console copies are pending
  removal. The vendored upstream copy and drift guard remain, aimed at the real backend.
- [ADR-0002](docs/adr/0002-connect-end-to-end-with-vanguard-for-rest.md): the browser speaks
  Connect; the backend serves Connect, gRPC and gRPC-Web from one connect-go server, and vanguard
  only adds its REST routes, which the console and the BFF never use. The JSON envelope, the
  `ETag`/`If-Match` protocol and the hand-written TypeScript go away.
- [ADR-0003](docs/adr/0003-the-resource-version-stays-a-string.md): a proposed string version
  instead of the backend's shipped `int32`, because a Kubernetes `resourceVersion` is opaque.
- [ADR-0004](docs/adr/0004-the-bff-is-a-thin-relay.md): the target BFF relays backend calls, serves
  static assets, health and console config, and keeps the optional Perses relay. It is the
  seam OSAC's proxy layer later replaces.

Two things are worth knowing before you touch anything in `bff/internal/api` or
`frontend/src/api`: legacy shapes in this repository are declared four times (contract,
BFF structs, `frontend/src/api/types.ts`, UI types), with `toGridCluster` existing in both Go
and TypeScript; and the backend performs **no authentication or authorization at all** today,
so the token the BFF forwards is read by nothing (ADR-0004).

Use the vocabulary in [GLOSSARY.md](GLOSSARY.md). Three concepts have two or three names in
the code right now; the glossary says which one wins.

## The BFF does transport only

There is one provider console per ACM hub ("hub" always means the ACM hub), deployed by this
repository's Helm chart, for provider admins only: organization users never reach it, and their
UI is the MaaS consumer portal on each MaaS (ingress) cluster. The console is a React frontend, a thin
Go BFF (`bff/`) and `ai-grid-provider-backend`, the provider API in its own repository,
`ai-grid-cloud/ai-grid-provider-backend` (`docs/plan/bff-api.md`). The backend is meant to stand
on its own: a CLI, GitOps tooling and other UIs will call it without the BFF. So anything
that decides what data means, or what a request may do, belongs in the backend; if it lived in
the BFF, every other client would have to copy it. The draft proto also follows OSAC's
conventions (`mock/research/backend-conventions.md`): a List request carries only `offset`,
`limit`, `filter` (CEL) and `order`, and an Update replaces a map field as a whole (FieldMask
semantics, no `labels.<key>` paths). The client writes the CEL filter and edits the map it
loaded; the BFF forwards both unchanged; the backend evaluates the filter and applies the update
under optimistic locking.

What the BFF does:

- decodes request bodies strictly: exactly one JSON object, no unknown fields, at most 1 MiB;
- answers 415 for a POST, PATCH or PUT that is not `application/json`;
- requires `If-Match` on PATCH and DELETE (428 without it) and maps it to the request's version
  field (`resource_version`, with `lock: true` where the RPC has one);
- maps query parameters to the List request (`offset`, `limit`, `filter` as sent);
- maps gRPC codes to HTTP statuses, keeping the backend's message, and its own body errors to 422;
- forwards the caller's identity (the token as `authorization`, plus user, email and groups);
- serves the SPA, `/healthcheck`, `/readyz`, `/api/v1/config`, and asks the hub for
  `isProviderAdmin` (a `SelfSubjectAccessReview` with the caller's token);
- relays `/perses/api` to the hub's Perses with the caller's token, for the Monitoring page:
  only the read and query paths the Perses components call, nothing else of the caller's
  (`bff/internal/perses`). Perses authorizes and runs the queries;
- relays the browser's Connect calls to the backend's own RPCs (`/ai_grid.v1.<Service>/<Method>`,
  `bff/internal/relay`) behind the same caller checks as `/api/v1`: a reverse proxy that drops
  whatever the browser sent about who it is (`Authorization`, cookies, `Forwarded`, every
  `X-Forwarded-*`) and sets the caller exactly as `forwardIdentity` does for gRPC, passes only
  the Connect protocol (POST with a Connect content type, GET), refuses compressed requests,
  limits bodies to 1 MiB, bounds a unary call and every call's wait for headers by
  `BACKEND_TIMEOUT`, passes back only the response headers a Connect client needs, and never
  reads a body or compiles against the contract. A
  new RPC needs no transport implementation in the BFF. Until backend authorization lands,
  review it for the procedure allowlist (`docs/plan/bff-api.md`, "The Connect relay").

What belongs in the backend, and so in the fake (`bff/internal/fakebackend`) until the backend
ships it: validation of values, normalization and defaults, resource versions and the
precondition check, list filtering, ordering and counting, deciding whether an update changes
anything, which keys a caller may change, and every field derived from other fields. Every object
the backend returns carries a non-empty `resource_version`: with `If-Match` required, an object
without one could never be updated or deleted.

## Adding a feature

New API work goes to the backend's `ai_grid.v1`, following
[ADR-0001](docs/adr/0001-the-contract-lives-in-the-backend.md). Clusters, Organizations,
Models and Subscriptions already have real services. Models and Subscriptions use Git writes
and Argo CD delivery; their draft implementations have been removed from the backend.
[`docs/connect.md`](docs/connect.md) is the console integration guide:

1. Implement the contract in the backend with its infrastructure fakes and tests, following
   that repository's `docs/API_CONTRACT.md`.
2. Move `.backend-api-version` to a backend commit that has it and run `make generate-api`;
   commit `frontend/src/gen` with the change. Never edit generated files or repeat their types.
3. Build the page with `useQuery` and `useMutation` from `@connectrpc/connect-query` on the
   generated descriptors (`frontend/src/gen/ai_grid/v1/*_connectquery.ts`); `App` already
   provides the transport and the query cache (`BackendProvider`). Show errors with
   `describeError`, test with `fakeClients`' transport, and try `make dev-fake-infra`
   (`docs/connect.md`, "Using it in a page"). While backend authorization is pending, review any
   new procedure against the relay allowlist.

For maintenance of an existing legacy draft path, follow `mock/proto/README.md` and
[mock/AGENTS.md](mock/AGENTS.md). Retire those paths as their pages migrate.

Afterwards run `make -C bff golden` when the BFF's JSON or a fixture changed, and update the
docs (`docs/plan/bff-api.md`, `mock/AGENTS.md`, `mock/areas/*.md`) in the same change.

Don't name files, identifiers or tests after pull requests or issues; a comment describes the
behaviour and points at its source (a file, a function or an upstream commit), not a PR number.

## The backend's own API over Connect

The console is moving to the backend's RPCs, called from the browser over Connect (ADRs 0002
and 0004), through one provider at the app root. The Clusters pages, the AI Grid map and the
Subscriptions pages read and write through it (`docs/connect.md`, "The Clusters area" and "The
Subscriptions area"); the other areas still use `/api/v1`:

- `.backend-api-version` holds the backend commit (one full SHA) whose `proto/` (package
  `ai_grid.v1`, not `ai_grid/draft`) the frontend is generated from. `make generate-api` writes
  `frontend/src/gen` (committed; never edit it, `make check-generated-api` fails CI when it
  differs). To move to a newer backend, change the SHA and regenerate in the same change.
- `frontend/src/api/connect`: `createConsoleTransport` (Connect JSON to the console's origin; on
  Unauthenticated it calls the console's `checkSession`), `createConsoleClients` (typed clients
  per service), `BackendProvider` (the transport and a Query v5 cache for Connect Query, which
  `App` wraps around every page), `describeError` and
  `toServiceError` (a ConnectError as the UI states the pages already show), and `fakeClients`
  in `testing.ts` (typed in-memory fakes for tests).
- `make dev-fake-infra` runs the backend at that commit on its own fake hub and Keycloak (its
  `make dev-fake`, fetched into `.cache/backend/<sha>`, or `BACKEND_DIR`), the BFF against it
  and the frontend, so pages and the relay can be tried on the real backend without a cluster.
  `make dev-fake` (the console's own fake, serving the draft over gRPC only) is unchanged.

## The backend has no authentication yet

Authentication and authorization of API calls are out of the backend's MVP scope (decided
2026-10-20; ai-grid-cloud/ai-grid-provider-backend#3): it answers anyone who reaches it, as its
own ServiceAccount, which may label every ManagedCluster and, on the hub, read ACM Search's index
of every managed cluster. So in the console's pod:

- kube-auth-proxy is the only listener on the pod network (`:8443`), and the only port the
  Service and Route expose. The BFF and the backend bind to loopback (the backend's
  `--listen-address=127.0.0.1:9090` and `--http-listen-address=127.0.0.1:8081`), and every call
  reaches the backend through the BFF's caller checks (signed in, provider admin), on `/api/v1`
  and on the Connect relay alike.
- The BFF never validates a token: kube-auth-proxy signs provider admins in, and the BFF asks the
  hub whether the caller is one (`SelfSubjectAccessReview` with the caller's token), until the
  backend answers that itself (`GetCurrentUser`, planned). Organization users' tokens are
  validated at the gateway only (ODH MS-0007), and never reach the console.
- Don't add a Service port, Route, NetworkPolicy exception or `0.0.0.0` bind for the backend, and
  don't weaken the BFF's gates, until the backend authenticates callers itself (ADR-0004). The
  chart's kind test (`hack/test-chart-kind.sh`: only `:8443` listens off loopback) and
  ai-grid-env-setup's `verify/07-console.sh` (the backend's ports on loopback, the Service's one
  port) check this.
- Every container in the pod mounts the ServiceAccount token today. Limiting it to
  kube-auth-proxy and the backend was left out of the MVP; the planned end state is the backend
  calling the hub with the caller's own token, then in a pod of its own.

## Known exceptions, to move behind the RPCs later

The BFF still derives or decides these itself. Do not add more; move these into the backend
when the RPCs allow it.

> Under [ADR-0001](docs/adr/0001-the-contract-lives-in-the-backend.md) these do not move into
> the frontend — each one becomes a field in the contract or stays a backend derivation. A
> couple are resolved by the OSAC standard outright: it has first-class
> `metadata.display_name` and `metadata.description`, so `toModel` reading
> `openshift.io/display-name` goes away. `requireTotal` goes away with the shipped backend it
> exists to tolerate.

- The Connect relay allowlist (`allowedProcedures`, `bff/internal/relay/relay.go`): the relay
  passes only the reviewed procedures the console's API already offers, so every other procedure
  of the backend is 404 (`unimplemented`), a method the backend adds later included. The backend
  authorizes nothing itself, so without this list every one of its methods would be open to a
  provider admin. Left out on purpose: Clusters `Create` and `Delete`, which the console doesn't
  offer, and `Tenants/ListMembers`, because the console never lists an organization's members:
  one organization is one tenant, and the provider must not see a company's internals (decided
  2026-10-23). A new procedure needs a review and a line in the list. Remove the list once the
  backend authorizes every RPC itself.
- `toGridCluster` (`bff/internal/api/clusters.go`), for the clusters of the Monitoring
  fallback's `GET /api/v1/grid/overview` only: the Clusters pages, the map and the site names on
  the Models pages read `Clusters/List`, whose membership, state and location the backend
  derives (`docs/connect.md`, "The Clusters area"). It derives `aiGridEnabled` and `provisioned` (the
  `ai-grid/enabled` and `ai-grid/provisioned` labels equal to `"true"`; when the backend reports
  `status.provisioning`, `provisioned` is that equal to `"Compliant"` instead, until the backend
  serves a provisioned state), `location`, `site`,
  `region` and `openshiftVersion` from labels; `siteName`, `latitude` and `longitude` from the
  `ai-grid/site-name`, `ai-grid/latitude` and `ai-grid/longitude` annotations, with coordinates
  that do not parse or are out of range left out; `consoleUrl`, `platform` and `product` from
  cluster claims; `gpuCapacity` from `status.capacity["nvidia.com/gpu"]`; `addons` from the
  `feature.open-cluster-management.io/addon-*` labels; the list sorted by name.
- The stopgap clients for the backend's current `ai_grid.v1` (`bff/internal/backend/v1.go`),
  until the console moves to Connect and the backend's contract: the tenant writes refuse with
  `Unimplemented` the draft fields the backend's `Tenant` lacks. They accept those fields when
  they hold what a read shows (`description: ""`, `enabled: true`, `attributes: {}`), which may
  not be what Keycloak stores (`readBackValue`), and send a PATCH that sets only such fields as
  an update with the mask `id`.
- The stopgap Models client (`bff/internal/backend/v1_models.go`, `v1.go`), until Models moves
  to the Connect clients:
  - the models namespace: reads give the BFF's `--models-namespace`, and a model elsewhere is
    NotFound;
  - 501 for a model list with a filter or an order;
  - a model the backend reports as saved to Git (reason `SavedToGit`, no phase) keeps that
    reason, which the UI shows as Saved to Git;
  - a delete with `If-Match: "0"` is 412, because the backend treats version 0 as no check.
- `toTenant` (`bff/internal/api/tenants.go`), fallbacks for the shipped backend: `enabled`
  defaults to true, `domainDetails` is built from `domains`.
- `toModel` (`bff/internal/api/models.go`): `displayName` and `description` from the
  `openshift.io/display-name` and `openshift.io/description` annotations; `modelName` defaults to
  the model name; `placement.selectedClusters` from the decisions; `placement.satisfied`,
  `reason` and `message` from `PlacementSatisfied`; `rollout.rolledOut`, `applied` and `reason`
  from `PlacementRolledOut` and `ManifestworkApplied`; each work's `applied`, `available`,
  `progressing` and `degraded` from its conditions and `feedback` from the manifest feedback
  values; `rollout.strategy` shown as `All` when unset.
- `fromRolloutSpec`: parses the rollout strategy name into the enum and answers 422 for an
  unknown one; an empty strategy is sent as `ROLLOUT_STRATEGY_ALL`, a default the backend
  should apply to `ROLLOUT_STRATEGY_UNSPECIFIED`.
- `toGridOverview` (`bff/internal/api/grid.go`): drops metric points whose value is NaN or
  ±Inf (JSON cannot carry them), always sends `demo: false`, and writes `updatedAt` as
  `2006-01-02T15:04:05.000Z` (the PoC's millisecond format) whatever precision the backend
  sends.
- The model create (`createModel`): `cpu`, `memory` and `gpuCount` become the main container's
  requests (the GPU also its limit, a negative `gpuCount` is 422); `scaling` becomes a KEDA
  block; the gateway defaults to `openshift-ingress/openshift-ai-inference`; the managed route
  and the scheduler are always on.
- `requireTotal` (`bff/internal/api/respond.go`): a list answer without `total` comes from a
  backend that ignored `filter`, `offset` and `limit` (the shipped one), so the BFF answers 501
  when the caller sent any of them; without them `listMeta` falls back to a total it can prove.
  This is compatibility with the shipped backend, not filtering.
- `requireProviderAdmin` (`bff/internal/api/middleware.go`), the BFF's one authorization
  decision: every `/api/v1` call except `GET` (or `HEAD`) `/user` and `/config` needs the caller's
  `isProviderAdmin` review to pass (403 otherwise), until the backend authorizes the caller.

## Agent skills

Configuration for coding-agent workflows, in `docs/agents/` — not general documentation. Each
file answers a question a skill asks, in the form that skill expects, so changing one changes
agent behaviour. See [docs/agents/README.md](docs/agents/README.md).

`GLOSSARY.md` and `docs/adr/` are the exception: ordinary engineering documents, for people
first. Agents read them, and `docs/agents/domain.md` says how, but they are not written for
agents.

### Issue tracker

Issues live as GitHub issues in `ai-grid-cloud/ai-grid-provider-console`, driven through the
`gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its role name. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and one `docs/adr/` at the repo root. See
`docs/agents/domain.md`.
