{{- define "console.fullname" -}}
{{- required "fullnameOverride is required" .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The selector, equal to the one manifests/base gives the Deployment: a Deployment's selector
     can't change, so a hub that ran manifests/base can move to this chart in place. */}}
{{- define "console.selectorLabels" -}}
app.kubernetes.io/name: ai-grid-provider-console
app.kubernetes.io/part-of: ai-grid
{{- end -}}

{{- define "console.labels" -}}
{{ include "console.selectorLabels" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* repository:tag, repository@digest, or repository:tag@digest. */}}
{{- define "console.image" -}}
{{- $ref := required "an image repository is required" .repository -}}
{{- if .tag }}{{ $ref = printf "%s:%s" $ref .tag }}{{ end -}}
{{- if .digest }}{{ $ref = printf "%s@%s" $ref .digest }}{{ end -}}
{{- if not (or .tag .digest) }}{{ fail (printf "image %s needs a tag or a digest" .repository) }}{{ end -}}
{{- $ref -}}
{{- end -}}

{{- define "console.serviceAccountName" -}}{{ include "console.fullname" . }}{{- end -}}
{{- define "console.oauthSecretName" -}}{{ .Values.oauth.secretName | default (printf "%s-oauth" (include "console.fullname" .)) }}{{- end -}}
{{- define "console.tlsSecretName" -}}{{ .Values.tls.secretName | default (printf "%s-tls" (include "console.fullname" .)) }}{{- end -}}
{{/* Not defaulted when empty: an empty name would render `name: ""`, which no Secret has. */}}
{{- define "console.keycloakSecretName" -}}{{ required "backend.keycloakSecretName is required: the Secret with the backend's Keycloak settings (hack/deploy.sh creates ai-grid-backend-keycloak)" .Values.backend.keycloakSecretName }}{{- end -}}

{{/*
The backend's serving options file (AI_GRID_SERVING_OPTIONS_FILE): .Values.servingOptions with each
model server named as OpenShift AI names its presets, v<major>-<minor>-<patch>-<name>.
*/}}
{{- define "console.servingOptions" -}}
{{- $opts := .Values.servingOptions -}}
{{- $release := required "servingOptions.openshiftAIRelease is required" $opts.openshiftAIRelease -}}
{{- /* The backend refuses a name listed twice or longer than an object name, and stops: say so here. */ -}}
{{- $seen := dict -}}
{{- $servers := list -}}
{{- range $opts.modelServers -}}
{{- $name := printf "v%s-%s" (replace "." "-" (.release | default $release)) .name -}}
{{- if hasKey $seen $name }}{{ fail (printf "servingOptions.modelServers lists %s twice" $name) }}{{ end -}}
{{- if gt (len $name) 253 }}{{ fail (printf "servingOptions.modelServers: %s is longer than 253 characters" $name) }}{{ end -}}
{{- $_ := set $seen $name true -}}
{{- $servers = append $servers (dict "name" $name "displayName" (.displayName | default "") "description" (.description | default "") "accelerators" (.accelerators | default list)) -}}
{{- end -}}
{{- $profiles := list -}}
{{- range $opts.hardwareProfiles -}}
{{- if hasKey $seen (printf "profile/%s" .name) }}{{ fail (printf "servingOptions.hardwareProfiles lists %s twice" .name) }}{{ end -}}
{{- $_ := set $seen (printf "profile/%s" .name) true -}}
{{- $identifiers := list -}}
{{- range (.identifiers | default list) -}}
{{- /* Counts as strings: the backend reads them as Kubernetes quantities, and YAML would make 2 a number. */ -}}
{{- $id := dict "identifier" .identifier "displayName" (.displayName | default "") "minCount" (toString .minCount) "defaultCount" (toString .defaultCount) -}}
{{- if hasKey . "maxCount" }}{{ $_ := set $id "maxCount" (toString .maxCount) }}{{ end -}}
{{- $identifiers = append $identifiers $id -}}
{{- end -}}
{{- $profiles = append $profiles (dict "name" .name "namespace" .namespace "displayName" (.displayName | default "") "description" (.description | default "") "identifiers" $identifiers) -}}
{{- end -}}
{{- toYaml (dict "modelServers" $servers "hardwareProfiles" $profiles) -}}
{{- end -}}
