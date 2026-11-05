import { defineConfig, devices } from "@playwright/test";

// Browser tests run against a test build (`--mode test`), which exposes the
// `window.__eov` hook (architecture §4). Building first, rather than using the
// dev server, checks that the simulation worker bundles.
const PORT = 4173;

export default defineConfig({
  testDir: "./tests",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `vite build --mode test && vite preview --mode test --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
