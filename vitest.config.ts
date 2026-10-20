import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "scripts/test/**/*.test.ts",
      "apps/web/test/**/*.test.ts",
      // The 20-case product eval (evals/product) and the P1 arm runner (evals/p1/arms), all offline.
      "evals/product/*.test.ts",
      "evals/p1/arms/test/**/*.test.ts",
    ],
    environment: "node",
    // Fixture-world plans take 1-5 s each and many test files run in parallel. A test with a few full runs
    // takes about 6 s alone but 33-39 s when the whole suite runs (Oct 14), so 30 s was not enough.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
