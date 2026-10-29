# ai-grid-provider-console

AI Grid cloud provider admin console: a React and PatternFly frontend with a thin Go BFF,
running on an ACM hub next to `ai-grid-backend`. Provider admins use it to see and enrol
clusters, deploy models across sites, manage subscriptions and tenants, and watch the fleet.

```
browser --JSON--> kube-auth-proxy + bff --gRPC--> ai-grid-backend --> hub API, Keycloak, metrics
```

The BFF owns login, the browser API and the static frontend. Every call to the cluster
goes through [ai-grid-provider-backend](https://github.com/ai-grid-cloud/ai-grid-provider-backend), which runs in
the same pod. The BFF forwards who is calling, and asks the hub one question itself with
the caller's own token: may this user patch ManagedClusters? That answer is `isProviderAdmin`.

## Layout

| Path | What |
|---|---|
| `bff/` | Go backend-for-frontend: `/api/v1/*` as JSON over the backend's gRPC, plus the built frontend |
| `bff/internal/relay` | The relay of the browser's Connect calls (`/ai_grid.v1.*`) to the backend's own RPCs, with the caller's identity |
| `frontend/` | Vite, React 18, PatternFly 6 |
| `frontend/src/gen`, `.backend-api-version` | TypeScript generated from the backend's proto (`ai_grid.v1`) at the commit in `.backend-api-version` (`make generate-api`; never edited by hand); `frontend/src/api/connect` has its transport and clients |
| `charts/ai-grid-provider-console/` | Helm chart: kube-auth-proxy, bff and ai-grid-backend in one pod, one per ACM hub |
| `manifests/` | The same pod as kustomize. Not an install path: the chart is (ai-grid-env-setup deploys it, and so does `make deploy`). `manifests/base` is kept for `hack/undeploy.sh`'s fallback, which removes a console deployed before the chart, and for the takeover test in `make chart-test`; `make chart-check` keeps it equal to the chart's defaults |
| `hack/` | `forward-backend.sh` (the hub's backend for `make dev-cluster`), `forward-perses.sh` (the hub's Perses for `make dev-cluster`), `backend-checkout.sh` (the backend at `.backend-api-version` for `make dev-fake-infra`), `hub-ca.sh`, `service-ca.sh` (the hub's service CA, for Perses), `deploy.sh`, `undeploy.sh`, `chart-takeover.sh`, `check-chart.sh`, `test-chart-kind.sh`, `api.sh` (curl as you), `smoke.sh`, `sync-upstream-proto.sh` (vendors the backend's proto), `test-image-workflows.sh` (tests the PR-image workflows' delete logic) |
| `docs/dev-setup.md` | Running against a real cluster, checks, deploying |
| `docs/plan/bff-api.md` | API decisions, endpoint list, RPCs still needed from the backend |
| `docs/plan/work-breakdown.md` | Work split across backend, BFF and frontend |
| `NOTICE` | Attributions for the code and screens ported from the cloud provider PoC |

## Quick start

```sh
oc login ...
make install
make dev-cluster  # the hub's deployed backend on :9090, BFF :8080, frontend :9000
```

Then open http://127.0.0.1:9000. To run your own backend instead, start it with `make run-hub` in
its repository, then run `make dev` here; without a cluster, `make dev-fake` (the console's own fake backend) or
`make dev-fake-infra` (the real backend at `.backend-api-version` on the fake hub and Keycloak of
its repository, fetched into `.cache/backend/`, or your checkout with `BACKEND_DIR`). See
`docs/dev-setup.md` for details.

## Pages

The console has pages for clusters (`/clusters`), organizations (`/organizations`), models
(`/models`), subscriptions (`/subscriptions`), and the AI Grid map and Monitoring
(`/ai-grid`, `/monitoring`). They are ported from the cloud provider PoC; `NOTICE` lists
the attributions. Run them all against the fake backend with `make dev-fake`, as
`docs/dev-setup.md` describes.

## Status

Implemented in the BFF and the fake backend: login, user, config, clusters (list, get,
enroll), organizations, models, locations and the grid overview, with readiness
tied to the backend. The Subscriptions pages call the backend's own API over Connect
(`docs/connect.md`). The shipped `ai-grid-backend` serves clusters (list, get, and the update
behind Add to AI Grid and Remove) and tenants, the console's organizations (list, get, create,
update, delete). A tenant create or update that sets a field the backend's tenant doesn't have
answers 501 instead of dropping it. Against it, models, the grid overview and
capabilities are 501, and so is a list request with `filter`, `offset` or `limit`, which it
doesn't apply; the pages show these as not available on this backend yet. `/user` and
`/config` work on any backend (neither calls it). See the "Waiting on backend RPCs" table in
`docs/plan/bff-api.md`.
