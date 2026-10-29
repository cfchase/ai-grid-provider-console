package examples

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/test/bufconn"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/api"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/config"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/fakebackend"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/hub"
)

var update = flag.Bool("update", false, "rewrite mock/examples from the current BFF and fake backend")

const (
	fixturesDir = "../../../mock/fixtures"
	examplesDir = "../../../mock/examples"
)

// scenarioStart is the fixed wall-clock time the fake's scenario clock starts
// from and stays at, so condition times, creation stamps of the live model and
// every derived status are the same on every run.
var scenarioStart = time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)

// caller is who sends a request, as kube-auth-proxy (or the Vite dev proxy
// under make dev-fake) would set the identity headers.
type caller struct{ token, user string }

var (
	admin   = caller{"dev-token", "dev-user"}
	viewer  = caller{"viewer-token", "viewer"}
	expired = caller{"expired-token", "expired"}
)

// example is one golden file: a request and the BFF's answer. A body is
// sent as application/json unless header sets another Content-Type.
type example struct {
	file   string
	method string
	path   string
	body   string
	header map[string]string
	as     caller
}

var examples = []example{
	{file: "get-user.json", method: http.MethodGet, path: "/api/v1/user", as: admin},
	{file: "get-config.json", method: http.MethodGet, path: "/api/v1/config", as: admin},
	{file: "get-tenants.json", method: http.MethodGet, path: "/api/v1/tenants", as: admin},
	{file: "get-tenant.json", method: http.MethodGet, path: "/api/v1/tenants/3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c", as: admin},
	{file: "get-models.json", method: http.MethodGet, path: "/api/v1/models", as: admin},
	{file: "get-model.json", method: http.MethodGet, path: "/api/v1/models/ai-grid-models/mistral-7b-instruct", as: admin},
	{file: "get-capabilities.json", method: http.MethodGet, path: "/api/v1/capabilities", as: admin},
	{file: "get-grid-overview.json", method: http.MethodGet, path: "/api/v1/grid/overview?range=1h", as: admin},
	{file: "get-locations.json", method: http.MethodGet, path: "/api/v1/locations", as: admin},
	{file: "post-tenant.json", method: http.MethodPost, path: "/api/v1/tenants", body: `{"name": "hooli-cloud", "description": "Hooli, US region", "domains": ["hooli.example.com"]}`, as: admin},
	{file: "post-model.json", method: http.MethodPost, path: "/api/v1/models", body: `{"name": "granite-3b-code", "namespace": "ai-grid-models", "modelUri": "hf://example-org/granite-3b-code", "replicas": 1, "cpu": "4", "memory": "16Gi", "annotations": {"openshift.io/display-name": "Granite 3B Code"}}`, as: admin},
	{file: "error-401-expired-token.json", method: http.MethodGet, path: "/api/v1/user", as: expired},
	{file: "error-403-viewer-patch.json", method: http.MethodPatch, path: "/api/v1/tenants/3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c", body: `{"description": "Acme Robotics, EU"}`, header: map[string]string{"If-Match": `"1"`}, as: viewer},
	{file: "error-404-unknown-tenant.json", method: http.MethodGet, path: "/api/v1/tenants/unknown-tenant", as: admin},
	{file: "error-409-stale-if-match.json", method: http.MethodPatch, path: "/api/v1/tenants/3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c", body: `{"description": "Acme Robotics, EU"}`, header: map[string]string{"If-Match": `"7"`}, as: admin},
	{file: "error-428-missing-if-match.json", method: http.MethodPatch, path: "/api/v1/tenants/3f1c9a72-5b6e-4d2a-8c01-2d3e4f5a6b7c", body: `{"enabled": false}`, as: admin},
	{file: "error-415-not-json.json", method: http.MethodPost, path: "/api/v1/tenants", body: `{"name": "from-a-form"}`, header: map[string]string{"Content-Type": "text/plain"}, as: admin},
}

// recordedHeaders are the response headers a golden file keeps.
var recordedHeaders = []string{"ETag", "Location"}

// golden is the file format: the request line, its headers beyond the
// identity ones, who sent it, the status code, the ETag and Location
// response headers when set, and the response body exactly as the BFF
// encoded it (re-indented).
type golden struct {
	Request         string            `json:"request"`
	RequestHeaders  map[string]string `json:"requestHeaders,omitempty"`
	RequestBody     json.RawMessage   `json:"requestBody,omitempty"`
	Token           string            `json:"token"`
	User            string            `json:"user"`
	Status          int               `json:"status"`
	ResponseHeaders map[string]string `json:"responseHeaders,omitempty"`
	Body            json.RawMessage   `json:"body,omitempty"`
}

// TestGoldenResponses renders every example on a BFF and fake of its own,
// loaded from the fixtures, so a write never changes what another example
// records.
func TestGoldenResponses(t *testing.T) {
	want := map[string]bool{}
	for _, ex := range examples {
		want[ex.file] = true
		t.Run(strings.TrimSuffix(ex.file, ".json"), func(t *testing.T) {
			got := render(t, newApp(t), ex)
			path := filepath.Join(examplesDir, ex.file)
			if *update {
				if err := os.WriteFile(path, got, 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			old, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("%v; run `make -C bff golden` to create it", err)
			}
			if !bytes.Equal(old, got) {
				t.Errorf("mock/examples/%s is out of date (%s); if the change is intended, run `make -C bff golden` and review the diff.\n%s",
					ex.file, ex.method+" "+ex.path, firstDifference(old, got))
			}
		})
	}
	entries, err := os.ReadDir(examplesDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".json" || want[e.Name()] {
			continue
		}
		if *update {
			if err := os.Remove(filepath.Join(examplesDir, e.Name())); err != nil {
				t.Fatal(err)
			}
			continue
		}
		t.Errorf("mock/examples/%s is not produced by any example; run `make -C bff golden` to remove it", e.Name())
	}
}

// newApp builds the BFF against the fake backend over bufconn and the fake hub
// over httptest, both from mock/fixtures, with a frozen clock, no latency and
// deterministic id and work-name generators.
func newApp(t *testing.T) *api.App {
	t.Helper()
	logger := slog.New(slog.DiscardHandler)
	fx, err := fakebackend.Load(fixturesDir)
	if err != nil {
		t.Fatal(err)
	}
	fake, err := fakebackend.New(fx, logger)
	if err != nil {
		t.Fatal(err)
	}
	fake.Latency = 0
	fake.SetClock(func() time.Time { return scenarioStart })
	ids := 0
	fake.SetIDGenerator(func() string { ids++; return fmt.Sprintf("00000000-0000-4000-8000-%012d", ids) })
	works := 0
	fake.SetWorkSuffixGenerator(func() string { works++; return fmt.Sprintf("g%04d", works) })

	lis := bufconn.Listen(1 << 20)
	srv := grpc.NewServer()
	fake.Register(srv)
	go func() { _ = srv.Serve(lis) }()
	client, err := backend.Dial(backend.Config{Address: "passthrough:///bufconn", Insecure: true, DraftAPI: true},
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }))
	if err != nil {
		t.Fatal(err)
	}
	hubSrv := httptest.NewServer(fakebackend.NewHub(fx.Access, logger).Handler())
	t.Cleanup(func() {
		_ = client.Close()
		srv.Stop()
		hubSrv.Close()
	})
	hubClient, err := hub.New(hub.Config{URL: hubSrv.URL})
	if err != nil {
		t.Fatal(err)
	}
	// No environment, so the files do not depend on the shell that ran the
	// test. Every setting is its default except the models namespace, which
	// `make run-fake` sets for the fake backend's fixtures.
	cfg, err := config.Parse([]string{"--hub-api-url=" + hubSrv.URL, "--models-namespace=ai-grid-models"}, func(string) (string, bool) { return "", false })
	if err != nil {
		t.Fatal(err)
	}
	return api.NewApp(cfg, logger, client, hubClient)
}

func render(t *testing.T, app *api.App, ex example) []byte {
	t.Helper()
	req := httptest.NewRequest(ex.method, ex.path, strings.NewReader(ex.body))
	if ex.body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range ex.header {
		req.Header.Set(k, v)
	}
	req.Header.Set(config.DefaultAuthTokenHeader, ex.as.token)
	req.Header.Set(config.DefaultAuthUserHeader, ex.as.user)
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, req)

	g := golden{Request: ex.method + " " + ex.path, RequestHeaders: ex.header, Token: ex.as.token, User: ex.as.user, Status: rec.Code}
	if ex.body != "" {
		g.RequestBody = json.RawMessage(ex.body)
	}
	for _, h := range recordedHeaders {
		if v := rec.Header().Get(h); v != "" {
			if g.ResponseHeaders == nil {
				g.ResponseHeaders = map[string]string{}
			}
			g.ResponseHeaders[h] = v
		}
	}
	if rec.Body.Len() > 0 {
		if !json.Valid(rec.Body.Bytes()) {
			t.Fatalf("%s: response is not JSON: %q", g.Request, rec.Body.String())
		}
		g.Body = json.RawMessage(rec.Body.Bytes())
	}
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(g); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// firstDifference shows the first line where the committed file and the
// current response differ, with a little context, so a failure says what
// changed without a diff tool.
func firstDifference(old, got []byte) string {
	a, b := strings.Split(string(old), "\n"), strings.Split(string(got), "\n")
	for i := 0; i < len(a) || i < len(b); i++ {
		var la, lb string
		if i < len(a) {
			la = a[i]
		}
		if i < len(b) {
			lb = b[i]
		}
		if la == lb {
			continue
		}
		from := max(i-2, 0)
		var s strings.Builder
		fmt.Fprintf(&s, "first difference at line %d:\n", i+1)
		for j := from; j < i; j++ {
			fmt.Fprintf(&s, "    %s\n", a[j])
		}
		fmt.Fprintf(&s, "  - %s\n  + %s", la, lb)
		return s.String()
	}
	return "files differ only in trailing bytes"
}
