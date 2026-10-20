import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The root vitest.config.ts includes this eval (`npm test`); this config runs it alone with longer timeouts:
//   npx vitest run --config evals/product/vitest.config.ts
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // Keep vitest's cache in the root node_modules instead of creating one in this folder.
  cacheDir: fileURLToPath(new URL("../../node_modules/.vite/product-eval", import.meta.url)),
  test: {
    include: ["*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 600_000,
  },
});
