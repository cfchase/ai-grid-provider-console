package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend/backendtest"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/config"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/hub"
)

func testConfig(t *testing.T) config.Config {
	t.Helper()
	cfg, err := config.Parse([]string{"--hub-api-url=https://hub.invalid"}, func(string) (string, bool) { return "", false })
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

// fakeHub stands in for the hub API server: it answers every
// SelfSubjectAccessReview with allowed, or fails with status when set, and
// keeps the Authorization of the last review (lastAuth).
type fakeHub struct {
	allowed bool
	status  int

	mu   sync.Mutex
	auth string
}

func (f *fakeHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.auth = r.Header.Get("Authorization")
	f.mu.Unlock()
	if f.status != 0 {
		http.Error(w, http.StatusText(f.status), f.status)
		return
	}
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write([]byte(`{"status":{"allowed":` + strconv.FormatBool(f.allowed) + `}}`))
}

// lastAuth is the Authorization header of the last access review.
func (f *fakeHub) lastAuth() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.auth
}

// recorder keeps strings a test server records, safe for its handlers to add
// to while the test reads.
type recorder struct {
	mu  sync.Mutex
	got []string
}

func (r *recorder) add(v string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got = append(r.got, v)
}

func (r *recorder) values() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.got)
}

func startHub(t *testing.T, f *fakeHub) *hub.Client {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	c, err := hub.New(hub.Config{URL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func newTestApp(t *testing.T, cfg config.Config, fake *backendtest.Fake) *App {
	t.Helper()
	return newTestAppWithHub(t, cfg, fake, &fakeHub{allowed: true})
}

func newTestAppWithHub(t *testing.T, cfg config.Config, fake *backendtest.Fake, h *fakeHub) *App {
	t.Helper()
	if fake == nil {
		fake = &backendtest.Fake{}
	}
	return NewApp(cfg, slog.New(slog.DiscardHandler), backendtest.Start(t, fake), startHub(t, h))
}

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) errorBody {
	t.Helper()
	var body errorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body %q: %v", rec.Body.String(), err)
	}
	return body
}

func decodeData(t *testing.T, rec *httptest.ResponseRecorder, into any) {
	t.Helper()
	var env struct{ Data json.RawMessage }
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode envelope %q: %v", rec.Body.String(), err)
	}
	if err := json.Unmarshal(env.Data, into); err != nil {
		t.Fatalf("decode data %q: %v", env.Data, err)
	}
}

// asUser builds an authenticated request the way kube-auth-proxy would.
func asUser(method, path string) *http.Request {
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set(config.DefaultAuthTokenHeader, "sha256~token")
	req.Header.Set(config.DefaultAuthUserHeader, "alice")
	req.Header.Set(config.DefaultAuthEmailHeader, "alice@example.com")
	req.Header.Set(config.DefaultAuthGroupsHeader, "system:authenticated,cluster-admins")
	return req
}

func serve(app *App, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, req)
	return rec
}

func TestHealthcheckNeedsNoToken(t *testing.T) {
	t.Parallel()
	app := newTestApp(t, testConfig(t), nil)
	rec := serve(app, httptest.NewRequest(http.MethodGet, "/healthcheck", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var body healthStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Status != "ok" {
		t.Fatalf("body = %s, err = %v", rec.Body.String(), err)
	}
	if rec.Header().Get("X-Request-Id") == "" {
		t.Fatal("missing X-Request-Id")
	}
}

func TestReadyzReflectsBackend(t *testing.T) {
	t.Parallel()
	fake := &backendtest.Fake{}
	app := newTestApp(t, testConfig(t), fake)
	if rec := serve(app, httptest.NewRequest(http.MethodGet, "/readyz", nil)); rec.Code != http.StatusOK {
		t.Fatalf("ready status = %d %s", rec.Code, rec.Body.String())
	}
	if fake.Metadata.Get("authorization") != nil {
		t.Fatal("readiness probe must not forward credentials")
	}
	fake.Err = backendtest.Status(codes.Unavailable, "down")
	rec := serve(app, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("not-ready status = %d", rec.Code)
	}
}

func TestAPIRequiresToken(t *testing.T) {
	t.Parallel()
	app := newTestApp(t, testConfig(t), nil)
	rec := serve(app, httptest.NewRequest(http.MethodGet, "/api/v1/tenants", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if body := decodeError(t, rec); body.Error.Code != "401" {
		t.Fatalf("error code = %q", body.Error.Code)
	}
}

func TestUnknownAPIPathIsJSON404(t *testing.T) {
	t.Parallel()
	rec := serve(newTestApp(t, testConfig(t), nil), asUser(http.MethodGet, "/api/v1/nope"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content type = %q", ct)
	}
}

// A known path asked with a method it has no route for is 405 with Allow and
// the JSON error shape, not the unknown-path 404.
func TestWrongMethodIsJSON405(t *testing.T) {
	t.Parallel()
	app := newTestApp(t, testConfig(t), nil)
	cases := map[string]string{
		"POST /api/v1/locations":                "GET, HEAD",
		"PUT /api/v1/tenants/t-1":               "GET, HEAD, PATCH, DELETE",
		"DELETE /api/v1/models":                 "GET, HEAD, POST",
		"POST /api/v1/models/ai-grid-models/m1": "GET, HEAD, PATCH, DELETE",
	}
	for req, allow := range cases {
		t.Run(req, func(t *testing.T) {
			method, path, _ := strings.Cut(req, " ")
			rec := serve(app, asUser(method, path))
			if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != allow {
				t.Fatalf("%d Allow=%q, want 405 Allow=%q", rec.Code, rec.Header().Get("Allow"), allow)
			}
			if body := decodeError(t, rec); body.Error.Code != "405" || !strings.Contains(body.Error.Message, allow) {
				t.Errorf("body %+v, want code 405 and a message naming %q", body, allow)
			}
		})
	}
	if rec := serve(app, asUser(http.MethodPost, "/api/v1/nope")); rec.Code != http.StatusNotFound || rec.Header().Get("Allow") != "" {
		t.Errorf("unknown path: %d %v", rec.Code, rec.Header())
	}
}

// HEAD is GET without the body: open on /user and /config like GET, so the
// provider-admin check doesn't refuse a viewer's HEAD that its GET passes.
func TestHeadUserAndConfigAreOpenLikeGet(t *testing.T) {
	t.Parallel()
	denied := newTestAppWithHub(t, testConfig(t), nil, &fakeHub{allowed: false})
	if rec := serve(denied, asUser(http.MethodHead, "/api/v1/config")); rec.Code != http.StatusOK {
		t.Errorf("HEAD /config by a non-admin: %d", rec.Code)
	}
	if rec := serve(denied, asUser(http.MethodHead, "/api/v1/user")); rec.Code != http.StatusOK {
		t.Errorf("HEAD /user by a non-admin: %d", rec.Code)
	}
	if rec := serve(denied, asUser(http.MethodHead, "/api/v1/tenants")); rec.Code != http.StatusForbidden {
		t.Errorf("HEAD /tenants by a non-admin: %d, want 403", rec.Code)
	}
}

// Tenants and models refuse a negative or repeated offset or limit as they
// refuse a repeated filter.
func TestListQueryParameters(t *testing.T) {
	t.Parallel()
	app := newTestApp(t, testConfig(t), &backendtest.Fake{Tenants: seedTenants()})
	for _, path := range []string{
		"/api/v1/tenants?offset=-1",
		"/api/v1/tenants?offset=1&offset=2",
		"/api/v1/tenants?limit=1&limit=1",
		"/api/v1/models?limit=5&limit=10",
	} {
		rec := serve(app, asUser(http.MethodGet, path))
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("GET %s: %d %s, want 422", path, rec.Code, rec.Body.String())
		}
	}
	for _, path := range []string{"/api/v1/tenants", "/api/v1/tenants?offset=0&limit=10"} {
		if rec := serve(app, asUser(http.MethodGet, path)); rec.Code != http.StatusOK {
			t.Errorf("GET %s: %d %s", path, rec.Code, rec.Body.String())
		}
	}
}

func TestUserFromProxyHeaders(t *testing.T) {
	t.Parallel()
	cfg := testConfig(t)
	h := &fakeHub{allowed: true}
	var u User
	rec := serve(newTestAppWithHub(t, cfg, nil, h), asUser(http.MethodGet, "/api/v1/user"))
	decodeData(t, rec, &u)
	if u.Username != "alice" || u.Email != "alice@example.com" || len(u.Groups) != 2 || !u.IsProviderAdmin {
		t.Fatalf("user = %+v", u)
	}
	if h.lastAuth() != "Bearer sha256~token" {
		t.Fatalf("the access review must carry the caller's own token, got %q", h.lastAuth())
	}

	rec = serve(newTestAppWithHub(t, cfg, nil, &fakeHub{allowed: false}), asUser(http.MethodGet, "/api/v1/user"))
	decodeData(t, rec, &u)
	if u.IsProviderAdmin {
		t.Fatal("the hub denied patch on managedclusters; alice is not a provider admin")
	}

	rec = serve(newTestAppWithHub(t, cfg, nil, &fakeHub{status: http.StatusUnauthorized}), asUser(http.MethodGet, "/api/v1/user"))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expired token should give 401, got %d %s", rec.Code, rec.Body.String())
	}

	rec = serve(newTestAppWithHub(t, cfg, nil, &fakeHub{status: http.StatusBadGateway}), asUser(http.MethodGet, "/api/v1/user"))
	if rec.Code != http.StatusBadGateway || decodeError(t, rec).Error.Message == "" {
		t.Fatalf("hub failure should give 502 with a message, got %d %s", rec.Code, rec.Body.String())
	}
}

// A proxy header with a name outside ASCII (an OpenShift group `équipe-ops`)
// used to make every backend call 502: grpc-go refuses such metadata values.
func TestNonASCIIIdentityReachesTheBackend(t *testing.T) {
	t.Parallel()
	fake := &backendtest.Fake{Tenants: []*aigridv1.Tenant{{Id: "t-1", Name: "acme"}}}
	app := newTestApp(t, testConfig(t), fake)
	req := asUser(http.MethodGet, "/api/v1/tenants")
	req.Header.Set(config.DefaultAuthUserHeader, "rené")
	req.Header.Set(config.DefaultAuthGroupsHeader, "équipe-ops,cluster-admins")
	rec := serve(app, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /tenants as rené in équipe-ops: %d %s", rec.Code, rec.Body.String())
	}
	if got := fake.Metadata.Get("x-forwarded-user"); len(got) != 1 || got[0] != "ren%C3%A9" {
		t.Fatalf("x-forwarded-user = %q, want it percent-encoded", got)
	}
	if got := fake.Metadata.Get("x-forwarded-groups"); len(got) != 1 || got[0] != "%C3%A9quipe-ops,cluster-admins" {
		t.Fatalf("x-forwarded-groups = %q", got)
	}
}

func TestOnlyProviderAdminsReachTheAPI(t *testing.T) {
	t.Parallel()
	cfg := testConfig(t)
	patch := func() *http.Request {
		return withIfMatch(jsonRequest(http.MethodPatch, "/api/v1/tenants/t-1", `{"description":"Acme Robotics"}`), `"1"`)
	}
	fake := &backendtest.Fake{Tenants: seedTenants()}
	denied := newTestAppWithHub(t, cfg, fake, &fakeHub{allowed: false})
	for _, req := range []*http.Request{patch(), asUser(http.MethodGet, "/api/v1/models"), asUser(http.MethodGet, "/api/v1/tenants")} {
		rec := serve(denied, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s %s by a non-admin: got %d %s, want 403", req.Method, req.URL.Path, rec.Code, rec.Body.String())
		}
		// The same words for a read and a write: who the console is for, not
		// the one verb the check asks about.
		if got := decodeError(t, rec).Error.Message; got != "this console is only for provider admins, users who may patch ManagedClusters on the hub, and the hub says you are not one" {
			t.Fatalf("%s %s by a non-admin: message %q", req.Method, req.URL.Path, got)
		}
	}
	if fake.Metadata != nil {
		t.Fatalf("a refused call must not reach the backend: %v", fake.Metadata)
	}
	// Who the caller is stays answerable, so the UI can say why.
	for _, path := range []string{"/api/v1/user", "/api/v1/config"} {
		if rec := serve(denied, asUser(http.MethodGet, path)); rec.Code != http.StatusOK {
			t.Fatalf("GET %s by a non-admin: got %d %s", path, rec.Code, rec.Body.String())
		}
	}
	if rec := serve(newTestApp(t, cfg, fake), patch()); rec.Code != http.StatusOK {
		t.Fatalf("PATCH by a provider admin: got %d %s", rec.Code, rec.Body.String())
	}
	if rec := serve(newTestAppWithHub(t, cfg, fake, &fakeHub{status: http.StatusUnauthorized}), patch()); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expired token: got %d, want 401", rec.Code)
	}
}

func TestConfigEndpoint(t *testing.T) {
	t.Parallel()
	cfg := testConfig(t)
	cfg.GridEndpoint = "https://grid.example.com"
	var out ConsoleConfig
	decodeData(t, serve(newTestApp(t, cfg, nil), asUser(http.MethodGet, "/api/v1/config")), &out)
	if out.GridEndpoint != cfg.GridEndpoint || out.Version != Version {
		t.Fatalf("config = %+v", out)
	}
}

// overview reads the clusters of GET /api/v1/grid/overview: the Monitoring
// fallback, the one route that still maps ManagedClusters (toGridCluster).
func overview(t *testing.T, app *App) (*httptest.ResponseRecorder, []GridCluster) {
	t.Helper()
	rec := serve(app, asUser(http.MethodGet, "/api/v1/grid/overview?metrics=false"))
	if rec.Code != http.StatusOK {
		t.Fatalf("overview: %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Clusters []GridCluster `json:"clusters"`
	}
	decodeData(t, rec, &body)
	return rec, body.Clusters
}

func TestClusterGPUsPassThrough(t *testing.T) {
	t.Parallel()
	sharing := &aigridv1.GPUSharing{Strategy: "time-slicing", Replicas: 4}
	member := map[string]string{LabelEnabled: "true"}
	fake := &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{
		{Name: "gpu", ResourceVersion: "1", Labels: member, Status: &aigridv1.ManagedClusterStatus{
			Capacity: map[string]string{"nvidia.com/gpu": "8"},
			Gpus: &aigridv1.ClusterGPUs{
				Total: 2, NodeCount: 2,
				Configurations: []*aigridv1.GPUConfiguration{{Vendor: "NVIDIA", Product: "NVIDIA-L4-SHARED", MemoryMib: 23034, GpusPerNode: 1, NodeCount: 2, Sharing: sharing}},
				Nodes: []*aigridv1.GPUNode{{Name: "n1", Vendor: "NVIDIA", Product: "NVIDIA-L4-SHARED", Count: 1, MemoryMib: 23034,
					Family: "ada-lovelace", ComputeCapability: "8.9", DriverVersion: "580.105.08", CudaRuntimeVersion: "13.0",
					Sharing: sharing, InstanceType: "g6.xlarge", Ready: true}},
			},
		}},
		{Name: "cpu", ResourceVersion: "1", Labels: member},
	}}
	rec, clusters := overview(t, newTestApp(t, testConfig(t), fake))
	for _, want := range []string{
		`"gpuCapacity":8`,
		`"gpus":{"total":2,"nodeCount":2,"configurations":[{"vendor":"NVIDIA","product":"NVIDIA-L4-SHARED","memoryMib":23034,"gpusPerNode":1,"nodeCount":2,"sharing":{"strategy":"time-slicing","replicas":4,"migCapable":false}}]`,
		`"nodes":[{"name":"n1","vendor":"NVIDIA","product":"NVIDIA-L4-SHARED","count":1,"memoryMib":23034,"family":"ada-lovelace","computeCapability":"8.9","driverVersion":"580.105.08","cudaRuntimeVersion":"13.0","sharing":{"strategy":"time-slicing","replicas":4,"migCapable":false},"instanceType":"g6.xlarge","ready":true}]`,
	} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("missing %s in %s", want, rec.Body.String())
		}
	}
	if len(clusters) != 2 || clusters[1].Name != "cpu" || clusters[1].GPUs != nil {
		t.Errorf("a cluster without an inventory has gpus: %+v", clusters)
	}
}

func TestTenantsFromBackend(t *testing.T) {
	t.Parallel()
	fake := &backendtest.Fake{Tenants: []*aigridv1.Tenant{
		{Id: "2", Name: "tenant-b", Domains: []string{"b.example.com"}},
		{Id: "1", Name: "tenant-a"},
	}}
	var out []Tenant
	rec := serve(newTestApp(t, testConfig(t), fake), asUser(http.MethodGet, "/api/v1/tenants"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	decodeData(t, rec, &out)
	if len(out) != 2 || out[0].Name != "tenant-a" || out[0].Domains == nil || out[1].Domains[0] != "b.example.com" {
		t.Fatalf("tenants = %+v", out)
	}
}

// A hub slower than the access review's timeout is the hub's failure (502
// with the hub message), not the backend's 504; a slow backend stays 504.
func TestSlowHubIs502AndSlowBackendIs504(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer slow.Close()
	defer close(release) // before Close, which waits for the handler
	hubClient, err := hub.New(hub.Config{URL: slow.URL, Timeout: 50 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp(testConfig(t), slog.New(slog.DiscardHandler), backendtest.Start(t, &backendtest.Fake{}), hubClient)
	for _, path := range []string{"/api/v1/user", "/api/v1/tenants"} {
		rec := serve(app, asUser(http.MethodGet, path))
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("GET %s with a slow hub: %d %s, want 502", path, rec.Code, rec.Body.String())
		}
		if got := decodeError(t, rec).Error.Message; got != "the hub could not confirm the caller's permissions; try again" {
			t.Fatalf("GET %s with a slow hub: message %q", path, got)
		}
	}

	fake := &backendtest.Fake{Err: backendtest.Status(codes.DeadlineExceeded, "slow")}
	rec := serve(newTestApp(t, testConfig(t), fake), asUser(http.MethodGet, "/api/v1/tenants"))
	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("slow backend: %d %s, want 504", rec.Code, rec.Body.String())
	}
}

// The request line and the handler's own line ("cluster updated") say which
// request and which admin, so an audit can tell who changed what; the token
// never reaches the log.
func TestLogsNameTheRequestAndTheUser(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	fake := &backendtest.Fake{Tenants: seedTenants()}
	app := NewApp(testConfig(t), slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelInfo})), backendtest.Start(t, fake), startHub(t, &fakeHub{allowed: true}))

	rec := serve(app, withIfMatch(jsonRequest(http.MethodPatch, "/api/v1/tenants/t-1", `{"description":"Acme Robotics"}`), `"1"`))
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH: %d %s", rec.Code, rec.Body.String())
	}
	id := rec.Header().Get("X-Request-Id")
	var request, updated string
	for line := range strings.SplitSeq(logs.String(), "\n") {
		switch {
		case strings.Contains(line, "msg=request "):
			request = line
		case strings.Contains(line, `msg="tenant updated"`):
			updated = line
		}
	}
	for what, line := range map[string]string{"request line": request, "handler line": updated} {
		if !strings.Contains(line, "id="+id) || !strings.Contains(line, "user=alice") {
			t.Errorf("%s = %q, want id=%s and user=alice", what, line, id)
		}
	}
	if strings.Contains(logs.String(), "sha256~token") {
		t.Fatalf("the token reached the log:\n%s", logs.String())
	}

	// A request refused before the identity is known has no user.
	logs.Reset()
	serve(app, httptest.NewRequest(http.MethodGet, "/api/v1/tenants", nil))
	if !strings.Contains(logs.String(), "msg=request ") || strings.Contains(logs.String(), "user=") {
		t.Errorf("anonymous request: %q", logs.String())
	}
}

// The kubelet's probes log at Debug when they succeed (thousands of lines a
// day); a failed probe is still a request line at Info.
func TestSuccessfulProbesLogAtDebug(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	fake := &backendtest.Fake{}
	app := NewApp(testConfig(t), slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelInfo})), backendtest.Start(t, fake), startHub(t, &fakeHub{allowed: true}))
	for _, path := range []string{"/readyz", "/healthcheck"} {
		if rec := serve(app, httptest.NewRequest(http.MethodGet, path, nil)); rec.Code != http.StatusOK {
			t.Fatalf("%s: %d", path, rec.Code)
		}
	}
	if logs.Len() != 0 {
		t.Fatalf("successful probes logged at Info:\n%s", logs.String())
	}
	fake.Err = backendtest.Status(codes.Unavailable, "down")
	serve(app, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if !strings.Contains(logs.String(), "msg=request ") || !strings.Contains(logs.String(), "status=503") || !strings.Contains(logs.String(), `"backend not ready"`) {
		t.Fatalf("a failed probe must still log:\n%s", logs.String())
	}
}

// A 501 is an expected answer from a backend that lacks the RPC (the shipped
// one has no Grid service): the frontend shows "not available on this backend
// yet", so the detail logs at Debug, as a 4xx does, not at Error on every page
// load. A backend failure still logs at Error. Either way the request line
// stays at Info.
func TestNotImplementedLogsAtDebugAndFailuresAtError(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	lines := func(level string) []string {
		var out []string
		for line := range strings.SplitSeq(logs.String(), "\n") {
			if strings.Contains(line, "level="+level+" ") {
				out = append(out, line)
			}
		}
		return out
	}

	shipped := NewApp(testConfig(t), logger, backendtest.StartV1(t, &backendtest.V1{}), startHub(t, &fakeHub{allowed: true}))
	if rec := serve(shipped, asUser(http.MethodGet, "/api/v1/grid/overview")); rec.Code != http.StatusNotImplemented {
		t.Fatalf("overview on the shipped backend: %d %s, want 501", rec.Code, rec.Body.String())
	}
	if got := lines("ERROR"); len(got) != 0 {
		t.Errorf("a 501 logged at Error:\n%s", strings.Join(got, "\n"))
	}
	if got := lines("DEBUG"); len(got) != 1 || !strings.Contains(got[0], "status=501") || !strings.Contains(got[0], "code = Unimplemented") {
		t.Errorf("Debug lines = %q, want one with status=501 and the backend's error", got)
	}
	if got := lines("INFO"); len(got) != 1 || !strings.Contains(got[0], "msg=request ") || !strings.Contains(got[0], "status=501") {
		t.Errorf("Info lines = %q, want the request line with status=501", got)
	}

	logs.Reset()
	fake := &backendtest.Fake{Err: backendtest.Status(codes.Internal, "boom")}
	failing := NewApp(testConfig(t), logger, backendtest.Start(t, fake), startHub(t, &fakeHub{allowed: true}))
	if rec := serve(failing, asUser(http.MethodGet, "/api/v1/grid/overview")); rec.Code != http.StatusBadGateway {
		t.Fatalf("overview on a failing backend: %d %s, want 502", rec.Code, rec.Body.String())
	}
	if got := lines("ERROR"); len(got) != 1 || !strings.Contains(got[0], `msg="request failed"`) || !strings.Contains(got[0], "status=502") {
		t.Errorf("Error lines = %q, want one request failed with status=502", got)
	}
}

func TestPanicBecomes500(t *testing.T) {
	t.Parallel()
	app := newTestApp(t, testConfig(t), nil)
	h := app.recoverPanic(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestAbortedAnswerIsNotA500(t *testing.T) {
	t.Parallel()
	app := newTestApp(t, testConfig(t), nil)
	h := app.recoverPanic(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) }))
	rec := httptest.NewRecorder()
	defer func() {
		if got, _ := recover().(error); !errors.Is(got, http.ErrAbortHandler) {
			t.Fatalf("recovered %v, want http.ErrAbortHandler passed on to net/http", got)
		}
		if rec.Code == http.StatusInternalServerError {
			t.Fatal("wrote a 500 over an aborted answer")
		}
	}()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	t.Fatal("recoverPanic swallowed http.ErrAbortHandler")
}

func TestClassify(t *testing.T) {
	t.Parallel()
	cases := []struct {
		err  error
		want int
	}{
		{Errorf(http.StatusTeapot, "x"), http.StatusTeapot},
		{context.DeadlineExceeded, http.StatusGatewayTimeout},
		{fmt.Errorf("%w: provider-admin check: %w", errHub, context.DeadlineExceeded), http.StatusBadGateway},
		{backendtest.Status(codes.InvalidArgument, "x"), http.StatusUnprocessableEntity},
		{backendtest.Status(codes.AlreadyExists, "x"), http.StatusConflict},
		{backendtest.Status(codes.FailedPrecondition, "x"), http.StatusPreconditionFailed},
		{backendtest.Status(codes.ResourceExhausted, "x"), http.StatusTooManyRequests},
		{backendtest.Status(codes.DeadlineExceeded, "x"), http.StatusGatewayTimeout},
		{errors.New("plain"), http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.err.Error(), func(t *testing.T) {
			if got, _ := classify(tc.err); got != tc.want {
				t.Errorf("classify(%v) = %d, want %d", tc.err, got, tc.want)
			}
		})
	}
}

func TestSPAHandler(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>index</html>"), 0o644))
	must(os.WriteFile(filepath.Join(dir, "favicon.svg"), []byte("<svg/>"), 0o644))
	must(os.MkdirAll(filepath.Join(dir, "assets"), 0o755))
	// Names from a real `vite build`: the hash is base64url, so it may hold
	// upper case, `-` and `_`, and a name may have a double `-`.
	assets := []string{
		"index-yimuxjpv.js", "index-BPyNsiKc.css", "index--abzHtFK.js",
		"RedHatDisplayVF-D7m-OdR-.woff2", "ne_110m_land-BX_3ioGi.js", "ne_110m_land-BX_3ioGi.js.map",
	}
	for _, name := range assets {
		must(os.WriteFile(filepath.Join(dir, "assets", name), []byte("asset"), 0o644))
	}

	cfg := testConfig(t)
	cfg.StaticAssetsDir = dir
	h := newTestApp(t, cfg, nil).Handler()

	get := func(p string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		return rec
	}
	secure := func(what string, rec *httptest.ResponseRecorder) {
		t.Helper()
		for header, want := range map[string]string{
			"Content-Security-Policy": "frame-ancestors 'none'",
			"X-Frame-Options":         "DENY",
			"X-Content-Type-Options":  "nosniff",
			"Referrer-Policy":         "same-origin",
		} {
			if got := rec.Header().Get(header); got != want {
				t.Errorf("%s: %s = %q, want %q", what, header, got, want)
			}
		}
	}
	for _, route := range []string{"/", "/clusters/local-cluster", "/subscriptions/view/engineering"} {
		rec := get(route)
		if rec.Code != 200 || rec.Body.String() != "<html>index</html>" {
			t.Fatalf("%s -> %d %q", route, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("%s: Cache-Control = %q, want no-cache: index.html names the current bundle", route, got)
		}
		secure(route, rec)
	}
	for _, name := range assets {
		rec := get("/assets/" + name)
		if rec.Code != 200 || rec.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
			t.Errorf("asset %s -> %d %q, want immutable", name, rec.Code, rec.Header().Get("Cache-Control"))
		}
		secure(name, rec)
	}
	if rec := get("/favicon.svg"); rec.Code != 200 || rec.Header().Get("Cache-Control") != "no-cache" {
		t.Errorf("a root file -> %d %q, want no-cache: its name has no hash", rec.Code, rec.Header().Get("Cache-Control"))
	}
	if rec := get("/assets/missing.js"); rec.Code != 404 {
		t.Fatalf("missing asset -> %d", rec.Code)
	}
	// The JSON API is not a page: nosniff, but no frame or referrer policy of the SPA.
	rec := serve(newTestApp(t, cfg, nil), asUser(http.MethodGet, "/api/v1/config"))
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" || rec.Header().Get("Content-Security-Policy") != "" {
		t.Errorf("API headers = %v", rec.Header())
	}
	raw := httptest.NewRequest(http.MethodGet, "/", nil)
	raw.URL.Path = "/../../etc/passwd"
	rec = httptest.NewRecorder()
	newSPAHandler(dir).ServeHTTP(rec, raw)
	if rec.Code != 200 || rec.Body.String() != "<html>index</html>" {
		t.Fatalf("traversal should be cleaned to a client route, got %d %q", rec.Code, rec.Body.String())
	}
}

func richCluster() *aigridv1.ManagedCluster {
	ltt := timestamppb.New(time.Date(2026, 10, 1, 9, 0, 8, 0, time.UTC))
	return &aigridv1.ManagedCluster{
		Name: "site-paris-1", HubAcceptsClient: true, ResourceVersion: "41",
		Labels: map[string]string{
			LabelEnabled: "true", LabelProvisioned: "true", LabelLocation: "paris", LabelSite: "paris-dc1", LabelRegion: "europe-west",
			LabelOpenShiftVersion: "4.22.15", LabelAddonPrefix + "work-manager": "available", LabelAddonPrefix + "cluster-proxy": "unreachable",
		},
		Annotations: map[string]string{AnnotationSiteName: "Paris DC1", AnnotationLatitude: "48.8566", AnnotationLongitude: "2.3522"},
		Status: &aigridv1.ManagedClusterStatus{
			State: aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE, StateMessage: "Managed cluster is available",
			KubernetesVersion: "v1.35.6",
			Capacity:          map[string]string{"cpu": "192", CapacityGPU: "16"},
			ClusterClaims: []*aigridv1.ClusterClaim{
				{Name: ClaimConsoleURL, Value: "https://console-openshift-console.apps.site-paris-1.example.com"},
				{Name: ClaimPlatform, Value: "BareMetal"}, {Name: ClaimProduct, Value: "OpenShift"},
			},
			Conditions: []*aigridv1.Condition{
				{Type: "ManagedClusterConditionAvailable", Status: aigridv1.ConditionStatus_CONDITION_STATUS_TRUE, Reason: proto.String("ManagedClusterAvailable"), Message: proto.String("Managed cluster is available"), LastTransitionTime: ltt},
				{Type: "ManagedClusterConditionClockSynced", Status: aigridv1.ConditionStatus_CONDITION_STATUS_UNSPECIFIED, LastTransitionTime: ltt},
			},
		},
	}
}

func TestGridClusterCarriesTheDerivedFields(t *testing.T) {
	t.Parallel()
	fake := &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{richCluster()}}
	rec, clusters := overview(t, newTestApp(t, testConfig(t), fake))
	if len(clusters) != 1 {
		t.Fatalf("clusters = %+v", clusters)
	}
	c := clusters[0]
	if c.Status != StatusReady || c.StatusMessage != "Managed cluster is available" {
		t.Errorf("status = %q %q", c.Status, c.StatusMessage)
	}
	if c.ConsoleURL != "https://console-openshift-console.apps.site-paris-1.example.com" || c.Platform != "BareMetal" || c.Product != "OpenShift" || c.KubernetesVersion != "v1.35.6" {
		t.Errorf("claims = %+v", c)
	}
	if c.GPUCapacity != 16 {
		t.Errorf("gpuCapacity = %d", c.GPUCapacity)
	}
	if c.SiteName != "Paris DC1" || c.Latitude == nil || *c.Latitude != 48.8566 || c.Longitude == nil || *c.Longitude != 2.3522 {
		t.Errorf("site = %q %v %v", c.SiteName, c.Latitude, c.Longitude)
	}
	if len(c.Addons) != 2 || c.Addons["work-manager"] != "available" || c.Addons["cluster-proxy"] != "unreachable" {
		t.Errorf("addons = %v", c.Addons)
	}
	byType := map[string]ClusterCondition{}
	for _, cond := range c.Conditions {
		byType[cond.Type] = cond
	}
	avail, clock := byType["ManagedClusterConditionAvailable"], byType["ManagedClusterConditionClockSynced"]
	if len(c.Conditions) != 2 || avail.Status != "True" || avail.Reason != "ManagedClusterAvailable" || avail.LastTransitionTime == nil || avail.LastTransitionTime.IsZero() || clock.Status != "Unknown" {
		t.Errorf("conditions = %+v", c.Conditions)
	}
	if c.ResourceVersion != "41" {
		t.Errorf("resourceVersion = %q", c.ResourceVersion)
	}
	// Raw JSON: the state names are the ACM console's.
	if !strings.Contains(rec.Body.String(), `"status":"ready"`) || !strings.Contains(rec.Body.String(), `"gpuCapacity":16`) {
		t.Errorf("body = %s", rec.Body.String())
	}
}

// TestConditionWithoutTransitionTimeIsOmitted: an unset proto timestamp is
// the Unix epoch through AsTime; the JSON must not present 1970 as observed.
func TestConditionWithoutTransitionTimeIsOmitted(t *testing.T) {
	t.Parallel()
	mc := richCluster()
	mc.Status.Conditions = append(mc.Status.Conditions, &aigridv1.Condition{Type: "Deleting", Status: aigridv1.ConditionStatus_CONDITION_STATUS_FALSE, Reason: proto.String("ResourceRemaining")})
	rec, _ := overview(t, newTestApp(t, testConfig(t), &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{mc}}))
	if strings.Contains(rec.Body.String(), "1970-01-01") {
		t.Errorf("an absent transition time is rendered as the epoch: %s", rec.Body.String())
	}
	var raw struct {
		Data struct {
			Clusters []struct {
				Conditions []map[string]json.RawMessage `json:"conditions"`
			} `json:"clusters"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw.Data.Clusters) != 1 || len(raw.Data.Clusters[0].Conditions) != 3 {
		t.Fatalf("clusters = %+v", raw.Data.Clusters)
	}
	conditions := raw.Data.Clusters[0].Conditions
	if _, has := conditions[0]["lastTransitionTime"]; !has {
		t.Error("a recorded transition time must be present")
	}
	if ts, has := conditions[2]["lastTransitionTime"]; has {
		t.Errorf("an unset transition time must be omitted, got %s", ts)
	}
}

// TestCoordinatesMustBeFinite: ParseFloat accepts NaN and Inf, which JSON
// cannot encode; one such annotation must not break the overview.
func TestCoordinatesMustBeFinite(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		in   string
		want *float64
	}{
		{"NaN", nil}, {"nan", nil}, {"Inf", nil}, {"+Inf", nil}, {"-Infinity", nil}, {"1e400", nil}, {"91", nil}, {"", nil}, {"x", nil},
		{" 48.8566 ", ptr(48.8566)}, {"-90", ptr(-90)},
	} {
		got := parseCoordinate(tc.in, 90)
		switch {
		case got == nil && tc.want == nil:
		case got == nil || tc.want == nil || *got != *tc.want:
			t.Errorf("parseCoordinate(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
	bad := richCluster()
	bad.Name = "site-bad-1"
	bad.Annotations = map[string]string{AnnotationLatitude: "NaN", AnnotationLongitude: "+Inf"}
	_, clusters := overview(t, newTestApp(t, testConfig(t), &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{richCluster(), bad}}))
	if len(clusters) != 2 || clusters[0].Latitude == nil || clusters[1].Latitude != nil || clusters[1].Longitude != nil || clusters[1].Annotations[AnnotationLatitude] != "NaN" {
		t.Errorf("clusters = %+v", clusters)
	}
}

func ptr(f float64) *float64 { return &f }

// TestWriteJSONFailureIs500: encoding happens before the status is committed,
// so a value JSON cannot carry is an error response, not a 200 with no body.
func TestWriteJSONFailureIs500(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	writeData(rec, http.StatusOK, math.NaN())
	if rec.Code != http.StatusInternalServerError || decodeError(t, rec).Error.Code != "500" {
		t.Errorf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	writeData(rec, http.StatusOK, []int{1})
	if rec.Code != http.StatusOK || rec.Body.String() != "{\"data\":[1]}\n" {
		t.Errorf("status = %d body = %q", rec.Code, rec.Body.String())
	}
}

func TestStateStrings(t *testing.T) {
	t.Parallel()
	cases := map[aigridv1.ManagedClusterState]string{
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNSPECIFIED:    "",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE:      "ready",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNAVAILABLE:    "offline",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_UNKNOWN:        "unknown",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_PENDING_IMPORT: "pendingimport",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_IMPORTING:      "importing",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_IMPORT_FAILED:  "importfailed",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_DETACHING:      "detaching",
		aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_NOT_ACCEPTED:   "notaccepted",
	}
	for state, want := range cases {
		t.Run(state.String(), func(t *testing.T) {
			mc := &aigridv1.ManagedCluster{Name: "x", Status: &aigridv1.ManagedClusterStatus{State: state}}
			if got := toGridCluster(mc).Status; got != want {
				t.Errorf("status %q, want %q", got, want)
			}
		})
	}
	// A cluster from today's backend (fields 1-3 only) has no status and no annotations but valid JSON maps.
	c := toGridCluster(&aigridv1.ManagedCluster{Name: "bare"})
	if c.Status != "" || c.Addons == nil || c.Conditions == nil || c.Labels == nil || c.Annotations == nil || c.Latitude != nil {
		t.Errorf("bare = %+v", c)
	}
	if lat := toGridCluster(&aigridv1.ManagedCluster{Annotations: map[string]string{AnnotationLatitude: "north"}}).Latitude; lat != nil {
		t.Errorf("invalid latitude must be omitted, got %v", *lat)
	}
	// A backend that reports provisioning decides it over the ai-grid/provisioned
	// label. NonCompliant isn't failed: the cluster may still be installing.
	stale := map[string]string{LabelEnabled: "true", LabelProvisioned: "true"}
	for value, want := range map[string]bool{"Compliant": true, "NonCompliant": false, "Pending": false, "": false} {
		c := toGridCluster(&aigridv1.ManagedCluster{Labels: stale, Status: &aigridv1.ManagedClusterStatus{Provisioning: &value}})
		if c.Provisioned != want {
			t.Errorf("provisioning %q -> provisioned %v, want %v", value, c.Provisioned, want)
		}
	}
}

// withIfMatch sets the If-Match header every PATCH and DELETE must carry.
func withIfMatch(req *http.Request, v string) *http.Request {
	req.Header.Set("If-Match", v)
	return req
}

// Every write is refused with 415 unless its body is declared JSON, before
// anything reaches the backend: a cross-site form or a text/plain fetch,
// which a browser sends without a CORS preflight, cannot create or change
// anything.
func TestWritesRequireJSONContentType(t *testing.T) {
	t.Parallel()
	writes := []struct{ method, path, body string }{
		{http.MethodPost, "/api/v1/tenants", `{"name": "evil"}`},
		{http.MethodPatch, "/api/v1/tenants/t-1", `{"enabled": false}`},
		{http.MethodPost, "/api/v1/models", `{"name": "m", "namespace": "ns", "modelUri": "hf://x/y"}`},
		{http.MethodPatch, "/api/v1/models/ai-grid-models/tiny-llm", `{"replicas": 2}`},
	}
	for _, ct := range []string{"", "text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", "application/merge-patch+json", "json", "application/json;;"} {
		for _, wr := range writes {
			fake := &backendtest.Fake{Tenants: seedTenants(), Models: seedModels()}
			app := newTestApp(t, testConfig(t), fake)
			req := jsonRequest(wr.method, wr.path, wr.body)
			if ct == "" {
				req.Header.Del("Content-Type")
			} else {
				req.Header.Set("Content-Type", ct)
			}
			rec := serve(app, req)
			if rec.Code != http.StatusUnsupportedMediaType {
				t.Errorf("%s %s with Content-Type %q -> %d %s, want 415", wr.method, wr.path, ct, rec.Code, rec.Body.String())
				continue
			}
			if e := decodeError(t, rec); e.Error.Code != "415" || e.Error.Message != "request body must be JSON: send Content-Type: application/json" {
				t.Errorf("415 body = %+v", e)
			}
			if len(fake.Calls) != 0 {
				t.Errorf("%s %s with %q reached the backend: %v", wr.method, wr.path, ct, fake.Calls)
			}
		}
	}
	// application/json in any case, with parameters, is accepted.
	for _, ct := range []string{"application/json", "application/json; charset=utf-8", "Application/JSON"} {
		fake := &backendtest.Fake{Tenants: seedTenants()}
		app := newTestApp(t, testConfig(t), fake)
		req := jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "ok"}`)
		req.Header.Set("Content-Type", ct)
		if rec := serve(app, req); rec.Code != http.StatusCreated {
			t.Errorf("Content-Type %q -> %d %s, want 201", ct, rec.Code, rec.Body.String())
		}
	}
	// A DELETE has no body to check.
	fake := &backendtest.Fake{Tenants: seedTenants()}
	if rec := serve(newTestApp(t, testConfig(t), fake), withIfMatch(asUser(http.MethodDelete, "/api/v1/tenants/t-1"), `"1"`)); rec.Code != http.StatusNoContent {
		t.Errorf("DELETE without a Content-Type -> %d", rec.Code)
	}
}

// Every PATCH and DELETE needs If-Match: without it the answer is 428 before
// the body is read and before any backend call. The 415 content-type check
// comes first (TestWritesRequireJSONContentType sends no If-Match and gets
// 415), the 428 next, the body decoding last.
func TestWritesRequireIfMatch(t *testing.T) {
	t.Parallel()
	const want = `this write needs an If-Match header: send the ETag that GET answered (the object's resourceVersion), for example If-Match: "42"`
	writes := []struct{ method, path, body string }{
		{http.MethodPatch, "/api/v1/tenants/t-1", `{"enabled": false}`},
		{http.MethodDelete, "/api/v1/tenants/t-1", ""},
		{http.MethodPatch, "/api/v1/models/ai-grid-models/tiny-llm", `{"replicas": 2}`},
		{http.MethodDelete, "/api/v1/models/ai-grid-models/tiny-llm", ""},
		// A body that would be 422 is 428 first, an unknown object too.
		{http.MethodPatch, "/api/v1/models/ai-grid-models/tiny-llm", `{"colour": "red"}`},
		{http.MethodPatch, "/api/v1/tenants/missing", `null`},
		{http.MethodDelete, "/api/v1/models/ai-grid-models/missing", ""},
	}
	for _, wr := range writes {
		fake := &backendtest.Fake{Tenants: seedTenants(), Models: seedModels()}
		req := asUser(wr.method, wr.path)
		if wr.body != "" {
			req = jsonRequest(wr.method, wr.path, wr.body)
		}
		rec := serve(newTestApp(t, testConfig(t), fake), req)
		if e := decodeError(t, rec); rec.Code != http.StatusPreconditionRequired || e.Error.Code != "428" || e.Error.Message != want || len(fake.Calls) != 0 {
			t.Errorf("%s %s %s without If-Match = %d %+v, calls %v; want 428 and no call", wr.method, wr.path, wr.body, rec.Code, e, fake.Calls)
		}
	}
}

func TestListMeta(t *testing.T) {
	t.Parallel()
	n := func(v int) *int { return &v }
	for _, tc := range []struct {
		name          string
		offset, limit *int
		size          int
		total         *int32
		want          string
	}{
		{"backend count wins", n(10), n(10), 10, proto.Int32(25), `{"size":10,"total":25,"offset":10,"limit":10}`},
		{"zero is a count", nil, n(0), 0, proto.Int32(0), `{"size":0,"total":0,"offset":0,"limit":0}`},
		{"no count, everything", nil, nil, 8, nil, `{"size":8,"total":8,"offset":0}`},
		{"no count, a short page ends the list", n(10), n(10), 5, nil, `{"size":5,"total":15,"offset":10,"limit":10}`},
		{"no count, a full page leaves the total unknown", n(10), n(10), 10, nil, `{"size":10,"offset":10,"limit":10}`},
	} {
		b, err := json.Marshal(listMeta(tc.offset, tc.limit, tc.size, tc.total))
		if err != nil || string(b) != tc.want {
			t.Errorf("%s: %s, want %s (%v)", tc.name, b, tc.want, err)
		}
	}
}

func TestFieldErrorsReachTheBody(t *testing.T) {
	t.Parallel()
	st := status.New(codes.InvalidArgument, "The organization is invalid.")
	st, _ = st.WithDetails(&errdetails.BadRequest{FieldViolations: []*errdetails.BadRequest_FieldViolation{
		{Field: "identityProvider.config.issuer", Description: "Enter a valid HTTP or HTTPS URL."},
	}})
	fake := &backendtest.Fake{Err: st.Err()}
	app := newTestApp(t, testConfig(t), fake)
	rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants"))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status %d", rec.Code)
	}
	body := decodeError(t, rec)
	if body.Error.FieldErrors["identityProvider.config.issuer"] != "Enter a valid HTTP or HTTPS URL." {
		t.Fatalf("fieldErrors %+v", body.Error.FieldErrors)
	}
}

// Field violations on any status other than InvalidArgument stay in the log;
// the browser gets the mapped message only.
func TestFieldErrorsOnlyForInvalidArgument(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		code codes.Code
		want int
	}{
		{codes.Internal, http.StatusBadGateway},
		{codes.FailedPrecondition, http.StatusPreconditionFailed},
		{codes.NotFound, http.StatusNotFound},
	} {
		t.Run(tc.code.String(), func(t *testing.T) {
			st, err := status.New(tc.code, "backend detail").WithDetails(&errdetails.BadRequest{FieldViolations: []*errdetails.BadRequest_FieldViolation{
				{Field: "internal.secret", Description: "must not leak"},
			}})
			if err != nil {
				t.Fatal(err)
			}
			app := newTestApp(t, testConfig(t), &backendtest.Fake{Err: st.Err()})
			rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants"))
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d", rec.Code, tc.want)
			}
			if got := decodeError(t, rec).Error.FieldErrors; got != nil {
				t.Fatalf("fieldErrors %+v, want none", got)
			}
			if strings.Contains(rec.Body.String(), "fieldErrors") || strings.Contains(rec.Body.String(), "must not leak") {
				t.Fatalf("body leaks field violations: %s", rec.Body)
			}
		})
	}
}

func TestConfigReportsFakeBackend(t *testing.T) {
	t.Parallel()
	cfg := testConfig(t)
	cfg.FakeBackend = true
	app := newTestApp(t, cfg, &backendtest.Fake{})
	var got ConsoleConfig
	decodeData(t, serve(app, asUser(http.MethodGet, "/api/v1/config")), &got)
	if !got.FakeBackend {
		t.Fatal("fakeBackend not reported")
	}
}

// TestConfigReportsModelsNamespace: /config names the namespace the console
// creates models in, MODELS_NAMESPACE.
func TestConfigReportsModelsNamespace(t *testing.T) {
	t.Parallel()
	cfg := testConfig(t)
	cfg.ModelsNamespace = "team-models"
	var got ConsoleConfig
	decodeData(t, serve(newTestApp(t, cfg, &backendtest.Fake{}), asUser(http.MethodGet, "/api/v1/config")), &got)
	if got.ModelsNamespace != "team-models" {
		t.Fatalf("modelsNamespace = %q", got.ModelsNamespace)
	}
}

// TestBFFForwardsWhatItDecodes: the BFF validates nothing. A tenant with a
// blank name reaches the backend unchanged, and the backend's InvalidArgument
// with a BadRequest comes back as 422 with its fieldErrors.
func TestBFFForwardsWhatItDecodes(t *testing.T) {
	t.Parallel()
	st, err := status.New(codes.InvalidArgument, "String must contain at least 1 character(s)").WithDetails(&errdetails.BadRequest{
		FieldViolations: []*errdetails.BadRequest_FieldViolation{{Field: "name", Description: "String must contain at least 1 character(s)"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	fake := &backendtest.Fake{Errs: map[string]error{"CreateTenant": st.Err()}}
	app := newTestApp(t, testConfig(t), fake)
	rec := serve(app, jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name": "   ", "domains": []}`))
	if got := fake.LastCreateTenant.GetObject().GetName(); got != "   " {
		t.Fatalf("forwarded name %q", got)
	}
	if rec.Code != http.StatusUnprocessableEntity || decodeError(t, rec).Error.FieldErrors["name"] != "String must contain at least 1 character(s)" {
		t.Fatalf("backend's field errors: %d %s", rec.Code, rec.Body)
	}
}

// member is an AI Grid member cluster at site, Available, with the state the
// backend derives from that.
func member(name, site string) *aigridv1.ManagedCluster {
	return &aigridv1.ManagedCluster{Name: name, Labels: map[string]string{LabelEnabled: "true", LabelSite: site},
		Status: &aigridv1.ManagedClusterStatus{
			State:      aigridv1.ManagedClusterState_MANAGED_CLUSTER_STATE_AVAILABLE,
			Conditions: []*aigridv1.Condition{{Type: "ManagedClusterConditionAvailable", Status: aigridv1.ConditionStatus_CONDITION_STATUS_TRUE}},
		}}
}

func TestGridOverview(t *testing.T) {
	t.Parallel()
	msg := "No enrolled clusters match this selection."
	fake := &backendtest.Fake{
		Clusters: []*aigridv1.ManagedCluster{member("site3", "brussels"), member("site1", "san-francisco"),
			{Name: "site4", Labels: map[string]string{LabelSite: "sydney"}}},
		Metrics: []*aigridv1.Metric{
			{Key: "requests", Label: "Gateway request rate", Unit: "req/s", Status: aigridv1.MetricStatus_METRIC_STATUS_OK,
				Points: []*aigridv1.MetricPoint{{Timestamp: 1790000000, Value: 355.669}}},
			{Key: "errors", Label: "Gateway error rate", Unit: "req/s", Status: aigridv1.MetricStatus_METRIC_STATUS_UNAVAILABLE},
			{Key: "latency", Label: "Gateway p95 latency", Unit: "ms", Status: aigridv1.MetricStatus_METRIC_STATUS_NOT_CONFIGURED},
			{Key: "gpu", Label: "GPU utilization", Unit: "%", Status: aigridv1.MetricStatus_METRIC_STATUS_NO_DATA, Message: &msg},
		},
		OverviewTime: timestamppb.New(time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)),
	}
	app := newTestApp(t, testConfig(t), fake)
	get := func(query string) *httptest.ResponseRecorder {
		return serve(app, asUser(http.MethodGet, "/api/v1/grid/overview"+query))
	}

	// The PoC's GridOverview: members only, lowercase sources, demo false.
	rec := get("?range=6h")
	if rec.Code != http.StatusOK {
		t.Fatalf("overview: %d %s", rec.Code, rec.Body)
	}
	var raw map[string]any
	decodeData(t, rec, &raw)
	clusters, _ := raw["clusters"].([]any)
	delete(raw, "clusters")
	want := map[string]any{
		"updatedAt": "2026-10-16T09:00:00.000Z", "inventorySource": "acm", "demo": false, "metricsSource": "demo",
		"metrics": []any{
			map[string]any{"key": "requests", "label": "Gateway request rate", "unit": "req/s", "status": "ok",
				"points": []any{map[string]any{"timestamp": float64(1790000000), "value": 355.669}}},
			map[string]any{"key": "errors", "label": "Gateway error rate", "unit": "req/s", "status": "unavailable", "points": []any{}},
			map[string]any{"key": "latency", "label": "Gateway p95 latency", "unit": "ms", "status": "not-configured", "points": []any{}},
			map[string]any{"key": "gpu", "label": "GPU utilization", "unit": "%", "status": "no-data", "message": msg, "points": []any{}},
		},
	}
	if !reflect.DeepEqual(raw, want) {
		t.Fatalf("overview\n got %v\nwant %v", raw, want)
	}
	var overview struct{ Clusters []GridCluster }
	decodeData(t, rec, &overview)
	// The clusters keep the backend's order.
	if len(clusters) != 2 || overview.Clusters[0].Name != "site3" || overview.Clusters[1].Name != "site1" ||
		overview.Clusters[0].Status != StatusReady || overview.Clusters[0].Site != "brussels" || !overview.Clusters[0].AIGridEnabled {
		t.Fatalf("clusters %+v", overview.Clusters)
	}
	if r := fake.LastOverview; r.GetRange() != "6h" || r.Site != nil || !r.GetIncludeMetrics() {
		t.Fatalf("request %v", r)
	}

	// No range is forwarded as none (the backend defaults it); site filters;
	// metrics=false leaves them out.
	rec = get("?site=brussels&metrics=false")
	decodeData(t, rec, &overview)
	if rec.Code != http.StatusOK || len(overview.Clusters) != 1 || overview.Clusters[0].Name != "site3" ||
		!strings.Contains(rec.Body.String(), `"metrics":[]`) {
		t.Fatalf("brussels without metrics: %d %s", rec.Code, rec.Body)
	}
	if r := fake.LastOverview; r.GetRange() != "" || r.GetSite() != "brussels" || r.GetIncludeMetrics() {
		t.Fatalf("request %v", r)
	}

	// The range is the backend's to check: it's forwarded as given, and the
	// backend's InvalidArgument is 422 with its message.
	fake.Errs = map[string]error{"GetOverview": status.Error(codes.InvalidArgument, "Choose a time range of 1h, 6h, or 24h.")}
	rec = get("?range=2h")
	if rec.Code != http.StatusUnprocessableEntity || decodeError(t, rec).Error.Message != "Choose a time range of 1h, 6h, or 24h." || fake.LastOverview.GetRange() != "2h" {
		t.Fatalf("2h: %d %s %v", rec.Code, rec.Body, fake.LastOverview)
	}
	fake.Errs = nil

	// An unspecified enum leaves its key out instead of being guessed.
	if got := toGridOverview(&aigridv1.GetOverviewResponse{Metrics: []*aigridv1.Metric{{Key: "requests"}}}); got.InventorySource != "" || got.MetricsSource != "" || got.Metrics[0].Status != "" {
		t.Fatalf("unspecified enums %+v", got)
	}
	raw2, err := json.Marshal(toGridOverview(&aigridv1.GetOverviewResponse{Metrics: []*aigridv1.Metric{{Key: "requests"}}}))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw2), "inventorySource") || strings.Contains(string(raw2), "metricsSource") || strings.Contains(string(raw2), "status") {
		t.Fatalf("unspecified enums: %s", raw2)
	}
}

// TestGridOverviewDropsNonFinitePoints: JSON can't carry NaN or Inf, so the
// BFF leaves those points out and keeps the rest; the series' status stays
// the backend's (thin-BFF rule).
func TestGridOverviewDropsNonFinitePoints(t *testing.T) {
	t.Parallel()
	got := toGridOverview(&aigridv1.GetOverviewResponse{Metrics: []*aigridv1.Metric{{Key: "requests", Status: aigridv1.MetricStatus_METRIC_STATUS_OK,
		Points: []*aigridv1.MetricPoint{{Timestamp: 1, Value: math.NaN()}, {Timestamp: 2, Value: 3}, {Timestamp: 3, Value: math.Inf(1)}, {Timestamp: 4, Value: math.Inf(-1)}}}}})
	if m := got.Metrics[0]; !reflect.DeepEqual(m.Points, []MetricPoint{{Timestamp: 2, Value: 3}}) || m.Status != "ok" {
		t.Fatalf("metric %+v", m)
	}
	if _, err := json.Marshal(got); err != nil {
		t.Fatal(err)
	}
}

// TestGridOverviewOmitsUpdatedAtTheBackendDidNotSend: the BFF doesn't invent
// an updated time (thin-BFF rule); the key is left out.
func TestGridOverviewOmitsUpdatedAtTheBackendDidNotSend(t *testing.T) {
	t.Parallel()
	app := newTestApp(t, testConfig(t), &backendtest.Fake{OverviewTime: nil})
	rec := serve(app, asUser(http.MethodGet, "/api/v1/grid/overview"))
	if rec.Code != http.StatusOK {
		t.Fatalf("overview: %d %s", rec.Code, rec.Body)
	}
	var raw map[string]any
	decodeData(t, rec, &raw)
	if _, ok := raw["updatedAt"]; ok {
		t.Fatalf("updatedAt invented: %s", rec.Body)
	}
}
