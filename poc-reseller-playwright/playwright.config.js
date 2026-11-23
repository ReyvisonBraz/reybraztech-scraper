import { defineConfig } from '@playwright/test';

const fixturePort = Number(process.env.POC_FIXTURE_PORT ?? 4173);
const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 10_000,
  expect: {
    timeout: 1_000,
  },
  reporter: 'list',
  outputDir: './.test-results',
  use: {
    baseURL: fixtureOrigin,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1400, height: 900 },
    actionTimeout: 1_000,
    navigationTimeout: 2_000,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  webServer: {
    command: 'node ./fixture/server.mjs',
    url: `${fixtureOrigin}/health`,
    reuseExistingServer: false,
    timeout: 15_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
