import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:15174",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @codex-remote/protocol-mock start",
      port: 18789,
      env: { ...process.env, REMOTE_CODEX_MOCK_PORT: "18789", REMOTE_CODEX_MOCK_HOST: "127.0.0.1", REMOTE_CODEX_MOCK_ISOLATED: "1" },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "pnpm exec vite --host 127.0.0.1 --port 15174 --strictPort",
      url: "http://127.0.0.1:15174",
      env: { ...process.env, VITE_BRIDGE_URL: "ws://127.0.0.1:18789/ws" },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    { name: "chromium", testIgnore: /mobile-safari\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", testIgnore: /mobile-safari\.spec\.ts/, use: { ...devices["Desktop Safari"] } },
    {
      name: "mobile-webkit",
      testMatch: /mobile-safari\.spec\.ts/,
      expect: { timeout: 15_000 },
      use: { ...devices["iPhone 14 Pro Max"] },
    },
  ],
});
