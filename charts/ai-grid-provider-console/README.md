# ai-grid-provider-console chart

The AI Grid provider console for one ACM hub: one pod with kube-auth-proxy, the console (BFF and
frontend) and `ai-grid-provider-backend`. `hack/deploy.sh` (`make deploy`) installs it with the
OAuthClient and Secrets it expects; `docs/dev-setup.md`, "Deploy to a cluster", has the details.
`values.yaml` documents every value and `values.schema.json` refuses any it doesn't list.

## Images

Each image is `repository:tag`, `repository@digest`, or `repository:tag@digest` when both are set.

- **Backend** (`images.backend`): the build of the backend commit in `.backend-api-version`,
  `ghcr.io/ai-grid-cloud/ai-grid-provider-backend:sha-<commit>` with its digest. That is the commit
  the console's API is generated from, and a console ships with the backend it was built against:
  a newer backend can refuse what an older console sends. `make backend-pin SHA=<commit>` sets it,
  with `manifests/base` and `hack/test-chart-kind.sh`, and `make check-generated-api` fails CI when
  one of them names another build. Override it only to run a backend you built yourself.
- **Console** (`images.console`): `latest` by default. A chart in this repository can't name the
  build of its own commit, which is published only after the commit merges. Set `images.console.tag`
  to `sha-<commit>` (or a digest) when you install; `make deploy` requires `TAG`. Once the chart is
  published, the plan is to stamp the console's tag and digest at release time, as OSAC's
  `osac-installer` does in `.github/workflows/publish-charts.yaml` ("Update image tags in
  values.yaml", before `helm package`).
- **Proxy** (`images.authProxy`): `quay.io/opendatahub/odh-kube-auth-proxy:latest`; the kind test
  pins a digest.

## Identity provider secrets

An organization's identity provider names the Secret that holds its OIDC client secret (key
`client-secret`), never the secret itself (`config.client_secret_secret_name`; the backend reads
the Secret's namespace from `AI_GRID_IDP_SECRET_NAMESPACE` in ai-grid-provider-backend's
`cmd/ai-grid-provider-backend/main.go`). By default the chart creates
namespace `ai-grid-idp-secrets` for those Secrets, sets the backend's `AI_GRID_IDP_SECRET_NAMESPACE`
to it, and lets the backend `get` Secrets there: not list, watch or write them. A provider admin
creates each Secret before creating the organization:

```sh
oc -n ai-grid-idp-secrets create secret generic acme-idp --from-literal=client-secret=CLIENT_SECRET
```

Replace `CLIENT_SECRET` with the client secret from the organization's identity provider.

- `backend.idpSecrets.namespace` moves it to another namespace. Keep only identity provider client
  secrets in it, because the backend can get every Secret there. The chart refuses the release
  namespace, which holds the console's own credentials, and the system namespaces `default`,
  `kube-*` and `openshift*`.
- By default the chart creates the namespace. Helm keeps it on uninstall, so the Secrets in it
  survive, and Argo CD keeps it too: it doesn't prune it or delete it with the Application. A kept
  namespace still belongs to the release that created it, so installing under another release name
  or namespace needs `createNamespace=false`.
- `backend.idpSecrets.createNamespace=false` uses a namespace that already exists or something else
  owns, such as one a GitOps repository creates. The chart then adds only the Role and RoleBinding.
- `backend.idpSecrets.enabled=false` renders none of this, and the backend uses its default namespace,
  `ai-grid-idp-secrets`. Creating an organization with an identity provider then fails, unless that
  namespace and a `get` Role for the console's ServiceAccount exist some other way.

`manifests/idp-secrets` is kept equal to the chart's defaults, beside `manifests/base`.

## Timeouts

A call goes through the OpenShift router, then kube-auth-proxy, then the BFF, and each waits for the
next. The BFF answers within its 60s server write timeout (a write to the backend is bounded by
`BACKEND_WRITE_TIMEOUT`, 30s by default and at most 50s; `docs/plan/bff-api.md`). So the two in
front of it wait longer, and a slow model or subscription write ends in the BFF's own answer rather
than a proxy's 504:

- `route.timeout` (default `70s`): the Route's `haproxy.router.openshift.io/timeout`. OpenShift's
  default is 30s.
- `authProxy.upstreamTimeout` (default `65s`): kube-auth-proxy's `--upstream-timeout`. Its own
  default is 30s.

Keep `route.timeout` longer than `authProxy.upstreamTimeout`, and both longer than 60s.
`hack/check-chart.sh` checks the defaults, and the schema refuses a value that isn't a duration.

## Model hardware

The Deploy model wizard offers a **Hardware** choice: each one fills in the model's CPU, memory and
accelerators, sets its runtime image, and adds its environment variables. The provider admin
defines the list in `console.models.hardware`. The chart passes it to the BFF as `MODEL_HARDWARE`
(JSON), and the wizard reads it from `GET /api/v1/config`. The defaults live in `values.yaml`, which
documents each field: **NVIDIA GPU** (selected first; no image, so the cluster's default vLLM image
for NVIDIA GPUs runs) and **CPU only** (OpenShift AI 3.6's vLLM CPU image and settings). The BFF
keeps a copy of the same two (`config.DefaultModelHardware`) for a local run without
`MODEL_HARDWARE`, and for an empty list; `hack/check-chart.sh` fails when the two copies differ.

A hub's list, in its GitOps repository, replaces the default one whole, and its first entry is the
wizard's default. Repeat the default entries you keep. `values.schema.json` refuses an entry the
BFF would refuse at start (an unknown or misspelled field, an id that isn't a DNS label, an
accelerator that isn't a Kubernetes extended resource name, an image with spaces, a CPU or memory
the wizard doesn't take, accelerators without an accelerator), and the template refuses an id used
twice. Changing the list restarts the console's pod, since the BFF reads it at start; models already
deployed keep what they were deployed with. Editing a model starts on the entry it runs on (its
accelerator, or for CPU only the entry's environment variables; not its image), if any, without
changing the model; selecting another entry there applies that entry's image, environment and
resources.

In GitOps, keep the list with the console's other values in the GitOps repository: the values file,
or `spec.source.helm.valuesObject`, of the Argo CD Application that installs this chart. For
example, NVIDIA GPU first, then AMD GPU and CPU only:

```yaml
console:
  models:
    hardware:
      - id: nvidia-gpu
        label: NVIDIA GPU
        description: For clusters with NVIDIA GPUs.
        accelerator: nvidia.com/gpu
        defaults: { accelerators: 1, cpu: "2", memory: 16Gi }
      - id: amd-gpu
        label: AMD GPU
        description: For clusters with AMD Instinct GPUs.
        accelerator: amd.com/gpu
        # An image built for ROCm: without one, the cluster's default vLLM image, built for NVIDIA
        # GPUs, would run.
        image: registry.example.com/vllm/vllm-rocm@sha256:<digest>
        defaults: { accelerators: 1, cpu: "4", memory: 32Gi }
      - id: cpu
        label: CPU only
        description: For x86_64 clusters without GPUs.
        image: registry.redhat.io/rhaii/vllm-cpu-rhel9@sha256:0ec0f5ff9a5ff263f58db0cfb19e3d7eef24b94c2d8629fe5145f5a8747e28c9
        env: { VLLM_CPU_KVCACHE_SPACE: "4", OMP_NUM_THREADS: "4" }
        defaults: { cpu: "4", memory: 8Gi }
```

The wizard sends no presets (`spec.base_refs`), whose names carry the OpenShift AI version and so
exist only on clusters with that version. A model's own image and environment are applied over
KServe's default preset, which is for NVIDIA GPUs. So the wizard lets a model leave the runtime
image empty only on `nvidia.com/gpu`, where the cluster's default vLLM image runs; any other
hardware needs an image, from its entry or typed in.

This console needs a backend that accepts a model without a runtime image and without presets.
With an older backend, deploying NVIDIA GPU with an empty image is refused with the backend's
message: enter an image, or move the backend (`images.backend`) to a build that accepts it. Nothing in a model selects nodes by
architecture: OpenShift AI's CPU preset also sets `kubernetes.io/arch: amd64`, which the backend's
model API has no field for, so place a CPU model on x86_64 clusters only.
