import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration.
 *
 * IMPORTANT — these tests have never been executed in this repository's
 * development environment. The Playwright browser binary cannot be downloaded
 * here (`npx playwright install chromium` fails with "Download failure,
 * code=1"), so every spec under `e2e/` is written but unrun. They are real
 * tests against real selectors, not placeholders, and they are expected to pass
 * once a browser is available — but "expected" is not "verified", and no claim
 * is made here that any of them has run. See DEVELOPMENT_LOG.md §3.
 *
 * The specs deliberately cover the things jsdom cannot: actual rendered pixels,
 * layout overflow, real focus, real fullscreen, and the four accessibility
 * checks that report SKIPPED in the headless QA harness because nothing is
 * mounted in the document there.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev -w @3dmm/web',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
