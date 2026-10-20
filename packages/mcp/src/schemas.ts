/**
 * Tool input schemas (strict: unknown keys are rejected) and the shared output
 * schema of the envelope. Types and sizes are checked here; policy (emails,
 * campaigns, exactly one source) is checked by the tools so refusals come back
 * as envelopes with a reason.
 */
import { WEEKDAYS } from "@walkup/contracts";
import { z } from "zod";

export const PlanIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Plan ids match ^[A-Za-z0-9_-]{1,64}$.")
  .describe("A plan id returned by plan_show or rank_partners, or a preset id (g1-a, g1-b, g2, g3).");

const EventSchema = z
  .string()
  .trim()
  .min(3)
  .max(500)
  .describe('A Ticketmaster event link (https://www.ticketmaster.com/.../event/<id>) or "Artist @ Venue, Date", e.g. "Hollis Creek String Band @ The Truth, Nov 20 2026".');

const PresetSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe("A prewarmed preset: g1-a and g1-b (The Truth, Nashville, two bills in one room), g2 (Hampton Coliseum), g3 (Super Funny, Tacoma).");

export const OperatorSchema = z
  .strictObject({
    seatsLeft: z.number().int().min(0).max(250_000).nullable().optional().describe("What-if count of unsold seats. Shown with a HYPOTHETICAL watermark; never sales data."),
    capacity: z.number().int().min(1).max(250_000).nullable().optional().describe("Room capacity the operator enters."),
    mediaBudgetUsd: z.number().min(0).max(10_000_000).nullable().optional().describe("Media money left, in USD (what-if)."),
    radiusKm: z.number().min(1).max(100).optional().describe("Search radius around the venue in km (default 40)."),
    streetTeamDays: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional().describe("Days the street team works; partner hours are checked against them."),
  })
  .describe("Operator what-ifs. Pass only what the user offers; never ticket buyer data.");

export const PickSchema = z.strictObject({
  input: z.string().trim().min(1).max(500).describe("The ambiguous input exactly as returned in resolution[].input."),
  entityId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9:._-]+$/, "Entity ids are letters, digits and : . _ -")
    .describe("The candidate's entityId the user chose (never pick for them)."),
});

const PicksSchema = z.array(PickSchema).min(1).max(10).describe("Answers to an earlier needs_input: one pick per ambiguous input.");

export const PlanShowInput = z.strictObject({
  event: EventSchema.optional(),
  presetId: PresetSchema.optional(),
  planId: PlanIdSchema.optional().describe("Resume a plan that returned needs_input (with picks), or re-read a finished plan."),
  operator: OperatorSchema.optional(),
  picks: PicksSchema.optional(),
});
export type PlanShowArgs = z.infer<typeof PlanShowInput>;

export const RankPartnersInput = z.strictObject({
  planId: PlanIdSchema.optional().describe("Rank against this plan's bill (a finished plan or a preset id)."),
  event: EventSchema.optional(),
  presetId: PresetSchema.optional(),
  partnerNames: z
    .array(z.string().trim().min(1).max(120))
    .min(1)
    .max(20)
    .describe("The user's own partner businesses or channels, by name (at most 20). Names only: no emails, phones or contacts."),
  operator: OperatorSchema.optional(),
  picks: PicksSchema.optional(),
});
export type RankPartnersArgs = z.infer<typeof RankPartnersInput>;

export const PlanRefInput = z.strictObject({ planId: PlanIdSchema });
export type PlanRefArgs = z.infer<typeof PlanRefInput>;

export const RevisePlanInput = z.strictObject({
  planId: PlanIdSchema.describe("The finished plan to change: a plan id from plan_show or revise_plan, or a preset id (g1-a, g1-b, g2, g3)."),
  instruction: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(`What to change, in the user's own words, e.g. "All ages: no bars", "skip Germantown", "only Saturday", "within 10 km". No contact details.`),
});
export type RevisePlanArgs = z.infer<typeof RevisePlanInput>;

const CandidateOut = z.looseObject({
  entityId: z.string(),
  name: z.string(),
  subtype: z.string(),
  popularity: z.number().nullable(),
});

const ResolutionOut = z.looseObject({
  input: z.string(),
  role: z.string(),
  status: z.enum(["exact", "needs_input", "proxy", "unresolved"]),
  candidates: z.array(CandidateOut).optional(),
});

/** The envelope every tool returns as structuredContent (the web app's JSON API shape). */
export const EnvelopeOutput = z.looseObject({
  status: z.enum(["ok", "empty", "needs_input", "partial", "degraded", "error"]),
  summary: z.string(),
  planId: z.string().nullable(),
  sheetUrl: z.string().nullable(),
  planUrl: z.string().nullable().optional(),
  mode: z.enum(["live", "fixture", "recorded"]),
  results: z.unknown().describe("plan_show / get_sheet: the Street Sheet; rank_partners: the declared partners in call order; bill_vs_house: lift tiles, compare and demographics; null on needs_input or error."),
  resolution: z.array(ResolutionOut),
  cards: z.record(z.string(), z.enum(["ok", "empty", "needs_input", "partial", "degraded", "error"])).optional().describe("Each card's status, in stream order."),
  pending: z
    .array(z.looseObject({ input: z.string(), candidates: z.array(CandidateOut) }))
    .optional()
    .describe("Names waiting for a pick, with their candidates."),
  reason: z.string().optional(),
  provenance: z.array(z.string()),
  limits: z.array(z.string()),
  freshRuns: z.strictObject({ leftForCaller: z.number().int(), leftToday: z.number().int() }).optional(),
});
