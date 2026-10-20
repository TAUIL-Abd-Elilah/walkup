/**
 * Writes the four presets' Street Sheets, produced by the orchestrator on the
 * synthetic fixture world, to fixtures/synthetic/engine/<id>.sheet.json.
 *
 *   npx tsx packages/orchestrator/scripts/generate-fixture-sheets.ts [--out <dir>]
 *
 * It never touches the hand-built fixtures/synthetic/*.sheet.json: the output
 * directory may not be fixtures/synthetic itself. Each file is a fixture
 * wrapper with "synthetic": true at the top level. No network is used.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WORLD_SEED } from "@walkup/qloo-world";
import { createFixtureDeps, planShow, presetFor, PRESETS, PRESET_IDS, type PlanResult, type Preset } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const DEFAULT_OUT = join(repoRoot, "fixtures", "synthetic", "engine");
const HAND_BUILT = join(repoRoot, "fixtures", "synthetic");

/** Same directory, also through symlinks and Windows' case-insensitive paths. */
function sameDir(a: string, b: string): boolean {
  const canon = (p: string) => {
    const r = existsSync(p) ? realpathSync.native(p) : resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return canon(a) === canon(b);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const NOTE =
  "Made with Walkup's sample data; no live service was called. The venue and area names are real; " +
  "every act, business, podcast, brand and number is made up. Phone numbers use the reserved 555-01xx lines and websites the .example domain.";

async function runOne(preset: Preset): Promise<{ result: PlanResult; picked: string[] }> {
  // These sheets are always the fixture show, made on the fixture world.
  const clock = () => Date.parse(`${presetFor(preset, "fixture").asOf}T15:00:00Z`);
  const deps = createFixtureDeps({ clock, idGen: () => preset.id });
  let result = await planShow({ presetId: preset.id, planId: preset.id }, deps);
  const picked: string[] = [];
  if (result.status === "needs_input" && result.pause) {
    // The generator answers the pause the way an operator would: the comedian candidate.
    const resolutions: Record<string, string> = {};
    for (const p of result.pause.pending) {
      const pick = p.candidates.find((c) => c.subtype === "urn:entity:person") ?? p.candidates[0];
      if (pick) {
        resolutions[p.input] = pick.entityId;
        picked.push(p.input);
      }
    }
    result = await planShow({ presetId: preset.id, planId: preset.id, resolutions }, deps);
  }
  return { result, picked };
}

async function main(): Promise<void> {
  const out = resolve(arg("--out") ?? DEFAULT_OUT);
  if (sameDir(out, HAND_BUILT)) throw new Error("Refusing to write into fixtures/synthetic (hand-built sheets live there); use fixtures/synthetic/engine.");
  mkdirSync(out, { recursive: true });
  for (const id of PRESET_IDS) {
    const preset = PRESETS[id];
    const { result, picked } = await runOne(preset);
    if (result.status !== "complete" || !result.sheet) throw new Error(`${id}: ${result.status} ${result.error ?? ""}`);
    const sheet = result.sheet;
    const wrapper: Record<string, unknown> = {
      synthetic: true,
      fixtureId: id,
      title: presetFor(preset, "fixture").title,
      note: picked.length > 0 ? `${NOTE} Walkup's sample run picked ${picked.join(", ")} the way an operator would.` : NOTE,
      ...(preset.pairedWith ? { pairedWith: preset.pairedWith } : {}),
      generatedBy: "packages/orchestrator/scripts/generate-fixture-sheets.ts",
      worldSeed: DEFAULT_WORLD_SEED,
      budget: result.budget,
      sheet,
    };
    const file = join(out, `${id}.sheet.json`);
    writeFileSync(file, `${JSON.stringify(wrapper, null, 2)}\n`, "utf8");
    const cards = Object.entries(sheet.cards)
      .map(([k, c]) => `${k}:${c.status}`)
      .join(" ");
    console.log(`${id} -> ${file}\n  ${cards}\n  partners ${sheet.cards.partners.results.length}, guard drops ${sheet.guard.dropped}, qloo fresh ${result.budget.qlooFresh}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
