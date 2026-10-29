package api

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/proto"

	backendv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/backend/v1"
	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend/backendtest"
)

// The BFF reaches two kinds of backend. The console's fake serves the draft
// API (backend.Config.DraftAPI, `make run-fake`); ai-grid-provider-backend
// serves its own ai_grid.v1, which the BFF calls through the adapters in
// internal/backend (production). The tests in this file run each behaviour
// both share against both, with the same fleet seeded in each one's shape,
// so a change that works on the fake and breaks the production path fails.

// fleetModelsNamespace is the namespace of the seeded model.
const fleetModelsNamespace = backendtest.V1ModelsNamespace

// backendShape is one backend the BFF can be dialed to, seeded with the
// fleet: tenant t-1 "acme" at version 3; model tiny-llm at version 7 with one replica;
// and the location site-1. start fails
// every call with err when it is set, and returns the client and the
// incoming metadata of the last call.
type backendShape struct {
	name  string
	start func(t *testing.T, err error) (*backend.Client, func() metadata.MD)
}

var backendShapes = []backendShape{
	{"draft", func(t *testing.T, err error) (*backend.Client, func() metadata.MD) {
		fake := &backendtest.Fake{
			Err:     err,
			Tenants: []*aigridv1.Tenant{{Id: "t-1", Name: "acme", Domains: []string{"acme.example.com"}, ResourceVersion: "3"}},
			Models: []*aigridv1.Model{{Name: "tiny-llm", Metadata: &aigridv1.ObjectMeta{Namespace: fleetModelsNamespace, ResourceVersion: "7"},
				Spec: &aigridv1.ModelSpec{Replicas: proto.Int32(1), Model: &aigridv1.ModelSource{Uri: "hf://example-org/tiny-llm"}}}},
			Locations: []string{"site-1"},
		}
		return backendtest.Start(t, fake), func() metadata.MD { return fake.Metadata }
	}},
	{"v1", func(t *testing.T, err error) (*backend.Client, func() metadata.MD) {
		v1 := &backendtest.V1{
			Err: err,
			Tenants: []*backendv1.Tenant{{Id: "t-1", Metadata: &backendv1.Metadata{Name: "acme", Version: 3},
				Spec: &backendv1.TenantSpec{Domains: []string{"acme.example.com"}}}},
			Models: []*backendv1.Model{{Id: "tiny-llm", Metadata: &backendv1.Metadata{Name: "tiny-llm", Version: 7},
				Spec: &backendv1.ModelSpec{Replicas: proto.Int32(1), Model: &backendv1.ModelSource{Uri: "hf://example-org/tiny-llm"}}}},
			Locations: []string{"site-1"},
		}
		return backendtest.StartV1(t, v1), v1.Metadata
	}},
}

// onEveryBackend runs test once per backend shape, on a BFF of its own.
func onEveryBackend(t *testing.T, test func(t *testing.T, app *App)) {
	t.Helper()
	for _, shape := range backendShapes {
		t.Run(shape.name, func(t *testing.T) {
			t.Parallel()
			client, _ := shape.start(t, nil)
			test(t, NewApp(testConfig(t), slog.New(slog.DiscardHandler), client, startHub(t, &fakeHub{allowed: true})))
		})
	}
}

// wantStatus fails the test unless rec answered want, and then checks the
// ETag when wantETag is set.
func wantStatus(t *testing.T, what string, rec *httptest.ResponseRecorder, want int, wantETag string) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("%s: status %d (%s), want %d", what, rec.Code, strings.TrimSpace(rec.Body.String()), want)
	}
	if got := rec.Header().Get("ETag"); wantETag != "" && got != wantETag {
		t.Fatalf("%s: ETag %s, want %s", what, got, wantETag)
	}
}

func TestTenantsOnEveryBackend(t *testing.T) {
	t.Parallel()
	onEveryBackend(t, func(t *testing.T, app *App) {
		var list []Tenant
		rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants?limit=10"))
		wantStatus(t, "list", rec, http.StatusOK, "")
		if meta := decodeList(t, rec, &list); len(list) != 1 || list[0].ID != "t-1" || !list[0].Enabled || total(meta) != 1 {
			t.Fatalf("list: %+v, meta %+v; want enabled t-1, total 1", list, meta)
		}
		wantStatus(t, "get", serve(app, asUser(http.MethodGet, "/api/v1/tenants/t-1")), http.StatusOK, `"3"`)
		wantStatus(t, "get unknown", serve(app, asUser(http.MethodGet, "/api/v1/tenants/t-9")), http.StatusNotFound, "")

		rec = serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "globex", "domains": ["globex.example.com"]}`))
		wantStatus(t, "create", rec, http.StatusCreated, `"1"`)
		if loc := rec.Header().Get("Location"); loc != "/api/v1/tenants/t-2" {
			t.Fatalf("create: Location %q, want /api/v1/tenants/t-2", loc)
		}
		wantStatus(t, "create a taken name", serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "acme"}`)), http.StatusConflict, "")

		rename := `{"domains": ["acme.example.org"]}`
		wantStatus(t, "stale patch", serve(app, withIfMatch(jsonRequest(http.MethodPatch, "/api/v1/tenants/t-1", rename), `"2"`)), http.StatusConflict, "")
		rec = serve(app, withIfMatch(jsonRequest(http.MethodPatch, "/api/v1/tenants/t-1", rename), `"3"`))
		wantStatus(t, "patch", rec, http.StatusOK, `"4"`)
		var patched Tenant
		if decodeData(t, rec, &patched); len(patched.Domains) != 1 || patched.Domains[0] != "acme.example.org" {
			t.Fatalf("patched domains %v, want [acme.example.org]", patched.Domains)
		}

		wantStatus(t, "stale delete", serve(app, withIfMatch(asUser(http.MethodDelete, "/api/v1/tenants/t-1"), `"3"`)), http.StatusConflict, "")
		wantStatus(t, "delete", serve(app, withIfMatch(asUser(http.MethodDelete, "/api/v1/tenants/t-1"), `"4"`)), http.StatusNoContent, "")
		wantStatus(t, "get after delete", serve(app, asUser(http.MethodGet, "/api/v1/tenants/t-1")), http.StatusNotFound, "")
	})
}

func TestModelsOnEveryBackend(t *testing.T) {
	t.Parallel()
	const tiny = "/api/v1/models/" + fleetModelsNamespace + "/tiny-llm"
	onEveryBackend(t, func(t *testing.T, app *App) {
		var list []Model
		rec := serve(app, asUser(http.MethodGet, "/api/v1/models?offset=0&limit=5"))
		wantStatus(t, "list", rec, http.StatusOK, "")
		if meta := decodeList(t, rec, &list); len(list) != 1 || list[0].Name != "tiny-llm" || list[0].Namespace != fleetModelsNamespace || total(meta) != 1 {
			t.Fatalf("list: %+v, meta %+v; want %s/tiny-llm, total 1", list, meta, fleetModelsNamespace)
		}
		wantStatus(t, "get", serve(app, asUser(http.MethodGet, tiny)), http.StatusOK, `"7"`)
		wantStatus(t, "get unknown", serve(app, asUser(http.MethodGet, "/api/v1/models/"+fleetModelsNamespace+"/missing")), http.StatusNotFound, "")

		rec = serve(app, jsonRequest(http.MethodPost, "/api/v1/models", `{"name": "cpu-only", "namespace": "`+fleetModelsNamespace+`", "modelUri": "hf://example-org/cpu-only"}`))
		wantStatus(t, "create", rec, http.StatusCreated, "")
		if loc := rec.Header().Get("Location"); loc != "/api/v1/models/"+fleetModelsNamespace+"/cpu-only" {
			t.Fatalf("create: Location %q", loc)
		}
		wantStatus(t, "create a taken name", serve(app, jsonRequest(http.MethodPost, "/api/v1/models", `{"name": "tiny-llm", "namespace": "`+fleetModelsNamespace+`", "modelUri": "hf://x/y"}`)), http.StatusConflict, "")

		wantStatus(t, "stale patch", serve(app, withIfMatch(jsonRequest(http.MethodPatch, tiny, `{"replicas": 3}`), `"6"`)), http.StatusConflict, "")
		rec = serve(app, withIfMatch(jsonRequest(http.MethodPatch, tiny, `{"replicas": 3}`), `"7"`))
		wantStatus(t, "patch", rec, http.StatusOK, `"8"`)
		var patched Model
		if decodeData(t, rec, &patched); patched.Replicas == nil || *patched.Replicas != 3 {
			t.Fatalf("patched replicas %v, want 3", patched.Replicas)
		}

		wantStatus(t, "stale delete", serve(app, withIfMatch(asUser(http.MethodDelete, tiny), `"7"`)), http.StatusConflict, "")
		wantStatus(t, "delete", serve(app, withIfMatch(asUser(http.MethodDelete, tiny), `"8"`)), http.StatusNoContent, "")
		wantStatus(t, "get after delete", serve(app, asUser(http.MethodGet, tiny)), http.StatusNotFound, "")

		rec = serve(app, asUser(http.MethodGet, "/api/v1/locations"))
		wantStatus(t, "locations", rec, http.StatusOK, "")
		if got := strings.TrimSpace(rec.Body.String()); got != `{"data":["site-1"]}` {
			t.Fatalf("locations: %s, want site-1", got)
		}
	})
}

// The caller's identity reaches either backend, and the backend's codes map
// to the same HTTP statuses through the adapters as through the draft.
func TestIdentityAndErrorsOnEveryBackend(t *testing.T) {
	t.Parallel()
	for _, shape := range backendShapes {
		t.Run(shape.name, func(t *testing.T) {
			t.Parallel()
			client, md := shape.start(t, nil)
			app := NewApp(testConfig(t), slog.New(slog.DiscardHandler), client, startHub(t, &fakeHub{allowed: true}))
			wantStatus(t, "list", serve(app, asUser(http.MethodGet, "/api/v1/tenants")), http.StatusOK, "")
			got := md()
			for key, want := range map[string]string{
				backend.MetaAuthorization: "Bearer sha256~token",
				backend.MetaUser:          "alice",
				backend.MetaEmail:         "alice@example.com",
				backend.MetaGroups:        "system:authenticated,cluster-admins",
			} {
				if v := strings.Join(got.Get(key), "|"); v != want {
					t.Errorf("metadata %s = %q, want %q", key, v, want)
				}
			}

			// keep: the answer carries the backend's message (a client-caused failure).
			for _, tc := range []struct {
				code codes.Code
				want int
				keep bool
			}{
				{codes.PermissionDenied, http.StatusForbidden, true},
				{codes.Unauthenticated, http.StatusUnauthorized, false},
				{codes.NotFound, http.StatusNotFound, true},
				{codes.Aborted, http.StatusConflict, true},
				{codes.FailedPrecondition, http.StatusPreconditionFailed, true},
				{codes.InvalidArgument, http.StatusUnprocessableEntity, true},
				{codes.Unimplemented, http.StatusNotImplemented, false},
				{codes.Unavailable, http.StatusServiceUnavailable, false},
				{codes.Internal, http.StatusBadGateway, false},
			} {
				t.Run(tc.code.String(), func(t *testing.T) {
					client, _ := shape.start(t, backendtest.Status(tc.code, "backend said no"))
					app := NewApp(testConfig(t), slog.New(slog.DiscardHandler), client, startHub(t, &fakeHub{allowed: true}))
					for _, path := range []string{"/api/v1/tenants", "/api/v1/models"} {
						rec := serve(app, asUser(http.MethodGet, path))
						if msg := decodeError(t, rec).Error.Message; rec.Code != tc.want || (msg == "backend said no") != tc.keep {
							t.Errorf("GET %s: %d %q, want %d (backend's message kept: %v)", path, rec.Code, msg, tc.want, tc.keep)
						}
					}
				})
			}
		})
	}
}

// The backend has no Grid service and no capabilities (a method it doesn't
// serve answers Unimplemented without reaching a handler), and the adapters
// refuse with 501 what its API cannot carry, before any call: a model
// filter and tenant fields its Tenant lacks.
func TestV1BackendAnswers501ForWhatItLacks(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ method, path, body, ifMatch string }{
		{http.MethodGet, "/api/v1/grid/overview?range=1h", "", ""},
		{http.MethodGet, "/api/v1/grid/overview?range=24h&site=brussels&metrics=false", "", ""},
		{http.MethodGet, "/api/v1/capabilities", "", ""},
		{http.MethodGet, "/api/v1/models?filter=" + url.QueryEscape(`this.name == "tiny-llm"`), "", ""},
		{http.MethodPost, "/api/v1/tenants", `{"name": "globex", "description": "Globex Corp."}`, ""},
		{http.MethodPatch, "/api/v1/tenants/t-1", `{"alias": "acme"}`, `"3"`},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			t.Parallel()
			v1 := &backendtest.V1{}
			app := NewApp(testConfig(t), slog.New(slog.DiscardHandler), backendtest.StartV1(t, v1), startHub(t, &fakeHub{allowed: true}))
			req := asUser(tc.method, tc.path)
			if tc.body != "" {
				req = jsonRequest(tc.method, tc.path, tc.body)
			}
			if tc.ifMatch != "" {
				req = withIfMatch(req, tc.ifMatch)
			}
			rec := serve(app, req)
			wantStatus(t, tc.method+" "+tc.path, rec, http.StatusNotImplemented, "")
			if calls := v1.Calls(); len(calls) != 0 {
				t.Errorf("reached the backend's %v", calls)
			}
		})
	}
}

// The backend pages tenants and counts them, but doesn't evaluate a filter:
// the adapter answers no total for a filtered list, and the BFF refuses it
// with 501 rather than show the unfiltered rows as the result (requireTotal).
func TestV1TenantFilterIs501AndPagingWorks(t *testing.T) {
	t.Parallel()
	v1 := &backendtest.V1{}
	for _, name := range []string{"org-1", "org-2", "org-3"} {
		v1.Tenants = append(v1.Tenants, &backendv1.Tenant{Id: "id-" + name, Metadata: &backendv1.Metadata{Name: name, Version: 1}})
	}
	app := NewApp(testConfig(t), slog.New(slog.DiscardHandler), backendtest.StartV1(t, v1), startHub(t, &fakeHub{allowed: true}))
	for _, q := range []string{"filter=false", "filter=" + url.QueryEscape(`this.name == "org-1"`) + "&limit=5"} {
		rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants?"+q))
		wantStatus(t, q, rec, http.StatusNotImplemented, "")
		if got, want := decodeError(t, rec).Error.Message, "the AI Grid backend does not support filtering or paging tenants yet; list them without filter, offset or limit"; got != want {
			t.Errorf("%s: message %q, want %q", q, got, want)
		}
	}
	var page []Tenant
	rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants?offset=1&limit=1"))
	wantStatus(t, "page", rec, http.StatusOK, "")
	if meta := decodeList(t, rec, &page); len(page) != 1 || page[0].Name != "org-2" || meta.Offset != 1 || total(meta) != 3 {
		t.Fatalf("page: %+v, meta %+v; want org-2 of 3 at offset 1", page, meta)
	}
}
