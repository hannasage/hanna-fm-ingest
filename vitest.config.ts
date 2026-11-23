import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/support/global-setup.ts"],
    // Tests share one local database, so files run one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 300_000,
  },
});
