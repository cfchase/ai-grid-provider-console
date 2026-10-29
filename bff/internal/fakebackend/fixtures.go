package fakebackend

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// Fixtures is the content of a fixtures directory (mock/fixtures by default).
//
//	managedclusters.json  {"clusters": [ManagedCluster...]} in protojson
//	gpunodes.json         {"nodes": [SearchNode...]}: the spokes' GPU nodes as ACM
//	                      Search returns them, from which each cluster's
//	                      status.gpus is derived (see gpus.go)
//	tenants.json          {"tenants": [Tenant...]} in protojson, or
//	                      {"unavailable": "<error text>"} to simulate a backend
//	                      whose Keycloak cannot be reached, or
//	                      {"realmMissing": true} for a Keycloak without the
//	                      ai-grid realm (the dev hub today), or
//	                      {"organizationsDisabled": true} for a realm whose
//	                      organizations feature is off
//	models.json           {"models": [Model...]} in protojson, plus
//	                      {"bindings": {"<namespace>": ["global"]}} naming the
//	                      ManagedClusterSets bound into a model namespace (a
//	                      namespace not listed is bound to `global`; an empty
//	                      list simulates a namespace without a binding)
//	presets.json          {"namespace": "...", "presets": [...]} the installed
//	                      LLMInferenceServiceConfigs baseRefs resolve against
//	access.json           who the fake hub treats as provider admin
//	settings.json         latency, scenario speed, hub capabilities
//	scenarios.json        {"events": [ScenarioEvent...]} timed transitions
//
// Proto messages are decoded with protojson so the files use the same field
// names (lowerCamelCase) that grpcurl and the real backend's JSON logs show.
type Fixtures struct {
	Clusters []*aigridv1.ManagedCluster
	// GPUNodes are the spokes' Node objects as ACM Search returns them.
	GPUNodes            []SearchNode
	Tenants             []*aigridv1.Tenant
	TenantsUnavailable  string
	TenantsRealmMissing bool
	TenantsOrgsDisabled bool
	Access              Access
	Latency             Duration
	// Speed multiplies the scenario clock; 2 fires a "20s" event after 10s.
	// Zero (not set) means 1.
	Speed     float64
	Scenarios []ScenarioEvent
	// Models and what they resolve against.
	Models        []*aigridv1.Model
	ModelBindings map[string][]string
	Presets       *Presets
	// Hub capabilities (settings.json). ManifestWorkReplicaSetEnabled nil
	// means true; false mirrors the dev hub, where nothing reconciles an MWRS.
	ManifestWorkReplicaSetEnabled *bool
	ObservabilityInstalled        bool
	ACMVersion                    string
}

// Access decides the fake hub's SelfSubjectAccessReview answers.
type Access struct {
	// DefaultAllowed is the answer for any token not listed below.
	DefaultAllowed bool `json:"defaultAllowed"`
	// DeniedTokens get allowed: false, like a user without the ClusterRole.
	DeniedTokens []string `json:"deniedTokens"`
	// RejectedTokens get 401, like an expired or revoked OpenShift token.
	RejectedTokens []string `json:"rejectedTokens"`
}

// Duration is a time.Duration that decodes from JSON strings like "80ms".
type Duration struct{ d time.Duration }

// Duration returns the wrapped value.
func (d Duration) Duration() time.Duration { return d.d }

// UnmarshalJSON accepts a Go duration string.
func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("duration %q: %w", s, err)
	}
	d.d = v
	return nil
}

// Load reads a fixtures directory. Missing files are allowed and leave their
// part empty, so a directory with only managedclusters.json is valid. The
// directory itself must exist: a mistyped --fixtures path is a configuration
// error, not an empty backend.
func Load(dir string) (*Fixtures, error) {
	info, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("fixtures directory: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("fixtures directory %s is not a directory", dir)
	}
	fx := &Fixtures{Access: Access{DefaultAllowed: true}}

	if raw, ok, err := readFile(filepath.Join(dir, "managedclusters.json")); err != nil {
		return nil, err
	} else if ok {
		var doc struct {
			Clusters []json.RawMessage `json:"clusters"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("managedclusters.json: %w", err)
		}
		for i, m := range doc.Clusters {
			c := &aigridv1.ManagedCluster{}
			if err := protojson.Unmarshal(m, c); err != nil {
				return nil, fmt.Errorf("managedclusters.json cluster %d: %w", i, err)
			}
			fx.Clusters = append(fx.Clusters, c)
		}
	}

	if raw, ok, err := readFile(filepath.Join(dir, "gpunodes.json")); err != nil {
		return nil, err
	} else if ok {
		var doc struct {
			Nodes []SearchNode `json:"nodes"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("gpunodes.json: %w", err)
		}
		fx.GPUNodes = doc.Nodes
	}

	if raw, ok, err := readFile(filepath.Join(dir, "tenants.json")); err != nil {
		return nil, err
	} else if ok {
		var doc struct {
			Tenants               []json.RawMessage `json:"tenants"`
			Unavailable           string            `json:"unavailable"`
			RealmMissing          bool              `json:"realmMissing"`
			OrganizationsDisabled bool              `json:"organizationsDisabled"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("tenants.json: %w", err)
		}
		modes := 0
		for _, set := range []bool{doc.Unavailable != "", doc.RealmMissing, doc.OrganizationsDisabled, doc.Tenants != nil} {
			if set {
				modes++
			}
		}
		if modes > 1 {
			return nil, errors.New("tenants.json: use one of tenants, unavailable, realmMissing or organizationsDisabled")
		}
		fx.TenantsUnavailable = doc.Unavailable
		fx.TenantsRealmMissing = doc.RealmMissing
		fx.TenantsOrgsDisabled = doc.OrganizationsDisabled
		if doc.Tenants != nil {
			fx.Tenants = []*aigridv1.Tenant{}
		}
		for i, m := range doc.Tenants {
			t := &aigridv1.Tenant{}
			if err := protojson.Unmarshal(m, t); err != nil {
				return nil, fmt.Errorf("tenants.json tenant %d: %w", i, err)
			}
			fx.Tenants = append(fx.Tenants, t)
		}
	}

	if raw, ok, err := readFile(filepath.Join(dir, "access.json")); err != nil {
		return nil, err
	} else if ok {
		if err := json.Unmarshal(raw, &fx.Access); err != nil {
			return nil, fmt.Errorf("access.json: %w", err)
		}
	}

	if raw, ok, err := readFile(filepath.Join(dir, "settings.json")); err != nil {
		return nil, err
	} else if ok {
		var doc struct {
			Latency                       Duration `json:"latency"`
			Speed                         *float64 `json:"speed"`
			ManifestWorkReplicaSetEnabled *bool    `json:"manifestWorkReplicaSetEnabled"`
			ObservabilityInstalled        bool     `json:"observabilityInstalled"`
			ACMVersion                    string   `json:"acmVersion"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("settings.json: %w", err)
		}
		fx.Latency = doc.Latency
		fx.ManifestWorkReplicaSetEnabled = doc.ManifestWorkReplicaSetEnabled
		fx.ObservabilityInstalled = doc.ObservabilityInstalled
		fx.ACMVersion = doc.ACMVersion
		if doc.Speed != nil {
			if *doc.Speed <= 0 {
				return nil, fmt.Errorf("settings.json: speed must be greater than zero, got %v", *doc.Speed)
			}
			fx.Speed = *doc.Speed
		}
	}

	if raw, ok, err := readFile(filepath.Join(dir, "models.json")); err != nil {
		return nil, err
	} else if ok {
		var doc struct {
			Models   []json.RawMessage   `json:"models"`
			Bindings map[string][]string `json:"bindings"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("models.json: %w", err)
		}
		for i, raw := range doc.Models {
			m := &aigridv1.Model{}
			if err := protojson.Unmarshal(raw, m); err != nil {
				return nil, fmt.Errorf("models.json model %d: %w", i, err)
			}
			fx.Models = append(fx.Models, m)
		}
		fx.ModelBindings = doc.Bindings
		for ns, sets := range doc.Bindings {
			for _, set := range sets {
				if !knownClusterSets[set] {
					return nil, fmt.Errorf("models.json bindings[%q]: ManagedClusterSet %q does not exist on the hub", ns, set)
				}
			}
		}
	}

	if raw, ok, err := readFile(filepath.Join(dir, "presets.json")); err != nil {
		return nil, err
	} else if ok {
		var doc Presets
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("presets.json: %w", err)
		}
		if doc.Namespace == "" || len(doc.Names) == 0 {
			return nil, errors.New("presets.json: namespace and presets are required")
		}
		fx.Presets = &doc
	}

	if raw, ok, err := readFile(filepath.Join(dir, "scenarios.json")); err != nil {
		return nil, err
	} else if ok {
		var doc struct {
			Events []ScenarioEvent `json:"events"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("scenarios.json: %w", err)
		}
		fx.Scenarios = doc.Events
	}
	return fx, nil
}

func readFile(path string) ([]byte, bool, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}
