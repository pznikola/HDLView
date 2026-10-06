import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  timeout: 120000,
  workers: 1,
  use: {
    actionTimeout: 10000,
    trace: "retain-on-failure",
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1500, height: 1000 },
  },
  webServer: {
    command:
      "node tools/frontend-assets.mjs && vite build --mode e2e && vite preview --mode e2e --host 127.0.0.1 --port 1420",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: false,
  },
});
