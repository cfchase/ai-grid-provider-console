package api

// Verification tests for the PR 12 review comments. Each test passes when the
// reviewer's claim is NOT true; a failure confirms the claim.

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/test/bufconn"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/emptypb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend/backendtest"
)

// Comment 2: a text/plain body should not reach a write handler.
func TestVerifyC2TextPlainPostRejected(t *testing.T) {
	fake := &backendtest.Fake{Tenants: seedTenants()}
	app := newTestApp(t, testConfig(t), fake)
	req := jsonRequest(http.MethodPost, "/api/v1/tenants", `{"name":"evil","alias":"="}`)
	req.Header.Set("Content-Type", "text/plain")
	rec := serve(app, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("text/plain POST /tenants: status = %d, CreateTenant reached = %v", rec.Code, fake.Reached("CreateTenant"))
	}
}

// Comment 3: a PATCH carrying the version the user loaded (If-Match) should
// get 409 when the stored model is newer.
func TestVerifyC3StaleTabClusterPatch(t *testing.T) {
	fake := &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", ResourceVersion: "9", Labels: map[string]string{LabelLocation: "paris"}}}}
	app := newTestApp(t, testConfig(t), fake)
	req := patchRequest("site-1", `{"location":"rome"}`)
	req.Header.Set("If-Match", `"3"`) // the tab loaded version 3; the hub has 9
	rec := serve(app, req)
	if rec.Code != http.StatusConflict {
		t.Errorf("stale cluster PATCH: status = %d, update locked on %q", rec.Code, fake.LastUpdate.GetObject().GetResourceVersion())
	}
}

// Comment 9: sending back the alias the console displayed must not be 422.
func TestVerifyC9DisplayedAliasRoundTrip(t *testing.T) {
	fake := &backendtest.Fake{Tenants: []*aigridv1.Tenant{{Id: "t-9", Name: "noalias"}}}
	app := newTestApp(t, testConfig(t), fake)
	var shown Tenant
	rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants/t-9"))
	decodeData(t, rec, &shown)
	rec = serve(app, jsonRequest(http.MethodPatch, "/api/v1/tenants/t-9", `{"alias":"`+shown.Alias+`"}`))
	if rec.Code != http.StatusOK {
		t.Errorf("shown alias %q sent back: status = %d %s", shown.Alias, rec.Code, rec.Body.String())
	}
}

// Comment 8: resending the current values must not call UpdateManagedCluster.
func TestVerifyC8NoOpClusterPatchDoesNotWrite(t *testing.T) {
	fake := &backendtest.Fake{Clusters: []*aigridv1.ManagedCluster{{Name: "site-1", ResourceVersion: "7",
		Labels: map[string]string{LabelEnabled: "true", LabelLocation: "paris"}}}}
	app := newTestApp(t, testConfig(t), fake)
	rec := serve(app, patchRequest("site-1", `{"aiGridEnabled": true, "location": "paris"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s", rec.Code, rec.Body.String())
	}
	if fake.Reached("UpdateManagedCluster") {
		t.Errorf("unchanged values still wrote; version now %s", fake.Clusters[0].GetResourceVersion())
	}
}

// noCountTenants is a backend that pages but does not fill `total`.
type noCountTenants struct {
	aigridv1.UnimplementedTenantsServer
	all []*aigridv1.Tenant
	// ignoreRequest serves like the shipped backend: filter, offset and
	// limit are unknown fields there and are dropped.
	ignoreRequest bool
}

func (s *noCountTenants) ListTenants(_ context.Context, req *aigridv1.ListTenantsRequest) (*aigridv1.ListTenantsResponse, error) {
	if s.ignoreRequest {
		return &aigridv1.ListTenantsResponse{Tenants: s.all}, nil
	}
	page := s.all[min(int(req.GetOffset()), len(s.all)):]
	if req.Limit != nil && int(req.GetLimit()) < len(page) {
		page = page[:req.GetLimit()]
	}
	return &aigridv1.ListTenantsResponse{Tenants: page}, nil
}

func appWithTenants(t *testing.T, srv aigridv1.TenantsServer) *App {
	t.Helper()
	lis := bufconn.Listen(1 << 20)
	g := grpc.NewServer()
	aigridv1.RegisterTenantsServer(g, srv)
	go func() { _ = g.Serve(lis) }()
	client, err := backend.Dial(backend.Config{Address: "passthrough:///bufconn", Insecure: true},
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close(); g.Stop() })
	return NewApp(testConfig(t), slog.New(slog.DiscardHandler), client, startHub(t, &fakeHub{allowed: true}))
}

func manyTenants(n int) []*aigridv1.Tenant {
	out := make([]*aigridv1.Tenant, n)
	for i := range out {
		out[i] = &aigridv1.Tenant{Id: "t", Name: string(rune('a'+i)) + "-org"}
	}
	return out
}

// Comment 7: total must not be smaller than offset+size.
func TestVerifyC7TotalFallbackIgnoresOffset(t *testing.T) {
	app := appWithTenants(t, &noCountTenants{all: manyTenants(25)})
	var list []Tenant
	rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants?offset=10&limit=10"))
	meta := decodeList(t, rec, &list)
	if meta.Total < meta.Offset+meta.Size {
		t.Errorf("meta = %+v: total %d < offset+size %d", meta, meta.Total, meta.Offset+meta.Size)
	}
}

// Comment 6, part 1: the BFF's request decodes without error into the
// shipped backend's empty ListTenantsRequest, so filter/offset/limit are
// silently dropped (proto3 unknown fields).
func TestVerifyC6WireDropsFilter(t *testing.T) {
	b, err := proto.Marshal(&aigridv1.ListTenantsRequest{Filter: proto.String(searchFilter("acme")), Offset: proto.Int32(5), Limit: proto.Int32(5)})
	if err != nil {
		t.Fatal(err)
	}
	var upstream emptypb.Empty // same shape as upstream `message ListTenantsRequest {}`
	if err := proto.Unmarshal(b, &upstream); err != nil {
		t.Logf("upstream rejects it: %v", err)
		return
	}
	t.Errorf("upstream accepts the request and drops %d bytes of filter/offset/limit as unknown fields", len(upstream.ProtoReflect().GetUnknown()))
}

// Comment 6, part 2: against a backend that drops them, the BFF answers 200
// with every tenant as the search result.
func TestVerifyC6SearchIgnoredIsNot200(t *testing.T) {
	app := appWithTenants(t, &noCountTenants{all: manyTenants(8), ignoreRequest: true})
	var list []Tenant
	rec := serve(app, asUser(http.MethodGet, "/api/v1/tenants?search=zzz&limit=5"))
	if rec.Code == http.StatusOK {
		meta := decodeList(t, rec, &list)
		t.Errorf("search=zzz&limit=5 on a backend that ignores it: 200 with %d tenants, meta %+v", len(list), meta)
	}
}

var _ = io.EOF
var _ = strings.TrimSpace
