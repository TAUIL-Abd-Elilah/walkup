/**
 * Writes the synthetic Street Sheet fixtures to fixtures/synthetic/.
 * Run from the repo root: npx tsx apps/web/scripts/build-fixtures.ts
 * Every file is validated before it is written; nothing calls a network API.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateFixture } from "../lib/validate";
import { buildAllFixtures, serializeFixture } from "./fixtures/index";

const outDir = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
mkdirSync(outDir, { recursive: true });

let failed = false;
for (const [file, fx] of Object.entries(buildAllFixtures())) {
  const errors = validateFixture(JSON.parse(serializeFixture(fx)));
  if (errors.length > 0) {
    failed = true;
    console.error(`${file}: ${errors.length} validation error(s)\n  - ${errors.join("\n  - ")}`);
    continue;
  }
  writeFileSync(`${outDir}${file}`, serializeFixture(fx), "utf8");
  console.log(`wrote ${file} (${fx.sheet.ledger.length} ledger entries, ${fx.sheet.cards.partners.results.length} partners)`);
}
if (failed) process.exit(1);
