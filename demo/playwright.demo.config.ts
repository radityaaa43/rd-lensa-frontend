import { defineConfig } from '@playwright/test';

// Driven by demo/cli.ts (env DEMO_*); not meant to be run by hand. Live = the service on :8790. Mock = a scratch server on :8791
// (stateful, from lib/mock-server.ts) that builds the web into demo/out/.mock/web/dist, never into the served web/dist.
const mock = process.env.DEMO_MOCK === '1';
const port = process.env.DEMO_MOCK_PORT ?? '8791';
const out = process.env.DEMO_OUT ?? 'out/adhoc';

export default defineConfig({
  testDir: 'scenarios',
  testMatch: 'run.spec.ts',
  globalSetup: './lib/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: mock ? 3 * 60_000 : 25 * 60_000,
  expect: { timeout: mock ? 15_000 : 120_000 },
  reporter: 'list',
  outputDir: `${out}/pw`,
  use: { baseURL: mock ? `http://127.0.0.1:${port}` : (process.env.DEMO_BASE ?? 'http://127.0.0.1:8790'), viewport: { width: 1440, height: 900 }, trace: 'off' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: mock ? { command: `PORT=${port} npx tsx lib/mock-server.ts`, url: `http://127.0.0.1:${port}/api/meta`, reuseExistingServer: false, timeout: 120_000 } : undefined,
});
