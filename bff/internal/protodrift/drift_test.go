// Package protodrift proves that the BFF's copy of the backend's messages
// (mock/proto/ai_grid/backend/v1, compiled into bff/gen/ai_grid/backend/v1) still matches
// the backend's real proto (mock/proto/upstream, vendored from
// ai-grid-cloud/ai-grid-provider-backend), and that the RPCs the BFF calls still exist and
// still take and return what the BFF sends and reads, field for field on the wire: the ones
// bff/internal/backend/v1.go calls by path, and AiGrid/Ping, which /readyz calls through the
// draft's client.
//
// The copy is a stopgap: the BFF calls the backend's ai_grid.v1 Tenants
// and Models services while the rest of the console still speaks the draft. Protobuf is wire
// compatible across package names, so a copied field that the backend renumbers, retypes
// or drops would silently send or read the wrong data. hack/sync-upstream-proto.sh
// refreshes the vendored copy (nightly in .github/workflows/drift.yaml) and this test
// fails on every such difference. Fields the backend has and the copy lacks are fine: the
// BFF doesn't use them.
//
// When the console generates its types from the backend's proto (Connect, docs/adr), the
// copy goes, and this package, mock/proto/upstream and drift.yaml go with it.
package protodrift

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"

	backendv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/backend/v1"
	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

const (
	upstreamDir     = "../../../mock/proto/upstream"
	upstreamImage   = "image.binpb"
	upstreamPackage = "ai_grid.v1"
	copyPackage     = "ai_grid.backend.v1"
)

// calls are the backend RPCs the BFF invokes, with the messages it sends and reads: its
// copy's for the ones in bff/internal/backend/v1.go, the draft's for Ping. Their names may
// differ from the backend's (AiGridPingRequest); their fields may not.
// TestCallsMatchTheBFF keeps this list in step with the code.
var calls = []struct {
	method        string
	input, output protoreflect.FullName
}{
	{"ai_grid.v1.AiGrid.Ping", "ai_grid.v1.PingRequest", "ai_grid.v1.PingResponse"},
	{"ai_grid.v1.Tenants.List", "ai_grid.backend.v1.TenantsListRequest", "ai_grid.backend.v1.TenantsListResponse"},
	{"ai_grid.v1.Tenants.Get", "ai_grid.backend.v1.TenantsGetRequest", "ai_grid.backend.v1.TenantsGetResponse"},
	{"ai_grid.v1.Tenants.Create", "ai_grid.backend.v1.TenantsCreateRequest", "ai_grid.backend.v1.TenantsCreateResponse"},
	{"ai_grid.v1.Tenants.Update", "ai_grid.backend.v1.TenantsUpdateRequest", "ai_grid.backend.v1.TenantsUpdateResponse"},
	{"ai_grid.v1.Tenants.Delete", "ai_grid.backend.v1.TenantsDeleteRequest", "ai_grid.backend.v1.TenantsDeleteResponse"},
	{"ai_grid.v1.Models.List", "ai_grid.backend.v1.ModelsListRequest", "ai_grid.backend.v1.ModelsListResponse"},
	{"ai_grid.v1.Models.Get", "ai_grid.backend.v1.ModelsGetRequest", "ai_grid.backend.v1.ModelsGetResponse"},
	{"ai_grid.v1.Models.Create", "ai_grid.backend.v1.ModelsCreateRequest", "ai_grid.backend.v1.ModelsCreateResponse"},
	{"ai_grid.v1.Models.Update", "ai_grid.backend.v1.ModelsUpdateRequest", "ai_grid.backend.v1.ModelsUpdateResponse"},
	{"ai_grid.v1.Models.Delete", "ai_grid.backend.v1.ModelsDeleteRequest", "ai_grid.backend.v1.ModelsDeleteResponse"},
	{"ai_grid.v1.Models.ListPlacementClusters", "ai_grid.backend.v1.ModelsListPlacementClustersRequest", "ai_grid.backend.v1.ModelsListPlacementClustersResponse"},
}

// TestCallsMatchTheBFF fails when the BFF calls a backend method that calls doesn't list,
// or stops calling one it does: the method paths in bff/internal/backend/v1.go, plus Ping.
func TestCallsMatchTheBFF(t *testing.T) {
	t.Parallel()
	src, err := os.ReadFile("../backend/v1.go")
	if err != nil {
		t.Fatal(err)
	}
	called := map[string]bool{strings.ReplaceAll(strings.TrimPrefix(aigridv1.AiGrid_Ping_FullMethodName, "/"), "/", "."): true}
	for _, m := range regexp.MustCompile(`"/(ai_grid\.v1\.\w+)/(\w+)"`).FindAllStringSubmatch(string(src), -1) {
		called[m[1]+"."+m[2]] = true
	}
	listed := map[string]bool{}
	for _, c := range calls {
		listed[c.method] = true
		if !called[c.method] {
			t.Errorf("calls lists %s, which the BFF doesn't call", c.method)
		}
	}
	for m := range called {
		if !listed[m] {
			t.Errorf("the BFF calls %s, which calls doesn't list: add it with the messages it sends and reads", m)
		}
	}
}

// readImage loads the vendored image: the backend's files and their imports, compiled by buf.
func readImage(t *testing.T) *descriptorpb.FileDescriptorSet {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(upstreamDir, upstreamImage))
	if err != nil {
		t.Fatal(err)
	}
	set := &descriptorpb.FileDescriptorSet{}
	if err := proto.Unmarshal(raw, set); err != nil {
		t.Fatalf("parse %s: %v", upstreamImage, err)
	}
	return set
}

// upstreamFiles resolves an image into its own registry, apart from the draft's ai_grid.v1
// in protoregistry.GlobalFiles, which declares some of the same names.
func upstreamFiles(t *testing.T, set *descriptorpb.FileDescriptorSet) *protoregistry.Files {
	t.Helper()
	files, err := protodesc.NewFiles(set)
	if err != nil {
		t.Fatalf("resolve %s: %v", upstreamImage, err)
	}
	return files
}

// copyFile is the BFF's copy, as linked into the binary.
func copyFile() protoreflect.FileDescriptor {
	return backendv1.File_ai_grid_backend_v1_backend_proto
}

func TestUpstreamCommitIsRecorded(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile(filepath.Join(upstreamDir, "COMMIT"))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		if k, v, ok := strings.Cut(line, "="); ok && !strings.HasPrefix(line, "#") {
			got[k] = v
		}
	}
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(got["commit"]) {
		t.Errorf("COMMIT must record the full git sha of the vendored proto, got %q", got["commit"])
	}
	if got["repo"] != "https://github.com/ai-grid-cloud/ai-grid-provider-backend" {
		t.Errorf("COMMIT must record the backend repository, got %q", got["repo"])
	}
	if got["path"] != "proto/ai_grid/v1" {
		t.Errorf("COMMIT must record the proto directory in the backend repository, got %q", got["path"])
	}
}

// TestCopyMatchesUpstream is the test that fails the day the backend changes a message or
// RPC the BFF uses.
func TestCopyMatchesUpstream(t *testing.T) {
	t.Parallel()
	c := &checker{upstream: upstreamFiles(t, readImage(t))}
	c.check(copyFile())
	for _, diff := range c.diffs {
		t.Error(diff)
	}
	if len(c.diffs) > 0 {
		t.Log("the backend proto in mock/proto/upstream no longer matches the BFF's copy in mock/proto/ai_grid/backend/v1: update the copy and bff/internal/backend/v1.go")
	}
}

// checker compares the copy with an upstream registry and collects differences.
type checker struct {
	upstream *protoregistry.Files
	diffs    []string
}

func (c *checker) errorf(format string, args ...any) {
	c.diffs = append(c.diffs, fmt.Sprintf(format, args...))
}

// upstreamName is the name the backend gives a copied type: same short name, the
// backend's package. Well-known types keep theirs.
func upstreamName(name protoreflect.FullName) protoreflect.FullName {
	if rest, ok := strings.CutPrefix(string(name), copyPackage+"."); ok {
		return protoreflect.FullName(upstreamPackage + "." + rest)
	}
	return name
}

func (c *checker) check(copied protoreflect.FileDescriptor) {
	for _, call := range calls {
		c.checkCall(call.method, call.input, call.output)
	}
	for i := 0; i < copied.Messages().Len(); i++ {
		c.checkMessage(copied.Messages().Get(i))
	}
	for i := 0; i < copied.Enums().Len(); i++ {
		c.checkEnum(copied.Enums().Get(i))
	}
}

func (c *checker) checkCall(method string, input, output protoreflect.FullName) {
	d, err := c.upstream.FindDescriptorByName(protoreflect.FullName(method))
	m, ok := d.(protoreflect.MethodDescriptor)
	if err != nil || !ok {
		c.errorf("the BFF calls %s, which the backend no longer has", method)
		return
	}
	if m.IsStreamingClient() || m.IsStreamingServer() {
		c.errorf("method %s became streaming; the BFF calls it unary", method)
	}
	for _, side := range []struct {
		what string
		up   protoreflect.MessageDescriptor
		bff  protoreflect.FullName
	}{{"takes", m.Input(), input}, {"returns", m.Output(), output}} {
		if upstreamName(side.bff) == side.up.FullName() && strings.HasPrefix(string(side.bff), copyPackage+".") {
			continue // the same copied message, which checkMessage compares
		}
		d, err := protoregistry.GlobalFiles.FindDescriptorByName(side.bff)
		bff, ok := d.(protoreflect.MessageDescriptor)
		if err != nil || !ok {
			c.errorf("method %s: the BFF's message %s isn't linked into the test", method, side.bff)
			continue
		}
		before := len(c.diffs)
		c.compareFields(side.up, bff)
		if len(c.diffs) > before {
			c.diffs = append(c.diffs[:before], append([]string{fmt.Sprintf("method %s %s %s, which no longer matches the BFF's %s:", method, side.what, side.up.FullName(), side.bff)}, c.diffs[before:]...)...)
		}
	}
}

func (c *checker) checkMessage(copied protoreflect.MessageDescriptor) {
	name := upstreamName(copied.FullName())
	d, err := c.upstream.FindDescriptorByName(name)
	up, ok := d.(protoreflect.MessageDescriptor)
	if err != nil || !ok {
		c.errorf("copied message %s has no %s in the backend", copied.FullName(), name)
		return
	}
	c.compareFields(up, copied)
	for i := 0; i < copied.Messages().Len(); i++ {
		if !copied.Messages().Get(i).IsMapEntry() {
			c.checkMessage(copied.Messages().Get(i))
		}
	}
	for i := 0; i < copied.Enums().Len(); i++ {
		c.checkEnum(copied.Enums().Get(i))
	}
}

// compareFields reports every field of the BFF's message that the backend's message no
// longer has with the same number, name, cardinality, presence, oneof and type.
func (c *checker) compareFields(up, copied protoreflect.MessageDescriptor) {
	for i := 0; i < copied.Fields().Len(); i++ {
		cf := copied.Fields().Get(i)
		uf := up.Fields().ByNumber(cf.Number())
		if uf == nil {
			c.errorf("field %s (number %d) is gone from the backend's %s", cf.FullName(), cf.Number(), up.FullName())
			continue
		}
		if uf.Name() != cf.Name() {
			c.errorf("field %d of %s: the backend calls it %q, the copy %q", cf.Number(), up.FullName(), uf.Name(), cf.Name())
		}
		if uf.Cardinality() != cf.Cardinality() {
			c.errorf("field %s: backend cardinality %v, copy %v", uf.FullName(), uf.Cardinality(), cf.Cardinality())
		}
		if uf.HasPresence() != cf.HasPresence() {
			c.errorf("field %s: backend presence (optional) %v, copy %v", uf.FullName(), uf.HasPresence(), cf.HasPresence())
		}
		if uf.IsMap() != cf.IsMap() {
			c.errorf("field %s: backend map %v, copy map %v", uf.FullName(), uf.IsMap(), cf.IsMap())
		} else if uf.IsMap() {
			if uk, ck := typeName(uf.MapKey()), typeName(cf.MapKey()); uk != ck {
				c.errorf("field %s: backend map key %s, copy %s", uf.FullName(), uk, ck)
			}
			if uv, cv := typeName(uf.MapValue()), typeName(cf.MapValue()); uv != cv {
				c.errorf("field %s: backend map value %s, copy %s", uf.FullName(), uv, cv)
			}
			continue
		}
		if uo, co := oneofName(uf), oneofName(cf); uo != co {
			c.errorf("field %s: backend oneof %q, copy oneof %q", uf.FullName(), uo, co)
		}
		if ut, ct := typeName(uf), typeName(cf); ut != ct {
			c.errorf("field %s: backend type %s, copy type %s", uf.FullName(), ut, ct)
		}
	}
}

func (c *checker) checkEnum(copied protoreflect.EnumDescriptor) {
	name := upstreamName(copied.FullName())
	d, err := c.upstream.FindDescriptorByName(name)
	up, ok := d.(protoreflect.EnumDescriptor)
	if err != nil || !ok {
		c.errorf("copied enum %s has no %s in the backend", copied.FullName(), name)
		return
	}
	for i := 0; i < copied.Values().Len(); i++ {
		cv := copied.Values().Get(i)
		uv := up.Values().ByName(cv.Name())
		if uv == nil {
			c.errorf("enum value %s is gone from the backend's %s", cv.Name(), name)
			continue
		}
		if uv.Number() != cv.Number() {
			c.errorf("enum value %s: backend number %d, copy number %d", cv.Name(), uv.Number(), cv.Number())
		}
	}
}

// oneofName is the real oneof a field belongs to, or "" for none. Fields that are merely
// `optional` sit in a synthetic oneof, which HasPresence covers.
func oneofName(f protoreflect.FieldDescriptor) string {
	if o := f.ContainingOneof(); o != nil && !o.IsSynthetic() {
		return string(o.Name())
	}
	return ""
}

// typeName renders a field's type in the backend's names, so a copied message type and
// the backend's compare equal: "string", "message ai_grid.v1.Metadata", "enum ...".
func typeName(f protoreflect.FieldDescriptor) string {
	switch f.Kind() {
	case protoreflect.MessageKind, protoreflect.GroupKind:
		return fmt.Sprintf("message %s", upstreamName(f.Message().FullName()))
	case protoreflect.EnumKind:
		return fmt.Sprintf("enum %s", upstreamName(f.Enum().FullName()))
	default:
		return f.Kind().String()
	}
}

// TestDriftIsDetected guards the guard: each kind of change the backend could make is
// applied to a copy of the vendored image, and the comparison must report it.
func TestDriftIsDetected(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		mutate func(t *testing.T, set *descriptorpb.FileDescriptorSet)
		want   []string // a substring of each expected difference, in order
	}{
		{
			name: "field type changed",
			mutate: func(t *testing.T, set *descriptorpb.FileDescriptorSet) {
				field(t, set, "ModelRouter", "managed_route").Type = descriptorpb.FieldDescriptorProto_TYPE_STRING.Enum()
			},
			want: []string{"ModelRouter.managed_route: backend type string, copy type bool"},
		},
		{
			name: "field renamed in place",
			mutate: func(t *testing.T, set *descriptorpb.FileDescriptorSet) {
				field(t, set, "TenantSpec", "domains").Name = proto.String("hosts")
			},
			want: []string{`field 1 of ai_grid.v1.TenantSpec: the backend calls it "hosts", the copy "domains"`},
		},
		{
			name: "field renumbered",
			mutate: func(t *testing.T, set *descriptorpb.FileDescriptorSet) {
				field(t, set, "Metadata", "version").Number = proto.Int32(18)
			},
			want: []string{"field ai_grid.backend.v1.Metadata.version (number 8) is gone from the backend's ai_grid.v1.Metadata"},
		},
		{
			name: "field became repeated",
			mutate: func(t *testing.T, set *descriptorpb.FileDescriptorSet) {
				field(t, set, "TenantsUpdateRequest", "lock").Label = descriptorpb.FieldDescriptorProto_LABEL_REPEATED.Enum()
			},
			want: []string{"TenantsUpdateRequest.lock: backend cardinality repeated, copy optional"},
		},
		{
			name: "optional field lost its presence",
			mutate: func(t *testing.T, set *descriptorpb.FileDescriptorSet) {
				msg := message(t, set, "TenantsListRequest")
				offset := field(t, set, "TenantsListRequest", "offset")
				if offset.OneofIndex == nil {
					t.Fatal("TenantsListRequest.offset has no synthetic oneof to drop")
				}
				// Drop the synthetic oneof that held it, wherever the backend declares it,
				// and renumber the ones after it.
				dropped := offset.GetOneofIndex()
				offset.Proto3Optional, offset.OneofIndex = nil, nil
				msg.OneofDecl = append(msg.OneofDecl[:dropped], msg.OneofDecl[dropped+1:]...)
				for _, f := range msg.Field {
					if f.OneofIndex != nil && f.GetOneofIndex() > dropped {
						f.OneofIndex = proto.Int32(f.GetOneofIndex() - 1)
					}
				}
			},
			want: []string{"TenantsListRequest.offset: backend presence (optional) false, copy true"},
		},
		{
			name: "message renamed",
			mutate: func(t *testing.T, set *descriptorpb.FileDescriptorSet) {
				msg := message(t, set, "TenantStatus")
				msg.Name = proto.String("TenantState")
				field(t, set, "Tenant", "status").TypeName = proto.String(".ai_grid.v1.TenantState")
			},
			want: []string{
				"field ai_grid.v1.Tenant.status: backend type message ai_grid.v1.TenantState, copy type message ai_grid.v1.TenantStatus",
				"copied message ai_grid.backend.v1.TenantStatus has no ai_grid.v1.TenantStatus in the backend",
			},
		},
		{
			name: "method output changed to a message with other fields",
			mutate: func(t *testing.T, set *descriptorpb.FileDescriptorSet) {
				method(t, set, "Tenants", "Get").OutputType = proto.String(".ai_grid.v1.TenantsListResponse")
			},
			want: []string{
				"method ai_grid.v1.Tenants.Get returns ai_grid.v1.TenantsListResponse, which no longer matches the BFF's ai_grid.backend.v1.TenantsGetResponse:",
				`field 1 of ai_grid.v1.TenantsListResponse: the backend calls it "size", the copy "object"`,
				"field ai_grid.v1.TenantsListResponse.size: backend presence (optional) false, copy true",
				"field ai_grid.v1.TenantsListResponse.size: backend type int32, copy type message ai_grid.v1.Tenant",
			},
		},
		{
			name: "Ping's request changed on the wire",
			mutate: func(t *testing.T, set *descriptorpb.FileDescriptorSet) {
				field(t, set, "AiGridPingRequest", "name").Number = proto.Int32(2)
			},
			want: []string{
				"method ai_grid.v1.AiGrid.Ping takes ai_grid.v1.AiGridPingRequest, which no longer matches the BFF's ai_grid.v1.PingRequest:",
				"field ai_grid.v1.PingRequest.name (number 1) is gone from the backend's ai_grid.v1.AiGridPingRequest",
			},
		},
		{
			name: "method renamed",
			mutate: func(t *testing.T, set *descriptorpb.FileDescriptorSet) {
				method(t, set, "Tenants", "List").Name = proto.String("ListTenants")
			},
			want: []string{"the BFF calls ai_grid.v1.Tenants.List, which the backend no longer has"},
		},
		{
			name: "method became server streaming",
			mutate: func(t *testing.T, set *descriptorpb.FileDescriptorSet) {
				method(t, set, "Tenants", "List").ServerStreaming = proto.Bool(true)
			},
			want: []string{"method ai_grid.v1.Tenants.List became streaming"},
		},
		{
			name: "method became client streaming",
			mutate: func(t *testing.T, set *descriptorpb.FileDescriptorSet) {
				method(t, set, "Tenants", "Update").ClientStreaming = proto.Bool(true)
			},
			want: []string{"method ai_grid.v1.Tenants.Update became streaming"},
		},
		{
			name: "map value type changed",
			mutate: func(t *testing.T, set *descriptorpb.FileDescriptorSet) {
				for _, entry := range message(t, set, "Metadata").NestedType {
					if entry.GetName() == "LabelsEntry" {
						entry.Field[1].Type = descriptorpb.FieldDescriptorProto_TYPE_INT32.Enum()
					}
				}
			},
			want: []string{"field ai_grid.v1.Metadata.labels: backend map value int32, copy string"},
		},
		{
			name: "field moved into a oneof",
			mutate: func(t *testing.T, set *descriptorpb.FileDescriptorSet) {
				msg := message(t, set, "TenantsGetRequest")
				msg.OneofDecl = append(msg.OneofDecl, &descriptorpb.OneofDescriptorProto{Name: proto.String("ref")})
				field(t, set, "TenantsGetRequest", "id").OneofIndex = proto.Int32(int32(len(msg.OneofDecl) - 1))
			},
			// A oneof member also has presence, so the field is reported twice.
			want: []string{
				"field ai_grid.v1.TenantsGetRequest.id: backend presence (optional) true, copy false",
				`field ai_grid.v1.TenantsGetRequest.id: backend oneof "ref", copy oneof ""`,
			},
		},
		{
			name: "additions the BFF doesn't use pass",
			mutate: func(t *testing.T, set *descriptorpb.FileDescriptorSet) {
				status := message(t, set, "ModelPlacementStatus")
				status.Field = append(status.Field, &descriptorpb.FieldDescriptorProto{
					Name: proto.String("site"), Number: proto.Int32(99), JsonName: proto.String("site"),
					Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum(), Type: descriptorpb.FieldDescriptorProto_TYPE_STRING.Enum(),
				})
			},
			want: nil,
		},
	}
	base := readImage(t)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			set := proto.Clone(base).(*descriptorpb.FileDescriptorSet)
			tc.mutate(t, set)
			c := &checker{upstream: upstreamFiles(t, set)}
			c.check(copyFile())
			if len(c.diffs) != len(tc.want) {
				t.Fatalf("want %d difference(s) %q, got %d: %q", len(tc.want), tc.want, len(c.diffs), c.diffs)
			}
			for i, want := range tc.want {
				if !strings.Contains(c.diffs[i], want) {
					t.Errorf("difference %d = %q, want it to mention %q", i, c.diffs[i], want)
				}
			}
		})
	}
}

// message finds a top-level message of the backend's package in an image.
func message(t *testing.T, set *descriptorpb.FileDescriptorSet, name string) *descriptorpb.DescriptorProto {
	t.Helper()
	for _, f := range set.File {
		if f.GetPackage() != upstreamPackage {
			continue
		}
		for _, m := range f.MessageType {
			if m.GetName() == name {
				return m
			}
		}
	}
	t.Fatalf("no message %s in the vendored image; update this case", name)
	return nil
}

func field(t *testing.T, set *descriptorpb.FileDescriptorSet, msg, name string) *descriptorpb.FieldDescriptorProto {
	t.Helper()
	for _, f := range message(t, set, msg).Field {
		if f.GetName() == name {
			return f
		}
	}
	t.Fatalf("no field %s.%s in the vendored image; update this case", msg, name)
	return nil
}

func method(t *testing.T, set *descriptorpb.FileDescriptorSet, service, name string) *descriptorpb.MethodDescriptorProto {
	t.Helper()
	for _, f := range set.File {
		if f.GetPackage() != upstreamPackage {
			continue
		}
		for _, s := range f.Service {
			if s.GetName() != service {
				continue
			}
			for _, m := range s.Method {
				if m.GetName() == name {
					return m
				}
			}
		}
	}
	t.Fatalf("no method %s.%s in the vendored image; update this case", service, name)
	return nil
}
