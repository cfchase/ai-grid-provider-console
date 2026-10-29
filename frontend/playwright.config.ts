import { defineConfig, devices } from '@playwright/test';

// The stack's ports default to the ones `make dev-fake` documents. Set them when
// another process already holds a default (for example a PoC on :8080); CI keeps the defaults.
const port = process.env.E2E_FRONTEND_PORT ?? '9000';
const bffPort = process.env.E2E_BFF_PORT ?? '8080';
const backendPort = process.env.E2E_BACKEND_PORT ?? '9090';
const hubPort = process.env.E2E_HUB_PORT ?? '9091';
const origin = `http://127.0.0.1:${port}`;
// The second stack, for the pages that read the backend's own API over Connect (the Clusters
// pages, the map and the Subscriptions pages), which the console's fake doesn't serve: the backend at .backend-api-version
// on its own fake hub and Keycloak, PoC preset (hack/backend-fakes.sh), its BFF and its bundle,
// on ports offset from the first stack's so both run side by side.
const fakesPort = process.env.E2E_FAKES_FRONTEND_PORT ?? '9200';
const fakesBffPort = process.env.E2E_FAKES_BFF_PORT ?? '8280';
const fakesBackendPort = Number(process.env.E2E_FAKES_BACKEND_PORT ?? '9290');
const fakesOrigin = `http://127.0.0.1:${fakesPort}`;
const browser = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };
const membership = 'cluster-membership.spec.ts';
const onBackendFakes = ['clusters.spec.ts', 'grid.spec.ts', 'subscriptions.spec.ts'];

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  // A test.only left in a commit would otherwise make CI run that one test and pass.
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: origin,
    colorScheme: 'light',
    trace: 'retain-on-failure',
    // Without these an action or a navigation that never completes uses up the whole test
    // timeout and is reported as a bare test timeout; with them the failure names the line.
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    { name: 'chromium', use: browser, testIgnore: [membership, ...onBackendFakes] },
    { name: 'backend fakes', use: { ...browser, baseURL: fakesOrigin }, testMatch: onBackendFakes },
    // Every spec but this one leaves the fixtures as it found them, or changes only objects it
    // created under a name of its own, so they can run side by side. This one adds a fixture
    // cluster to AI Grid and removes it again: one run at a time.
    { name: 'cluster membership', use: { ...browser, baseURL: fakesOrigin }, testMatch: membership, workers: 1 },
  ],
  // The console's fake stack on the PoC preset (mock/fixtures-poc), with the frontend as it ships: the production bundle,
  // served by `vite preview`, whose proxy is the dev server's (vite.config.ts), so the identity
  // headers are the same. The dev server's unbundled modules and React's development build
  // made pages load in seconds and reported errors React's production build does not.
  // Playwright starts the three in parallel and fails the run at once if one exits before it answers.
  // Outside CI it reuses whatever already answers on the ports. A running `make dev-fake` serves
  // mock/fixtures, not mock/fixtures-poc, so stop it first; the specs need the PoC's names.
  webServer: [
    {
      // make -C bff fake-backend on the PoC preset (mock/fixtures-poc): the specs use the PoC's
      // site, model and pin names. go run rather than make: CI's Playwright image has no make.
      command: `go run ./cmd/fake-backend --fixtures=../mock/fixtures-poc --listen-address=127.0.0.1:${backendPort} --hub-address=127.0.0.1:${hubPort}`,
      cwd: '../bff',
      port: Number(backendPort),
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      // make -C bff run-fake.
      command: `go run ./cmd --port=${bffPort} --backend-address=127.0.0.1:${backendPort} --hub-api-url=http://127.0.0.1:${hubPort} --fake-backend --models-namespace=ai-grid-models`,
      cwd: '../bff',
      url: `http://127.0.0.1:${bffPort}/healthcheck`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: `pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
      // An API path, so the run starts once the proxy reaches the BFF and the BFF the fake.
      url: `${origin}/api/v1/tenants`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        BFF_URL: `http://127.0.0.1:${bffPort}`,
        AUTH_TOKEN: 'dev-token',
        AUTH_USER: 'dev-user',
      },
    },
    {
      // make dev-fake-infra-backend on the PoC preset (the backend's fixtures/poc): the first run
      // fetches the backend at the pin and builds it, hence the longer wait.
      command: '../hack/backend-fakes.sh',
      port: fakesBackendPort,
      reuseExistingServer: !process.env.CI,
      timeout: 600_000,
      env: {
        DEV_FIXTURES: 'fixtures/poc',
        DEV_DRAFT_FIXTURES: 'fixtures/draft/poc',
        DEV_GRPC_PORT: String(fakesBackendPort),
        DEV_HUB_PORT: String(fakesBackendPort + 1),
        DEV_HTTP_PORT: String(fakesBackendPort + 2),
        DEV_KEYCLOAK_PORT: String(fakesBackendPort + 3),
        DEV_DRAFT_PORT: String(fakesBackendPort + 4),
      },
    },
    {
      // make dev-bff-fake-infra: the BFF relays /ai_grid.v1.* to that backend.
      command: `go run ./cmd --port=${fakesBffPort} --backend-address=127.0.0.1:${fakesBackendPort} --hub-api-url=http://127.0.0.1:${fakesBackendPort + 1}`,
      cwd: '../bff',
      url: `http://127.0.0.1:${fakesBffPort}/healthcheck`,
      reuseExistingServer: !process.env.CI,
      timeout: 600_000,
    },
    {
      // Its own bundle directory, so the two builds never write the same files.
      command: `pnpm exec vite build --outDir dist-backend-fakes && pnpm exec vite preview --outDir dist-backend-fakes --host 127.0.0.1 --port ${fakesPort} --strictPort`,
      url: `${fakesOrigin}/api/v1/config`,
      reuseExistingServer: !process.env.CI,
      timeout: 600_000,
      env: {
        BFF_URL: `http://127.0.0.1:${fakesBffPort}`,
        AUTH_TOKEN: 'dev-token',
        AUTH_USER: 'dev-user',
      },
    },
  ],
});
