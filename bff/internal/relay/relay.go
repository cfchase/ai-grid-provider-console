// Package relay forwards the browser's Connect calls to the backend's own RPCs
// (docs/adr 0002 and 0004): a reverse proxy for the paths under Prefix, to the
// backend at BACKEND_ADDRESS, which serves Connect, gRPC and gRPC-Web on that
// port. It compiles against no contract and reads no body, so a new RPC needs
// no transport implementation here. Until backend authorization lands, new
// procedures require an explicit boundary review (allowedProcedures).
//
// What it owns is the boundary. It runs behind the BFF's caller checks (the
// token header, then the provider-admin check), and of what the browser sent,
// the caller's credentials and identity reach the backend only as the BFF
// forwards them on every gRPC call (package backend): the token as
// Authorization: Bearer, and the user, email and groups percent-encoded in
// x-forwarded-user, x-forwarded-email and x-forwarded-groups. Anything the
// browser sent under those names, cookies and every other proxy header stay
// behind. Only the procedures in allowedProcedures pass, and only the Connect
// protocol: POST with a Connect content type (unary and streaming calls) and
// GET (for methods without side effects), uncompressed, with a body of at most
// MaxBodyBytes. A unary call is bounded by the backend
// timeout, and any call waits at most that long for the backend's headers. Of
// the answer, only the headers a Connect client and the browser need pass.
package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	neturl "net/url"
	"regexp"
	"strings"
	"time"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/backend"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/identity"
)

// Prefix starts the path of every procedure of the backend's API, package
// ai_grid.v1: /ai_grid.v1.<Service>/<Method>.
const Prefix = "/ai_grid.v1."

// MaxBodyBytes bounds a request body, as for the BFF's JSON API.
const MaxBodyBytes = 1 << 20

// procedure is the whole path of one: a service and a method name, nothing
// else (no further segment, dot segment or escape), so the backend routes the
// path the relay checked.
var procedure = regexp.MustCompile(`^/ai_grid\.v1\.[A-Za-z_][A-Za-z0-9_]*/[A-Za-z_][A-Za-z0-9_]*$`)

// allowedProcedures keeps the console's existing API surface until the backend
// authorizes callers itself. Left out of the pinned API: Clusters Create and
// Delete, which the console doesn't offer, and Tenants/ListMembers, because the
// console never lists an organization's members: one organization is one
// tenant, and the provider must not see a company's internals (decided
// 2026-10-23).
var allowedProcedures = map[string]struct{}{
	"/ai_grid.v1.AiGrid/Ping":                  {},
	"/ai_grid.v1.Clusters/List":                {},
	"/ai_grid.v1.Clusters/Get":                 {},
	"/ai_grid.v1.Clusters/Update":              {},
	"/ai_grid.v1.Tenants/List":                 {},
	"/ai_grid.v1.Tenants/Get":                  {},
	"/ai_grid.v1.Tenants/Create":               {},
	"/ai_grid.v1.Tenants/Update":               {},
	"/ai_grid.v1.Tenants/Delete":               {},
	"/ai_grid.v1.Models/List":                  {},
	"/ai_grid.v1.Models/Get":                   {},
	"/ai_grid.v1.Models/Create":                {},
	"/ai_grid.v1.Models/Update":                {},
	"/ai_grid.v1.Models/Delete":                {},
	"/ai_grid.v1.Models/ListPlacementClusters": {},
	"/ai_grid.v1.Models/ListServingOptions":    {},
	"/ai_grid.v1.Subscriptions/List":           {},
	"/ai_grid.v1.Subscriptions/Get":            {},
	"/ai_grid.v1.Subscriptions/Create":         {},
	"/ai_grid.v1.Subscriptions/Update":         {},
	"/ai_grid.v1.Subscriptions/Delete":         {},
}

// Handles reports whether a path belongs to the relay: the BFF routes it here,
// and answers its own refusals on it as Connect errors (WriteError).
func Handles(path string) bool { return strings.HasPrefix(path, Prefix) }

// Config locates the backend and names the proxy headers the caller came in.
type Config struct {
	// Backend is the BFF's backend connection: Address, and CAFile,
	// ServerName and Insecure under backend.Config.TLS's rules. Timeout bounds
	// each unary call (zero: 10 seconds, as for the gRPC client).
	Backend backend.Config
	// IdentityHeaders are the request headers the BFF reads the caller from
	// (AUTH_TOKEN_HEADER, AUTH_USER_HEADER, ...). They never reach the backend
	// as the browser sent them, whatever their names.
	IdentityHeaders []string
	// Logger gets why a call could not be relayed; nil uses slog.Default.
	Logger *slog.Logger
}

// Relay is an http.Handler for the paths under Prefix. It expects the
// caller's identity on the request context (identity.WithIdentity), as the
// BFF's requireIdentity puts it there.
type Relay struct {
	target  *neturl.URL
	timeout time.Duration
	strip   []string
	logger  *slog.Logger
	proxy   *httputil.ReverseProxy
}

// New builds a relay. It fails when the backend address is not one the BFF
// may reach (backend.Config.TLS) or its CA file cannot be read.
func New(cfg Config) (*Relay, error) {
	tlsCfg, err := cfg.Backend.TLS()
	if err != nil {
		return nil, err
	}
	timeout := cfg.Backend.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	scheme := "http"
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// A backend that sends no headers within the timeout can't hold a call, a stream
	// included; a stream whose headers came runs on uncut.
	transport.ResponseHeaderTimeout = timeout
	if tlsCfg != nil {
		scheme = "https"
		transport.TLSClientConfig = tlsCfg
	}
	target := &neturl.URL{Scheme: scheme, Host: cfg.Backend.Address}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	strip := []string{"Authorization", "Proxy-Authorization", "Cookie", "Forwarded"}
	for _, h := range cfg.IdentityHeaders {
		if h = strings.TrimSpace(h); h != "" {
			strip = append(strip, h)
		}
	}
	r := &Relay{target: target, timeout: timeout, strip: strip, logger: logger}
	r.proxy = &httputil.ReverseProxy{
		Rewrite:        r.rewrite,
		Transport:      transport,
		ModifyResponse: modifyResponse,
		ErrorHandler:   r.errorHandler,
		// What the proxy reports itself, such as an answer cut while it is
		// copied (the browser or the backend went away), goes to the relay's
		// logger instead of the log package.
		ErrorLog: slog.NewLogLogger(logger.Handler(), slog.LevelDebug),
	}
	return r, nil
}

// URL is the backend the relay forwards to, for the startup log.
func (r *Relay) URL() string { return r.target.String() }

// ServeHTTP relays a Connect call with the caller's identity from the context.
func (r *Relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if req.URL.RawPath != "" || !procedure.MatchString(req.URL.Path) {
		WriteError(w, http.StatusNotFound, "no such procedure: the console relays /ai_grid.v1.<Service>/<Method> only")
		return
	}
	if _, ok := allowedProcedures[req.URL.Path]; !ok {
		WriteError(w, http.StatusNotFound, "this procedure is not exposed by the console")
		return
	}
	if req.Method != http.MethodPost && req.Method != http.MethodGet {
		w.Header().Set("Allow", "GET, POST")
		WriteError(w, http.StatusMethodNotAllowed, fmt.Sprintf("%s is not allowed on %s; Connect uses POST, and GET for a method without side effects", req.Method, req.URL.Path))
		return
	}
	if _, ok := identity.FromContext(req.Context()); !ok {
		WriteError(w, http.StatusUnauthorized, "missing caller identity")
		return
	}
	// Limit decoded input as well as wire bytes: browsers do not compress requests.
	for _, header := range []string{"Content-Encoding", "Connect-Content-Encoding"} {
		for _, encoding := range req.Header.Values(header) {
			if encoding = strings.TrimSpace(encoding); encoding != "" && !strings.EqualFold(encoding, "identity") {
				WriteError(w, http.StatusUnsupportedMediaType, "compressed requests are not supported by the console")
				return
			}
		}
	}
	if encoding := req.URL.Query().Get("compression"); encoding != "" && encoding != "identity" {
		WriteError(w, http.StatusUnsupportedMediaType, "compressed requests are not supported by the console")
		return
	}
	streaming := false
	if req.Method == http.MethodPost {
		kind, ok := connectContentTypes[mediaType(req.Header.Get("Content-Type"))]
		if !ok {
			WriteError(w, http.StatusUnsupportedMediaType, "the console relays the Connect protocol only: send application/json, application/proto, application/connect+json or application/connect+proto")
			return
		}
		streaming = kind == connectStream
	}
	if req.ContentLength > MaxBodyBytes {
		WriteError(w, http.StatusRequestEntityTooLarge, tooLarge)
		return
	}
	req.Body = http.MaxBytesReader(w, req.Body, MaxBodyBytes)
	if !streaming {
		ctx, cancel := context.WithTimeout(req.Context(), r.timeout)
		defer cancel()
		req = req.WithContext(ctx)
	}
	r.proxy.ServeHTTP(w, req)
}

var tooLarge = fmt.Sprintf("a request body must be at most %d bytes", MaxBodyBytes)

type callKind int

const (
	connectUnary callKind = iota
	connectStream
)

// connectContentTypes are the POST bodies of the Connect protocol, the only one
// the browser's client speaks: a unary call's message, bounded by the backend
// timeout, and a stream's envelopes, which run as long as the stream does (up
// to the server's write timeout). gRPC and gRPC-Web, which the backend serves
// on the same port, are refused (415), as is anything else. A Connect GET has
// no body and is unary.
var connectContentTypes = map[string]callKind{
	"application/json":          connectUnary,
	"application/proto":         connectUnary,
	"application/connect+json":  connectStream,
	"application/connect+proto": connectStream,
}

// mediaType is a Content-Type without its parameters (charset), lower-cased;
// empty when it doesn't parse.
func mediaType(contentType string) string {
	mt, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	return mt
}

// relayedHeaders, and every header starting with relayedPrefixes, are the only
// response headers that reach the browser: what a Connect client reads
// (Content-Type; Connect-* such as Connect-Content-Encoding; a unary call's
// trailers, sent as Trailer-* headers; Grpc-*), what decoding and caching the
// answer need, and the compressions the backend accepts. Anything else the
// backend sends stays behind: a Set-Cookie for the console's origin, a CORS
// grant, a WWW-Authenticate challenge, a Location, or its own say on the
// security headers, which the BFF sets itself.
var (
	relayedHeaders  = []string{"Content-Type", "Content-Encoding", "Content-Length", "Accept-Encoding", "Vary", "Cache-Control", "Date"}
	relayedPrefixes = []string{"Connect-", "Grpc-", "Trailer-"}
)

func modifyResponse(resp *http.Response) error {
	h := http.Header{}
	for _, k := range relayedHeaders {
		if v := resp.Header.Values(k); len(v) > 0 {
			h[k] = v
		}
	}
	for k, v := range resp.Header {
		for _, p := range relayedPrefixes {
			if strings.HasPrefix(k, p) {
				h[k] = v
			}
		}
	}
	h.Set("X-Content-Type-Options", "nosniff")
	resp.Header = h
	return nil
}

// rewrite points the call at the backend and replaces whatever the browser
// sent about who it is with the identity the BFF read from the proxy headers.
// ReverseProxy has already dropped the hop-by-hop headers and X-Forwarded-For,
// -Host and -Proto.
func (r *Relay) rewrite(pr *httputil.ProxyRequest) {
	pr.SetURL(r.target)
	h := pr.Out.Header
	for _, k := range r.strip {
		h.Del(k)
	}
	for k := range h {
		if lower := strings.ToLower(k); strings.HasPrefix(lower, "x-forwarded-") || strings.HasPrefix(lower, "x-auth-request-") {
			delete(h, k)
		}
	}
	id, _ := identity.FromContext(pr.In.Context())
	h.Set(backend.MetaAuthorization, "Bearer "+id.Token())
	if id.Username != "" {
		h.Set(backend.MetaUser, backend.EncodeMetadataValue(id.Username))
	}
	if id.Email != "" {
		h.Set(backend.MetaEmail, backend.EncodeMetadataValue(id.Email))
	}
	if len(id.Groups) > 0 {
		groups := make([]string, len(id.Groups))
		for i, g := range id.Groups {
			groups[i] = backend.EncodeMetadataValue(g)
		}
		h.Set(backend.MetaGroups, strings.Join(groups, ","))
	}
}

// errorHandler answers a call the backend did not answer.
func (r *Relay) errorHandler(w http.ResponseWriter, req *http.Request, err error) {
	var maxBytes *http.MaxBytesError
	var netErr net.Error
	switch {
	case errors.As(err, &maxBytes):
		WriteError(w, http.StatusRequestEntityTooLarge, tooLarge)
	case errors.Is(req.Context().Err(), context.Canceled):
		// The browser went away; nobody reads the answer.
		w.WriteHeader(499)
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &netErr) && netErr.Timeout():
		r.logger.Warn("backend call timed out", "path", req.URL.Path, "timeout", r.timeout, "error", err)
		WriteError(w, http.StatusGatewayTimeout, "The AI Grid backend did not respond in time. Try again.")
	default:
		r.logger.Warn("backend call failed", "path", req.URL.Path, "error", err)
		WriteError(w, http.StatusBadGateway, "the AI Grid backend could not be reached; try again")
	}
}

// connectCodes are the Connect error codes the BFF's own answers on the
// relay's paths carry, by HTTP status (connectrpc.com/docs/protocol, "Error
// codes"): the Connect client reads the code from the body.
var connectCodes = map[int]string{
	http.StatusUnauthorized:          "unauthenticated",
	http.StatusForbidden:             "permission_denied",
	http.StatusNotFound:              "unimplemented",
	http.StatusMethodNotAllowed:      "unimplemented",
	http.StatusRequestEntityTooLarge: "resource_exhausted",
	http.StatusUnsupportedMediaType:  "unimplemented",
	http.StatusInternalServerError:   "internal",
	http.StatusBadGateway:            "unavailable",
	http.StatusServiceUnavailable:    "unavailable",
	http.StatusGatewayTimeout:        "deadline_exceeded",
}

// WriteError answers with a Connect error, `{"code": ..., "message": ...}`,
// and the HTTP status. The BFF answers its own refusals on the relay's paths
// with it (a missing token, the provider-admin check), so the browser's
// Connect client gets the code and the message instead of the JSON API's
// envelope, which it cannot read.
func WriteError(w http.ResponseWriter, status int, message string) {
	code, ok := connectCodes[status]
	if !ok {
		code = "unknown"
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "message": message})
}
