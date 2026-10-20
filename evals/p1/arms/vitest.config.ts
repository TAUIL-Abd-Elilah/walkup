import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The root vitest.config.ts includes these tests (`npm test`); this config runs them alone:
//   npx vitest run --config evals/p1/arms/vitest.config.ts
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // Keep vitest's cache in the root node_modules instead of creating one in this folder.
  cacheDir: fileURLToPath(new URL("../../../node_modules/.vite/p1-arms", import.meta.url)),
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
