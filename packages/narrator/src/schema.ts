/**
 * Per-run output schema for narration.
 *
 * geohash, entityId and tagIds are z.enum over the ids present in this run, so
 * structured output cannot produce an id from anywhere else. A field whose id
 * set is empty is left out of the schema (an enum needs at least one value)
 * and comes back as an empty array.
 */
import { z } from "zod";
import type { RunIds } from "./facts";

export interface NarrationDraft {
  summary: string;
  tileWhy: { geohash: string; text: string }[];
  partnerLines: { entityId: string; text: string }[];
  copyHooks: { text: string; tagIds: string[] }[];
}

/** What the schema validates: array fields are absent when the run had no ids for them. */
export type NarrationWire = { summary: string } & Partial<Omit<NarrationDraft, "summary">>;

function nonEmpty(values: ReadonlyArray<string>): [string, ...string[]] | null {
  const uniq = [...new Set(values)];
  return uniq.length > 0 ? (uniq as [string, ...string[]]) : null;
}

export function buildNarrationSchema(ids: RunIds): z.ZodType<NarrationWire> {
  const geohashes = nonEmpty(ids.geohashes);
  const entityIds = nonEmpty(ids.entityIds);
  const tagIds = nonEmpty(ids.tagIds);

  const shape: Record<string, z.ZodType> = {
    summary: z.string().describe("Two or three plain sentences for the top of the sheet."),
  };
  if (geohashes) {
    shape["tileWhy"] = z
      .array(
        z.object({
          geohash: z.enum(geohashes).describe("A tile geohash from the run facts."),
          text: z.string().describe("One sentence: why this tile is on the sheet."),
        }),
      )
      .describe("One entry per lift tile.");
  }
  if (entityIds) {
    shape["partnerLines"] = z
      .array(
        z.object({
          entityId: z.enum(entityIds).describe("A partner, pre/post or media entityId from the run facts."),
          text: z.string().describe("One line, at most 25 words."),
        }),
      )
      .describe("One line per partner place.");
  }
  if (tagIds) {
    shape["copyHooks"] = z
      .array(
        z.object({
          text: z.string().describe("A short poster or ad line built from allowlisted tag names."),
          tagIds: z.array(z.enum(tagIds)).describe("Allowlisted tag ids this line uses."),
        }),
      )
      .describe("Three copy hooks.");
  }
  // The dynamic shape loses static field types; NarrationWire is the contract.
  return z.object(shape) as unknown as z.ZodType<NarrationWire>;
}

export function toDraft(wire: NarrationWire): NarrationDraft {
  return {
    summary: wire.summary,
    tileWhy: wire.tileWhy ?? [],
    partnerLines: wire.partnerLines ?? [],
    copyHooks: wire.copyHooks ?? [],
  };
}
