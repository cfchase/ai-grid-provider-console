package backend

// Stopgap: clients for the backend's real ai_grid.v1
// Tenants and Models RPCs (Models in v1_models.go), behind
// the draft's TenantsClient and ModelsClient interfaces so the
// API handlers are unchanged. The fake backend
// serves the draft, so Dial uses these only for a real backend.

import (
	"context"
	"strconv"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	backendv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/backend/v1"
	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

const (
	methodTenantsList   = "/ai_grid.v1.Tenants/List"
	methodTenantsGet    = "/ai_grid.v1.Tenants/Get"
	methodTenantsCreate = "/ai_grid.v1.Tenants/Create"
	methodTenantsUpdate = "/ai_grid.v1.Tenants/Update"
	methodTenantsDelete = "/ai_grid.v1.Tenants/Delete"

	methodModelsList   = "/ai_grid.v1.Models/List"
	methodModelsGet    = "/ai_grid.v1.Models/Get"
	methodModelsCreate = "/ai_grid.v1.Models/Create"
	methodModelsUpdate = "/ai_grid.v1.Models/Update"
	methodModelsDelete = "/ai_grid.v1.Models/Delete"

	methodModelsListPlacementClusters = "/ai_grid.v1.Models/ListPlacementClusters"
)

// The annotations the backend keeps a model's display name and description in.
const (
	annotationDisplayName = "openshift.io/display-name"
	annotationDescription = "openshift.io/description"
)

type v1Tenants struct{ conn grpc.ClientConnInterface }

var _ aigridv1.TenantsClient = v1Tenants{}

// ListTenants forwards offset, limit and filter. The backend pages but
// doesn't evaluate filter yet, so a filtered answer carries no total and the
// handler refuses it (requireTotal).
func (c v1Tenants) ListTenants(ctx context.Context, in *aigridv1.ListTenantsRequest, opts ...grpc.CallOption) (*aigridv1.ListTenantsResponse, error) {
	req := &backendv1.TenantsListRequest{Offset: in.Offset, Limit: in.Limit, Filter: in.Filter}
	resp := &backendv1.TenantsListResponse{}
	if err := c.conn.Invoke(ctx, methodTenantsList, req, resp, opts...); err != nil {
		return nil, err
	}
	out := &aigridv1.ListTenantsResponse{Size: resp.GetSize()}
	if in.Filter == nil {
		total := resp.GetTotal()
		out.Total = &total
	}
	for _, t := range resp.GetItems() {
		out.Tenants = append(out.Tenants, FromV1Tenant(t))
	}
	return out, nil
}

// GetTenant reads one tenant.
func (c v1Tenants) GetTenant(ctx context.Context, in *aigridv1.GetTenantRequest, opts ...grpc.CallOption) (*aigridv1.GetTenantResponse, error) {
	resp := &backendv1.TenantsGetResponse{}
	if err := c.conn.Invoke(ctx, methodTenantsGet, &backendv1.TenantsGetRequest{Id: in.GetId()}, resp, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.GetTenantResponse{Object: FromV1Tenant(resp.GetObject())}, nil
}

// CreateTenant sends the name and domains, the only fields the backend's
// Tenant has. A request that sets a field it lacks is Unimplemented, not
// dropped. The backend sets the Keycloak alias to the name.
func (c v1Tenants) CreateTenant(ctx context.Context, in *aigridv1.CreateTenantRequest, opts ...grpc.CallOption) (*aigridv1.CreateTenantResponse, error) {
	obj := in.GetObject()
	var unsupported []string
	if obj.GetAlias() != "" && obj.GetAlias() != obj.GetName() {
		unsupported = append(unsupported, "alias")
	}
	if obj.GetDescription() != "" {
		unsupported = append(unsupported, "description")
	}
	if obj.Enabled != nil && !obj.GetEnabled() {
		unsupported = append(unsupported, "enabled")
	}
	if len(obj.GetAttributes()) > 0 {
		unsupported = append(unsupported, "attributes")
	}
	if obj.GetIdentityProvider() != nil {
		unsupported = append(unsupported, "identityProvider")
	}
	if err := notInBackend(unsupported); err != nil {
		return nil, err
	}
	req := &backendv1.TenantsCreateRequest{Object: &backendv1.Tenant{
		Metadata: &backendv1.Metadata{Name: obj.GetName()},
		Spec:     &backendv1.TenantSpec{Domains: obj.GetDomains()},
	}}
	resp := &backendv1.TenantsCreateResponse{}
	if err := c.conn.Invoke(ctx, methodTenantsCreate, req, resp, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.CreateTenantResponse{Object: FromV1Tenant(resp.GetObject())}, nil
}

// tenantPaths maps the draft's mask paths onto the backend's; the others
// name fields the backend's Tenant doesn't have.
var tenantPaths = map[string]string{"name": "metadata.name", "domains": "spec.domains"}

// UpdateTenant sends the draft's name and domains paths as the backend's, and
// the If-Match version as metadata.version with lock. The backend requires a
// version (errTenantVersionRequired, internal/servers/tenants_server.go): every tenant reads as 1 or more, and 0 is
// InvalidArgument (422). Description, enabled and attributes pass when they
// hold what a read gives back (empty, true, none), as on create; other values,
// and any alias (the backend can't say which one Keycloak keeps after a
// rename), are Unimplemented. When only those no-op fields are left (an empty
// mask would make the backend update the name and domains), the mask names
// only id, which the backend answers with the stored tenant after checking
// the version, writing nothing.
func (c v1Tenants) UpdateTenant(ctx context.Context, in *aigridv1.UpdateTenantRequest, opts ...grpc.CallOption) (*aigridv1.UpdateTenantResponse, error) {
	obj := in.GetObject()
	version, err := v1Version(obj.GetResourceVersion())
	if err != nil {
		return nil, err
	}
	var paths, unsupported []string
	for _, p := range in.GetUpdateMask().GetPaths() {
		if real, ok := tenantPaths[p]; ok {
			paths = append(paths, real)
		} else if !readBackValue(p, obj) {
			unsupported = append(unsupported, p)
		}
	}
	if err := notInBackend(unsupported); err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		paths = []string{"id"}
	}
	req := &backendv1.TenantsUpdateRequest{
		Object: &backendv1.Tenant{
			Id:       obj.GetId(),
			Metadata: &backendv1.Metadata{Name: obj.GetName(), Version: version},
			Spec:     &backendv1.TenantSpec{Domains: obj.GetDomains()},
		},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: paths},
		Lock:       true,
	}
	resp := &backendv1.TenantsUpdateResponse{}
	if err := c.conn.Invoke(ctx, methodTenantsUpdate, req, resp, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.UpdateTenantResponse{Object: FromV1Tenant(resp.GetObject())}, nil
}

// DeleteTenant sends the If-Match version, which the backend checks;
// it answers 0 with InvalidArgument (422).
func (c v1Tenants) DeleteTenant(ctx context.Context, in *aigridv1.DeleteTenantRequest, opts ...grpc.CallOption) (*aigridv1.DeleteTenantResponse, error) {
	version, err := v1Version(in.GetResourceVersion())
	if err != nil {
		return nil, err
	}
	if err := c.conn.Invoke(ctx, methodTenantsDelete, &backendv1.TenantsDeleteRequest{Id: in.GetId(), Version: version}, &backendv1.TenantsDeleteResponse{}, opts...); err != nil {
		return nil, err
	}
	return &aigridv1.DeleteTenantResponse{}, nil
}

// v1Version parses an If-Match version into the backend's metadata.version.
// A negative one is InvalidArgument: the backend never answers one.
func v1Version(rv string) (int32, error) {
	v, err := strconv.ParseInt(rv, 10, 32)
	if err != nil {
		return 0, status.Errorf(codes.FailedPrecondition, "version %q is not one this backend answered", rv)
	}
	if v < 0 {
		return 0, status.Errorf(codes.InvalidArgument, "version %q is negative", rv)
	}
	return int32(v), nil
}

// v1DeleteVersion is v1Version for a delete's If-Match. The backend treats
// version 0 as "no check" and git mode's versions start at 1, so 0 is refused
// rather than turning the delete unconditional.
func v1DeleteVersion(rv string) (int32, error) {
	v, err := v1Version(rv)
	if err == nil && v == 0 {
		return 0, status.Errorf(codes.FailedPrecondition, "version %q is not one this backend answered", rv)
	}
	return v, err
}

// readBackValue reports whether path p, which the backend's Tenant lacks,
// holds what a read gives back: no description, enabled, no attributes.
func readBackValue(p string, obj *aigridv1.Tenant) bool {
	switch p {
	case "description":
		return obj.GetDescription() == ""
	case "enabled":
		return obj.GetEnabled()
	case "attributes":
		return len(obj.GetAttributes()) == 0
	}
	return false
}

// notInBackend refuses a request that sets fields the backend's Tenant lacks.
func notInBackend(fields []string) error {
	if len(fields) == 0 {
		return nil
	}
	return status.Errorf(codes.Unimplemented, "the backend's Tenants API has no %s", strings.Join(fields, ", "))
}

// FromV1Tenant maps a real Tenant (id, name, domains, version, creation time)
// onto the draft.
func FromV1Tenant(t *backendv1.Tenant) *aigridv1.Tenant {
	return &aigridv1.Tenant{
		Id:              t.GetId(),
		Name:            t.GetMetadata().GetName(),
		Domains:         t.GetSpec().GetDomains(),
		ResourceVersion: strconv.Itoa(int(t.GetMetadata().GetVersion())),
		CreateTime:      t.GetMetadata().GetCreationTimestamp(),
	}
}

func fromV1Conditions(cs []*backendv1.Condition) []*aigridv1.Condition {
	var out []*aigridv1.Condition
	for _, c := range cs {
		out = append(out, &aigridv1.Condition{
			Type: c.GetType(), Status: aigridv1.ConditionStatus(c.GetStatus()), LastTransitionTime: c.GetLastTransitionTime(),
			Reason: c.Reason, Message: c.Message,
		})
	}
	return out
}
