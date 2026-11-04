import { defineConfig } from "@playwright/test";

// No browser tests yet; they start with T04, which should also add a `webServer`
// entry here. Until then `pnpm --filter @eov/game test:e2e` passes with no tests.
export default defineConfig({
  testDir: "./tests",
  forbidOnly: !!process.env.CI,
});
