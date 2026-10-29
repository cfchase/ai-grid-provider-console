// Command fake-backend runs the fake ai-grid-backend and the fake hub API from
// fixtures, so the console can be developed without a cluster. See
// mock/README.md for what it simulates and why.
//
//	fake-backend --fixtures ../mock/fixtures --listen-address 127.0.0.1:9090 --hub-address 127.0.0.1:9091
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/sync/errgroup"

	"github.com/ai-grid-cloud/ai-grid-provider-console/bff/internal/fakebackend"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	fs := flag.NewFlagSet("fake-backend", flag.ContinueOnError)
	fixturesDir := fs.String("fixtures", "../mock/fixtures", "Directory with the fixture files")
	listen := fs.String("listen-address", "127.0.0.1:9090", "gRPC address, the same flag the real backend takes")
	hubAddr := fs.String("hub-address", "127.0.0.1:9091", "HTTP address of the fake hub API (SelfSubjectAccessReview); empty disables it")
	logLevel := fs.String("log-level", "info", "debug, info, warn, error")
	if err := fs.Parse(os.Args[1:]); err != nil {
		return err
	}
	var level slog.Level
	if err := level.UnmarshalText([]byte(*logLevel)); err != nil {
		return err
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level}))

	fx, err := fakebackend.Load(*fixturesDir)
	if err != nil {
		return fmt.Errorf("load fixtures from %s: %w", *fixturesDir, err)
	}
	srv, err := fakebackend.New(fx, logger)
	if err != nil {
		return fmt.Errorf("fixtures in %s: %w", *fixturesDir, err)
	}
	logger.Info("fixtures loaded", "dir", *fixturesDir, "clusters", len(fx.Clusters), "tenants", len(fx.Tenants), "tenantsUnavailable", fx.TenantsUnavailable != "", "latency", fx.Latency.Duration(), "scenarios", len(fx.Scenarios), "speed", fx.Speed)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	g, ctx := errgroup.WithContext(ctx)
	g.Go(func() error { return srv.Serve(ctx, *listen) })
	if *hubAddr != "" {
		g.Go(func() error { return fakebackend.NewHub(fx.Access, logger).Serve(ctx, *hubAddr) })
	}
	return g.Wait()
}
