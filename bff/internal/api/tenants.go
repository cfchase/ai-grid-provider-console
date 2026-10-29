package api

import (
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
)

// Tenant is a consumer organisation. The backend reads them from Keycloak
// Organizations in the AI Grid realm; the JSON carries the fields of
// Keycloak's representation that the draft proto maps (not `redirectUrl`,
// which has no Tenant field, nor `members`, `identityProviders` and
// `groups`, which a GET never fills), with the collections always present
// (Keycloak omits an empty `domains`, the console does not).
type Tenant struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Alias       string `json:"alias"`
	Enabled     bool   `json:"enabled"`
	Description string `json:"description"`
	// Domains are the names of DomainDetails, in the same order.
	Domains       []string          `json:"domains"`
	DomainDetails []TenantDomain    `json:"domainDetails"`
	Attributes    map[string]string `json:"attributes"`
	// ResourceVersion is the version the backend keeps for the tenant (also
	// the ETag of GET /tenants/{id}); absent from a backend that keeps none.
	ResourceVersion string `json:"resourceVersion,omitempty"`
	// CreateTime is when the backend created the organization (P3); omitted
	// for one it has no creation time for.
	CreateTime *time.Time `json:"createTime,omitempty"`
	// IdentityProvider is the organization's OIDC identity provider (P1);
	// omitted when it has none.
	IdentityProvider *IdentityProvider `json:"identityProvider,omitempty"`
}

// IdentityProvider is an organization's OIDC identity provider in the PoC's
// shape (krisv/ai-grid-cloud-provider-poc src/app/types/tenants.ts at
// 62319b8). The backend validates, trims and defaults it; the BFF only
// translates it.
type IdentityProvider struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	// Enabled is omitted on input for the backend's default (true).
	Enabled *bool       `json:"enabled,omitempty"`
	Config  *OidcConfig `json:"config,omitempty"`
}

// OidcConfig is the identity provider's OIDC client configuration. It names
// the Secret holding the client secret and has no field for the secret
// itself, so strict decoding refuses one.
type OidcConfig struct {
	ClientID           string    `json:"clientId"`
	ClientSecretSecret SecretRef `json:"clientSecretSecret"`
	Issuer             string    `json:"issuer"`
	AuthorizationURL   string    `json:"authorizationUrl"`
	TokenURL           string    `json:"tokenUrl"`
	DefaultScopes      string    `json:"defaultScopes"`
	UserInfoURL        string    `json:"userInfoUrl"`
	JwksURL            string    `json:"jwksUrl"`
	LogoutURL          string    `json:"logoutUrl"`
	// ValidateSignature is omitted on input for the backend's default (true).
	ValidateSignature *bool `json:"validateSignature,omitempty"`
}

// SecretRef names the Secret that holds the OIDC client secret.
type SecretRef struct {
	Name string `json:"name"`
}

func toIdentityProvider(p *aigridv1.IdentityProvider) *IdentityProvider {
	if p == nil {
		return nil
	}
	out := &IdentityProvider{Title: p.GetTitle(), Description: p.GetDescription(), Enabled: p.Enabled}
	if c := p.GetConfig(); c != nil {
		out.Config = &OidcConfig{
			ClientID: c.GetClientId(), ClientSecretSecret: SecretRef{Name: c.GetClientSecretSecretName()},
			Issuer: c.GetIssuer(), AuthorizationURL: c.GetAuthorizationUrl(), TokenURL: c.GetTokenUrl(),
			DefaultScopes: c.GetDefaultScopes(), UserInfoURL: c.GetUserInfoUrl(), JwksURL: c.GetJwksUrl(),
			LogoutURL: c.GetLogoutUrl(), ValidateSignature: c.ValidateSignature,
		}
	}
	return out
}

func fromIdentityProvider(p *IdentityProvider) *aigridv1.IdentityProvider {
	if p == nil {
		return nil
	}
	out := &aigridv1.IdentityProvider{Title: p.Title, Description: p.Description, Enabled: p.Enabled}
	if c := p.Config; c != nil {
		out.Config = &aigridv1.OidcConfig{
			ClientId: c.ClientID, ClientSecretSecretName: c.ClientSecretSecret.Name,
			Issuer: c.Issuer, AuthorizationUrl: c.AuthorizationURL, TokenUrl: c.TokenURL,
			DefaultScopes: c.DefaultScopes, UserInfoUrl: c.UserInfoURL, JwksUrl: c.JwksURL,
			LogoutUrl: c.LogoutURL, ValidateSignature: c.ValidateSignature,
		}
	}
	return out
}

// TenantDomain is one organization domain with Keycloak's metadata.
type TenantDomain struct {
	Name                  string `json:"name"`
	Verified              bool   `json:"verified"`
	IdentityProviderAlias string `json:"identityProviderAlias,omitempty"`
	AutoRedirect          bool   `json:"autoRedirect"`
}

// Tenant JSON maps. Keys of the PATCH body; they double as the field-mask
// paths the backend accepts. `alias` is immutable: the backend keeps the
// stored one and answers a different one with Keycloak's "Cannot change the
// alias".
const (
	maskName        = "name"
	maskAlias       = "alias"
	maskDomains     = "domains"
	maskEnabled     = "enabled"
	maskDescription = "description"
	maskAttributes  = "attributes"
	// maskIdentityProvider is the mask path of `identityProvider` (P1).
	maskIdentityProvider = "identity_provider"
)

func toTenant(t *aigridv1.Tenant) Tenant {
	domains := t.GetDomains()
	if domains == nil {
		domains = []string{}
	}
	details := make([]TenantDomain, 0, len(t.GetDomainDetails()))
	for _, d := range t.GetDomainDetails() {
		details = append(details, TenantDomain{Name: d.GetName(), Verified: d.GetVerified(), IdentityProviderAlias: d.GetIdentityProviderAlias(), AutoRedirect: d.GetAutoRedirect()})
	}
	if len(details) == 0 {
		// A backend that only fills fields 1-3 (today's) sends names only.
		for _, name := range domains {
			details = append(details, TenantDomain{Name: name})
		}
	}
	attributes := t.GetAttributes()
	if attributes == nil {
		attributes = map[string]string{}
	}
	// A backend that does not fill `enabled` (today's, fields 1-3 only) is
	// read as enabled: Keycloak's default, and the only value under which
	// every organization is usable.
	enabled := t.Enabled == nil || t.GetEnabled()
	out := Tenant{
		ID: t.GetId(), Name: t.GetName(), Alias: t.GetAlias(), Enabled: enabled, Description: t.GetDescription(),
		Domains: domains, DomainDetails: details, Attributes: attributes, ResourceVersion: t.GetResourceVersion(),
		IdentityProvider: toIdentityProvider(t.GetIdentityProvider()),
	}
	if ts := t.GetCreateTime(); ts != nil {
		created := ts.AsTime().UTC()
		out.CreateTime = &created
	}
	return out
}

// queryInt reads an optional non-negative integer query parameter. The
// request fields are int32, so the value is parsed as one: a larger number
// is 422 instead of wrapping on its way into the proto. A repeated one is
// 422 too, like a repeated `filter`: there is no telling which one was meant.
func queryInt(r *http.Request, name string) (*int, error) {
	if len(r.URL.Query()[name]) > 1 {
		return nil, Errorf(http.StatusUnprocessableEntity, fmt.Sprintf("query parameter %q must be sent once", name))
	}
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return nil, nil
	}
	v64, err := strconv.ParseInt(raw, 10, 32)
	if err != nil || v64 < 0 {
		return nil, Errorf(http.StatusUnprocessableEntity, fmt.Sprintf("query parameter %q must be an integer between 0 and %d", name, math.MaxInt32))
	}
	v := int(v64)
	return &v, nil
}

// listFilter reads the `filter` query parameter of a list endpoint: a CEL
// expression over `this` that the client wrote, forwarded as the request's
// `filter` exactly as received (nil when the parameter is absent or empty).
// The BFF neither builds nor checks it; the backend evaluates it and answers
// a bad one with InvalidArgument (422). The query parameters the BFF used to
// turn into CEL itself (`removed`: `search` for tenants, `namespace` and
// `label` for models) are 422 rather than ignored, so a client written for
// them gets an error instead of the unfiltered list.
func listFilter(r *http.Request, removed ...string) (*string, error) {
	q := r.URL.Query()
	for _, name := range removed {
		if q.Has(name) {
			return nil, Errorf(http.StatusUnprocessableEntity, fmt.Sprintf(`query parameter %q is not supported; send a CEL filter in "filter"`, name))
		}
	}
	if len(q["filter"]) > 1 {
		return nil, Errorf(http.StatusUnprocessableEntity, `query parameter "filter" must be sent once; join the conditions with && in one expression`)
	}
	if f := strings.TrimSpace(q.Get("filter")); f != "" {
		return proto.String(f), nil
	}
	return nil, nil
}

// listTenants answers GET /api/v1/tenants?offset=&limit=&filter=. The
// backend returns them in Keycloak's order (by name) and evaluates `filter`
// (listFilter); `meta` carries the page, with `total` counted over the whole
// filtered list. A backend that answers without `total` has not honoured the
// filter or the page (requireTotal): 501 when the caller asked for either,
// the plain list otherwise.
func (a *App) listTenants(w http.ResponseWriter, r *http.Request) {
	offset, err := queryInt(r, "offset")
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	limit, err := queryInt(r, "limit")
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	filter, err := listFilter(r, "search")
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	req := &aigridv1.ListTenantsRequest{Filter: filter}
	if offset != nil {
		req.Offset = proto.Int32(int32(*offset))
	}
	if limit != nil {
		req.Limit = proto.Int32(int32(*limit))
	}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Tenants.ListTenants(ctx, req)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	if err := requireTotal(pagedOrFiltered(offset, limit, req.Filter != nil), resp.Total, "tenants"); err != nil {
		a.respondError(w, r, err)
		return
	}
	out := make([]Tenant, 0, len(resp.GetTenants()))
	for _, t := range resp.GetTenants() {
		out = append(out, toTenant(t))
	}
	writeList(w, http.StatusOK, out, listMeta(offset, limit, len(out), resp.Total))
}

// pagedOrFiltered reports whether a list request asks for anything a
// backend that ignores the request would get wrong: a filter, a limit or an
// offset past the first item (`offset=0` alone is what such a backend does
// anyway).
func pagedOrFiltered(offset, limit *int, filtered bool) bool {
	return filtered || limit != nil || (offset != nil && *offset > 0)
}

// getTenant answers GET /api/v1/tenants/{id}.
func (a *App) getTenant(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Tenants.GetTenant(ctx, &aigridv1.GetTenantRequest{Id: r.PathValue("id")})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	setETag(w, resp.GetObject().GetResourceVersion())
	writeData(w, http.StatusOK, toTenant(resp.GetObject()))
}

// TenantCreate is the body of POST /api/v1/tenants. `name` is required;
// `alias` defaults to the name; `enabled` defaults to true (Keycloak's
// default for an omitted key); `domains` are names with default metadata.
type TenantCreate struct {
	Name        string            `json:"name"`
	Alias       string            `json:"alias"`
	Description string            `json:"description"`
	Enabled     *bool             `json:"enabled"`
	Domains     []string          `json:"domains"`
	Attributes  map[string]string `json:"attributes"`
	// IdentityProvider is optional; the backend validates it (P1).
	IdentityProvider *IdentityProvider `json:"identityProvider"`
}

// createTenant answers POST /api/v1/tenants: 201 with the created tenant and
// a Location header. Validation is the backend's (Keycloak's messages come
// back as 422, a taken name or alias as 409).
func (a *App) createTenant(w http.ResponseWriter, r *http.Request) {
	var body TenantCreate
	if err := decodeBody(w, r, &body); err != nil {
		a.respondError(w, r, err)
		return
	}
	// `enabled` is passed through as given; absent stays absent and the
	// backend applies Keycloak's default (true).
	obj := &aigridv1.Tenant{Name: body.Name, Alias: body.Alias, Description: body.Description, Enabled: body.Enabled, Domains: body.Domains, Attributes: body.Attributes,
		IdentityProvider: fromIdentityProvider(body.IdentityProvider)}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Tenants.CreateTenant(ctx, &aigridv1.CreateTenantRequest{Object: obj})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	t := toTenant(resp.GetObject())
	a.log(r).Info("tenant created", "tenant", t.ID, "name", t.Name)
	w.Header().Set("Location", APIPrefix+"/tenants/"+url.PathEscape(t.ID))
	setETag(w, t.ResourceVersion)
	writeData(w, http.StatusCreated, t)
}

// TenantPatch is the body of PATCH /api/v1/tenants/{id}. Every field is
// optional and an absent field is left alone; a present field replaces the
// stored one as a whole (`domains: []` removes every domain, `attributes: {}`
// every attribute). The fake backend accepts `alias` only with the stored
// value; the real backend's Tenants API refuses any `alias` (501).
type TenantPatch struct {
	Name        *string            `json:"name"`
	Alias       *string            `json:"alias"`
	Description *string            `json:"description"`
	Enabled     *bool              `json:"enabled"`
	Domains     *[]string          `json:"domains"`
	Attributes  *map[string]string `json:"attributes"`
	// IdentityProvider replaces the stored one as a whole (P1).
	IdentityProvider *IdentityProvider `json:"identityProvider"`
}

// patchTenant answers PATCH /api/v1/tenants/{id}: the present fields become
// the field mask of one UpdateTenant call (`alias` included); the backend
// does Keycloak's GET, merge and PUT, refuses a changed alias, and skips a
// PUT that changes nothing. The If-Match version, which the client must send
// (requireIfMatch), travels as `object.resource_version`, which the backend
// compares with the version it keeps (a stale tab gets 409). A body that
// names no field is 422.
func (a *App) patchTenant(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := requireJSON(r); err != nil {
		a.respondError(w, r, err)
		return
	}
	expected, err := requireIfMatch(r)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	var patch TenantPatch
	if err := decodeBody(w, r, &patch); err != nil {
		a.respondError(w, r, err)
		return
	}
	obj := &aigridv1.Tenant{Id: id, ResourceVersion: expected}
	var paths []string
	if patch.Name != nil {
		obj.Name = *patch.Name
		paths = append(paths, maskName)
	}
	if patch.Alias != nil {
		obj.Alias = *patch.Alias
		paths = append(paths, maskAlias)
	}
	if patch.Description != nil {
		obj.Description = *patch.Description
		paths = append(paths, maskDescription)
	}
	if patch.Enabled != nil {
		obj.Enabled = patch.Enabled
		paths = append(paths, maskEnabled)
	}
	if patch.Domains != nil {
		obj.Domains = *patch.Domains
		if obj.Domains == nil {
			obj.Domains = []string{}
		}
		paths = append(paths, maskDomains)
	}
	if patch.Attributes != nil {
		obj.Attributes = *patch.Attributes
		if obj.Attributes == nil {
			obj.Attributes = map[string]string{}
		}
		paths = append(paths, maskAttributes)
	}
	if patch.IdentityProvider != nil {
		obj.IdentityProvider = fromIdentityProvider(patch.IdentityProvider)
		paths = append(paths, maskIdentityProvider)
	}
	if len(paths) == 0 {
		a.respondError(w, r, Errorf(http.StatusUnprocessableEntity, "the request body names no field to change"))
		return
	}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	resp, err := a.backend.Tenants.UpdateTenant(ctx, &aigridv1.UpdateTenantRequest{Object: obj, UpdateMask: &fieldmaskpb.FieldMask{Paths: paths}})
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	a.log(r).Info("tenant updated", "tenant", id, "paths", paths)
	setETag(w, resp.GetObject().GetResourceVersion())
	writeData(w, http.StatusOK, toTenant(resp.GetObject()))
}

// deleteTenant answers DELETE /api/v1/tenants/{id} with 204. The If-Match
// version (required, requireIfMatch) is the request's `resource_version`
// precondition: 409 when the tenant changed since.
func (a *App) deleteTenant(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	expected, err := requireIfMatch(r)
	if err != nil {
		a.respondError(w, r, err)
		return
	}
	ctx, cancel := a.backend.Context(r.Context())
	defer cancel()
	if _, err := a.backend.Tenants.DeleteTenant(ctx, &aigridv1.DeleteTenantRequest{Id: id, ResourceVersion: expected}); err != nil {
		a.respondError(w, r, err)
		return
	}
	a.log(r).Info("tenant deleted", "tenant", id)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
