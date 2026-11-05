import { defineConfig, devices } from "@playwright/test";

// Browser tests run against a test build (`--mode test`), which exposes the
// `window.__eov` hook (architecture §4). Building first, rather than using the
// dev server, checks that the simulation worker bundles.
//
// `*.spec.ts` only, so Vitest's `tests/unit/**/*.test.ts` files are never run
// here. No retries: a determinism or hash-parity failure must show, not be
// retried away (issue #11).
//
// Screenshot baselines are linux-only (CI runs on ubuntu, and text rendering
// differs by OS). Specs skip their screenshot assertions elsewhere.
const PORT = 4173;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  forbidOnly: !!process.env.CI,
  retries: 0,
  snapshotPathTemplate: "{testDir}/{testFileDir}/__screenshots__/{arg}{ext}",
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
