import { defineConfig } from "vitest/config";

// Unit tests only. Playwright's `*.spec.ts` files (tests/e2e, tests/scheduler,
// tests/panels) are never picked up here, and Playwright never runs these.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
