package fakebackend

import (
	"log/slog"
	"slices"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/fieldmaskpb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// pocFixtures is the preset the browser tests load: the PoC's four sites
// and three models (shared/grid-clusters.mjs seedClusters() and
// src/services/subscriptions/fixtures.ts at 62319b8).
const pocFixtures = "../../../mock/fixtures-poc"

// pocCluster is what the PoC shows for one of its sites.
type pocCluster struct {
	name, site, siteName, region, latitude, longitude string
	enrolled, provisioned                             bool
}

var pocClusters = []pocCluster{
	{"site1", "san-francisco", "San Francisco", "us-west", "37.7749", "-122.4194", true, true},
	{"site2", "new-york", "New York", "us-east", "40.7128", "-74.0060", true, true},
	{"site3", "brussels", "Brussels", "europe-west", "50.8503", "4.3517", true, true},
	{"site4", "sydney", "Sydney", "asia-pacific", "-33.8688", "151.2093", false, false},
}

// newPoCServer is a server on the preset whose clock stands still at fixedNow.
func newPoCServer(t *testing.T) *Server {
	t.Helper()
	fx, err := Load(pocFixtures)
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(fx, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	s.SetClock(func() time.Time { return fixedNow })
	return s
}

// TestPoCPresetMatchesThePoC: the preset seeds what the PoC shows at
// 62319b8, so a difference in the visual comparison comes from code, not
// data, and it passes the checks the default fixtures (mock/fixtures) pass.
func TestPoCPresetMatchesThePoC(t *testing.T) {
	t.Parallel()
	fx, err := Load(pocFixtures)
	if err != nil {
		t.Fatal(err)
	}
	checkClustersLookLikeTheHub(t, fx)
	checkClustersUseOnlyHubStrings(t, fx)
	checkModelsUseOnlyKnownStrings(t, fx, nil)
	if fx.Latency.Duration() != 0 || fx.Speed != 5 || fx.ManifestWorkReplicaSetEnabled == nil || !*fx.ManifestWorkReplicaSetEnabled || len(fx.Scenarios) != 0 {
		t.Errorf("settings: latency %s, speed %v, MWRS %v, %d scenario events; want 0s, 5, true, none", fx.Latency.Duration(), fx.Speed, fx.ManifestWorkReplicaSetEnabled, len(fx.Scenarios))
	}

	s := newPoCServer(t)
	ctx := authed(t.Context())

	clusters, err := s.ListManagedClusters(ctx, &aigridv1.ListManagedClustersRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(clusters.GetClusters()) != len(pocClusters) {
		t.Fatalf("%d clusters, want %d", len(clusters.GetClusters()), len(pocClusters))
	}
	for i, want := range pocClusters {
		c := clusters.GetClusters()[i]
		l, a := c.GetLabels(), c.GetAnnotations()
		if c.GetName() != want.name || l[LabelLocation] != want.name || l[LabelAIGridSite] != want.site || l[LabelAIGridRegion] != want.region ||
			a["ai-grid/site-name"] != want.siteName || a["ai-grid/latitude"] != want.latitude || a["ai-grid/longitude"] != want.longitude {
			t.Errorf("cluster %d = %s location %q site %q region %q name %q at %q,%q; want %+v", i, c.GetName(), l[LabelLocation], l[LabelAIGridSite], l[LabelAIGridRegion],
				a["ai-grid/site-name"], a["ai-grid/latitude"], a["ai-grid/longitude"], want)
		}
		if got := c.GetStatus().GetState(); got != aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE {
			t.Errorf("%s: state %s, want ready", c.GetName(), got)
		}
		if (l[LabelAIGridEnabled] == "true") != want.enrolled || (l[LabelAIGridProvisioned] == "true") != want.provisioned {
			t.Errorf("%s: enabled %q provisioned %q, want enrolled %v provisioned %v", c.GetName(), l[LabelAIGridEnabled], l[LabelAIGridProvisioned], want.enrolled, want.provisioned)
		}
	}

	locations, err := s.ListLocations(ctx, &aigridv1.ListLocationsRequest{})
	if err != nil || !slices.Equal(locations.GetLocations(), []string{"site1", "site2", "site3"}) {
		t.Fatalf("locations %v %v", locations, err)
	}

	models, err := s.ListModels(ctx, &aigridv1.ListModelsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	wantModels := map[string]string{"granite-3-8b": "Granite 3.3 8B Instruct", "granite-research": "Granite research endpoint", "llama-3-70b": "Llama 3.3 70B Instruct"}
	if len(models.GetItems()) != len(wantModels) {
		t.Fatalf("%d models, want %d", len(models.GetItems()), len(wantModels))
	}
	for _, m := range models.GetItems() {
		ann := m.GetMetadata().GetAnnotations()
		if want, ok := wantModels[m.GetName()]; !ok || ann[AnnotationDisplayName] != want || ann["openshift.io/description"] != "" {
			t.Errorf("model %s display name %q description %q, want %q and none", m.GetName(), ann[AnnotationDisplayName], ann["openshift.io/description"], want)
		}
		if m.GetMetadata().GetNamespace() != pocModelNamespace || m.GetSpec().GetPlacement() != nil {
			t.Errorf("%s: namespace %q placement %v; want %s and no locations", m.GetName(), m.GetMetadata().GetNamespace(), m.GetSpec().GetPlacement(), pocModelNamespace)
		}
		wantPhase(t, m, aigridv1.ModelPhase_MODEL_PHASE_READY, "")
	}

	tenants, err := s.ListTenants(ctx, &aigridv1.ListTenantsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	var tenantNames []string
	tenantIDs := map[string]bool{}
	for _, tn := range tenants.GetTenants() {
		tenantNames = append(tenantNames, tn.GetName())
		tenantIDs[tn.GetId()] = true
		if tn.GetIdentityProvider() == nil || tn.GetResourceVersion() == "" || tn.GetCreateTime() == nil {
			t.Errorf("%s: identity provider %v, version %q, created %v; want all three", tn.GetName(), tn.GetIdentityProvider(), tn.GetResourceVersion(), tn.GetCreateTime())
		}
	}
	slices.Sort(tenantNames)
	if !slices.Equal(tenantNames, []string{"acme-robotics", "globex-research", "initech-labs"}) {
		t.Errorf("organizations %v", tenantNames)
	}

}

// TestPoCPresetEnrollsSite4AsProvisioning: as in the PoC, enrolling site4
// makes it a member that is not provisioned, so it isn't a location yet.
func TestPoCPresetEnrollsSite4AsProvisioning(t *testing.T) {
	t.Parallel()
	s := newPoCServer(t)
	ctx := authed(t.Context())
	site4, err := s.GetManagedCluster(ctx, &aigridv1.GetManagedClusterRequest{Name: "site4"})
	if err != nil {
		t.Fatal(err)
	}
	labels := site4.GetObject().GetLabels()
	labels[LabelAIGridEnabled] = "true"
	resp, err := s.UpdateManagedCluster(ctx, &aigridv1.UpdateManagedClusterRequest{
		Object:     &aigridv1.ManagedCluster{Name: "site4", Labels: labels},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"labels"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if l := resp.GetObject().GetLabels(); l[LabelAIGridEnabled] != "true" || l[LabelAIGridProvisioned] == "true" {
		t.Fatalf("site4 labels %v", l)
	}
	locations, err := s.ListLocations(ctx, &aigridv1.ListLocationsRequest{})
	if err != nil || !slices.Equal(locations.GetLocations(), []string{"site1", "site2", "site3"}) {
		t.Fatalf("locations after enrolling site4 %v %v", locations, err)
	}
}

// pocModelNamespace is the namespace of the PoC preset's models (mock/fixtures-poc/models.json).
const pocModelNamespace = "ai-grid-models"
