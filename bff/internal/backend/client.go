// Package backend holds the gRPC connection to ai-grid-backend.
//
// The backend owns every interaction with the hub, Keycloak and metrics. The
// BFF only translates its RPCs into the JSON the frontend uses and forwards the
// caller's identity in request metadata so the backend can authorize.
package backend

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	aigridv1 "github.com/ai-grid-cloud/ai-grid-provider-console/bff/gen/ai_grid/v1"
	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/identity"
)

// Metadata keys the BFF sets on every outgoing RPC.
const (
	MetaAuthorization = "authorization"
	MetaUser          = "x-forwarded-user"
	MetaEmail         = "x-forwarded-email"
	MetaGroups        = "x-forwarded-groups"
)

// Config describes how to reach the backend.
type Config struct {
	// Address is host:port. In the single-pod deployment it is the loopback
	// address of the backend container.
	Address string
	// CAFile enables TLS with this CA. Empty means plaintext, which Dial only
	// accepts for loopback addresses unless Insecure is set.
	CAFile string
	// Insecure allows plaintext to a non-loopback address (development only).
	Insecure bool
	// ServerName overrides the expected TLS server name.
	ServerName string
	// Timeout bounds every RPC.
	Timeout time.Duration
	// DraftAPI says the backend serves the console's draft proto (the fake).
	// Otherwise clusters, tenants and models use the backend's real RPCs (v1.go).
	DraftAPI bool
	// ModelsNamespace is the namespace the console's models are in. The real
	// backend's models have none, so its models are reported in this one
	// (v1_models.go).
	ModelsNamespace string
}

// Client wraps the generated service clients.
type Client struct {
	conn    *grpc.ClientConn
	timeout time.Duration
	Health  aigridv1.AiGridClient
	Tenants aigridv1.TenantsClient
	Models  aigridv1.ModelsClient
	Grid    aigridv1.GridClient
}

// Dial creates the connection. It does not connect until the first RPC, so a
// backend that starts later than the BFF is fine. Extra options are for tests.
func Dial(cfg Config, extra ...grpc.DialOption) (*Client, error) {
	tlsCfg, err := cfg.TLS()
	if err != nil {
		return nil, err
	}
	creds := insecure.NewCredentials()
	if tlsCfg != nil {
		creds = credentials.NewTLS(tlsCfg)
	}
	opts := append([]grpc.DialOption{
		grpc.WithTransportCredentials(creds),
		grpc.WithUnaryInterceptor(forwardIdentity),
	}, extra...)
	conn, err := grpc.NewClient(cfg.Address, opts...)
	if err != nil {
		return nil, fmt.Errorf("connect to backend %s: %w", cfg.Address, err)
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	var tenants aigridv1.TenantsClient = v1Tenants{conn}
	var models aigridv1.ModelsClient = v1Models{conn: conn, namespace: cfg.ModelsNamespace}
	if cfg.DraftAPI {
		tenants = aigridv1.NewTenantsClient(conn)
		models = aigridv1.NewModelsClient(conn)
	}
	return &Client{
		conn:    conn,
		timeout: timeout,
		Health:  aigridv1.NewAiGridClient(conn),
		Tenants: tenants,
		Models:  models,
		Grid:    aigridv1.NewGridClient(conn),
	}, nil
}

// TLS says how to reach the backend, for the gRPC client and the Connect relay
// (internal/relay) alike: with TLS verified against CAFile (and ServerName,
// when set) when a CA file is given; in plaintext, a nil config, for a
// loopback address, or any address with Insecure; otherwise not at all, as
// the caller's token would cross the network in the clear.
func (cfg Config) TLS() (*tls.Config, error) {
	if strings.TrimSpace(cfg.Address) == "" {
		return nil, fmt.Errorf("backend address must not be empty")
	}
	if cfg.CAFile == "" {
		if !cfg.Insecure && !IsLoopback(cfg.Address) {
			return nil, fmt.Errorf("backend address %s is not loopback: set a CA file for TLS or allow insecure explicitly", cfg.Address)
		}
		return nil, nil
	}
	pem, err := os.ReadFile(cfg.CAFile)
	if err != nil {
		return nil, fmt.Errorf("load backend CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("load backend CA: %s holds no PEM certificate", cfg.CAFile)
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool, ServerName: cfg.ServerName}, nil
}

// IsLoopback reports whether a host:port target names the local machine.
func IsLoopback(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		host = address
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// Close releases the connection.
func (c *Client) Close() error { return c.conn.Close() }

// Context bounds an RPC with the configured timeout.
func (c *Client) Context(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, c.timeout)
}

// forwardIdentity copies the caller's identity from the context into gRPC
// metadata. Requests without an identity (the readiness probe) carry none.
// The user, the email and each group are percent-encoded
// (EncodeMetadataValue): grpc-go refuses a metadata value that is not
// printable ASCII, so a group such as `équipe-ops` sent as is would fail
// every call.
func forwardIdentity(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
	if id, ok := identity.FromContext(ctx); ok {
		pairs := []string{MetaAuthorization, "Bearer " + id.Token()}
		if id.Username != "" {
			pairs = append(pairs, MetaUser, EncodeMetadataValue(id.Username))
		}
		if id.Email != "" {
			pairs = append(pairs, MetaEmail, EncodeMetadataValue(id.Email))
		}
		if len(id.Groups) > 0 {
			groups := make([]string, len(id.Groups))
			for i, g := range id.Groups {
				groups[i] = EncodeMetadataValue(g)
			}
			pairs = append(pairs, MetaGroups, strings.Join(groups, ","))
		}
		ctx = metadata.AppendToOutgoingContext(ctx, pairs...)
	}
	return invoker(ctx, method, req, reply, cc, opts...)
}

// EncodeMetadataValue percent-encodes `%` and every byte outside printable
// ASCII (0x20-0x7E) as `%XX`, upper-case hex, so that any proxy header value
// is a valid gRPC metadata value. An ASCII value without `%` stays the same,
// byte for byte. A receiver decodes with plain percent-decoding (Go's
// url.PathUnescape, which leaves `+` alone) and gets the original bytes back,
// UTF-8 for a name such as `équipe-ops`. The groups are encoded one by one
// and joined with `,`; a group never contains one (package identity splits
// the header on it), so the receiver splits first and then decodes. This is
// a proposal to the backend team, not yet agreed: the fake decodes it, the
// shipped backend doesn't yet and sees a non-ASCII name still encoded
// (harmless while these values are advisory, docs/plan/bff-api.md).
func EncodeMetadataValue(v string) string {
	if !strings.ContainsFunc(v, func(r rune) bool { return r == '%' || r < 0x20 || r > 0x7e }) {
		return v
	}
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(v); i++ {
		if c := v[i]; c == '%' || c < 0x20 || c > 0x7e {
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0f])
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}
