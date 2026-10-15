import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    globalSetup: "./src/test-global-setup.ts",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
