import { defineConfig } from '@playwright/test';

// Live flow automation, one spec per platform, one test per flow, against a RUNNING Lensa (no webServer).
//   npx playwright test -c playwright.flows.config.ts e2e/flows/iroha3.flows.spec.ts           # one platform
//   npx playwright test -c playwright.flows.config.ts -g "zeto dvp"                             # one flow
//   npx playwright test -c playwright.flows.config.ts                                           # all platforms (~45 min)
// Watch it: add --headed (local PC with a display) or --ui (UI mode: steps, live view, trace).
// Env: LENSA_URL (default http://127.0.0.1:8790), SLOWMO (ms between actions, for watching).
// Every flow writes real transactions on the live networks.
export default defineConfig({
  testDir: 'e2e/flows',
  testMatch: '**/*.flows.spec.ts',
  workers: 1, // one Lensa server, one transaction at a time
  fullyParallel: false,
  retries: 0,
  timeout: 10 * 60_000, // Iroha 3 private DvP measured 163-168 s; Paladin proofs can take minutes
  expect: { timeout: 30_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-flows' }]],
  use: {
    baseURL: process.env.LENSA_URL ?? 'http://127.0.0.1:8790',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: process.env.VIDEO ? 'on' : 'off',
    launchOptions: { slowMo: Number(process.env.SLOWMO ?? 0) },
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
