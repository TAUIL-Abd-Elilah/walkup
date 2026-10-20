/**
 * Web-local shapes that wrap the shared contracts. A fixture file is a
 * StreetSheet plus the fair-control arm that the "Without Qloo" toggle shows.
 * Generated fixtures (fixtures/synthetic/engine/, written by
 * packages/orchestrator/scripts/generate-fixture-sheets.ts) add a few
 * provenance fields; hand-built ones (fixtures/synthetic/*.sheet.json) do not.
 */
import type { ControlArmResult, StreetSheet } from "@walkup/contracts";

export interface SheetFixture {
  /** Always true: nothing in a fixture came from a live API. */
  synthetic: true;
  fixtureId: string;
  /** Short human title for pickers, e.g. "The Truth, Nashville: bill A". */
  title: string;
  /** Why this fixture exists and what is invented in it. */
  note: string;
  /** Plan id of the other bill in the same room ("Swap the bill"). */
  pairedWith?: string;
  sheet: StreetSheet;
  /** Arm F: same model + Google Places + ACS, same inputs. */
  control: ControlArmResult;
  /** Generated fixtures: the script that wrote the file. */
  generatedBy?: string;
  /** Generated fixtures: the synthetic world's seed. */
  worldSeed?: string;
  /** Generated fixtures: the orchestrator's call budget for the run. */
  budget?: Record<string, unknown>;
}

/** Where a preset sheet came from. */
export type FixtureSource = "engine" | "hand-built";
