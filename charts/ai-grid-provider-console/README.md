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

## Model servers and hardware profiles

`servingOptions` is the list the Deploy model wizard offers and the backend checks models against
(`Models/ListServingOptions`). It's one list for every cluster: the chart renders it into the
ConfigMap `<fullname>-serving-options`, which the backend reads at start, and a changed list
restarts the pod. The defaults are what OpenShift AI 3.6 installs: every supported accelerator
preset and `default-profile`. `values.yaml` cites the sources.

A hardware profile is a starting point, as in the OpenShift AI dashboard: choosing one fills the
wizard's CPU, memory and GPU fields from each identifier's `defaultCount`, the user can change them
within `minCount` and `maxCount`, and the model is saved with those resources and the profile's
annotations. Copy `identifiers` from the profile on the clusters (`oc get hardwareprofile NAME -n
NAMESPACE -o yaml`, `spec.identifiers`). Nothing checks the copy, so update it when the profile
changes.

To offer a hardware profile you created on the clusters, such as one with an NVIDIA GPU, list it
with the default one:

```yaml
servingOptions:
  hardwareProfiles:
    - name: default-profile
      namespace: redhat-ods-applications
      displayName: Default profile
      description: Starts at 2 CPUs and 4 GiB of memory.
      identifiers:
        - { identifier: cpu, displayName: CPU, minCount: "1", defaultCount: "2", maxCount: "4" }
        - { identifier: memory, displayName: Memory, minCount: 2Gi, defaultCount: 4Gi, maxCount: 8Gi }
    - name: nvidia-gpu
      namespace: redhat-ods-applications
      displayName: NVIDIA GPU
      description: Starts at 4 CPUs, 16 GiB of memory and one NVIDIA GPU.
      identifiers:
        - { identifier: cpu, displayName: CPU, minCount: "2", defaultCount: "4", maxCount: "8" }
        - { identifier: memory, displayName: Memory, minCount: 8Gi, defaultCount: 16Gi, maxCount: 64Gi }
        - { identifier: nvidia.com/gpu, displayName: NVIDIA GPU, minCount: "1", defaultCount: "1", maxCount: "2" }
```

A list value replaces the whole default list, so repeat the entries you keep.

Two limits:

- OpenShift AI installs on each cluster only the presets its nodes can run. A model that names a GPU
  preset fails on a cluster without that accelerator, and its status says so.
- Preset names carry the OpenShift AI release (`v3-6-0-...`). After an OpenShift AI upgrade, list the
  presets on the clusters (`oc get llminferenceserviceconfigs -n redhat-ods-applications -l
  opendatahub.io/config-type=accelerator`) and set `servingOptions.openshiftAIRelease` to the new
  release. A preset the upgrade didn't change keeps its older name: give that server its own
  `release`. Models keep the preset they were made with.

The NVIDIA prefill/decode and multi-node presets add prefill or worker pods that need a topology
the wizard doesn't set: it gives only the main pod its resources, so those pods get no GPUs. Their
descriptions say so. Remove them from the list to stop offering them.
