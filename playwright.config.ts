import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:4318",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
  webServer: {
    command: "pnpm start",
    url: "http://127.0.0.1:4318/api/health",
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      PORT: "4318",
      DATA_DIR: "work/e2e-data",
      NODE_ENV: "production",
    },
  },
  reporter: [
    ["list"],
    ["json", { outputFile: "work/evidence/browser-results.json" }],
  ],
});
