/**
 * The MCP server: five tools over the shared services. One server per caller
 * (per HTTP request in stateless mode, one per stdio process), so the caller's
 * address is bound here and every cap is keyed on it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorEnvelope, scrubSecrets, scrubText, type ToolEnvelope } from "./envelope";
import { EnvelopeOutput, presetIdsFor, toolInputs } from "./schemas";
import type { McpServices } from "./services";
import { envelopeText } from "./text";
import { billVsHouseTool, envelopeMode, getSheetTool, planShowTool, rankPartnersTool, revisePlanTool, sampleOnly, type Caller, type ToolOutcome } from "./tools";

export const SERVER_NAME = "walkup";
export const SERVER_VERSION = "0.1.0";

/**
 * What the server tells a client at initialize. The preset list is the one this server serves: a sample-mode server
 * (the synthetic world only) leaves out g4-a and g4-b, which plan real shows only and which it refuses.
 */
export function serverInstructions(sample: boolean): string {
  return [
    "Walkup plans local promotion for one live show that is already booked and still has seats to sell.",
    "It compares this bill's crowd with the venue's usual crowd using Qloo taste data and returns a Street Sheet: lift tiles (where this crowd over-indexes), real local partner places, pre/post-show spots, podcasts, one sponsor and copy hooks, each with a numbered receipt such as [Q9].",
    `Start with plan_show (a Ticketmaster event link, "Artist @ Venue, Date", or a preset: ${presetIdsFor(sample).join(", ")}). If it returns needs_input, show the candidates to the user and call plan_show again with the planId and the user's picks; never pick for them.`,
    "Use rank_partners for the user's own partner list, bill_vs_house for the crowd comparison alone, get_sheet to re-read a plan.",
    "Use revise_plan to change a finished sheet with the user's own words (all ages, leave out a type of place, skip an area, street-team days, search radius). It returns a new plan id and the list of changes; if it returns a question, ask the user and call it again.",
    "Cite places and numbers exactly as returned, with their receipts. Partners are suggested, not affiliated. Always pass on the limits. If mode is fixture, say the data is synthetic, not live.",
    "Seat counts are what-ifs: pass them only if the user offers them, and never call a real show soft or selling badly.",
    "Send only what the user typed: event text, partner names, what-if numbers. Never send personal data, buyer data or contact details. Sending the sheet to anyone happens only in the Walkup web app after the user confirms.",
    "Fresh runs are capped per caller per day; presets and existing plans are not. Without a live Qloo key the data is synthetic (mode fixture), and a hosted server then runs presets only.",
    "If a tool answers with mode recorded, the server serves sheets recorded from live Qloo and Ticketmaster runs, and live runs are paused for judging: get_sheet, bill_vs_house and plan_show for a preset or a plan id read those sheets, which come from live runs, with any change since made offline and no API call (say the day each was recorded). New plans, rank_partners and revise_plan are not run while live runs are paused; revise_plan names any recorded revision of the plan and says which one makes the change the note asks for, when the server can tell.",
    "The presets g2 and g3 have no live show: where they open, they are sample sheets with made-up places and numbers (mode fixture).",
  ].join("\n");
}

/** The instructions of a live or recorded server (every preset). */
export const SERVER_INSTRUCTIONS = serverInstructions(false);

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Envelope as MCP result: structuredContent + a short text digest; secrets scrubbed from both. */
export function toCallResult(tool: string, outcome: ToolOutcome, services: Pick<McpServices, "secrets">): CallToolResult {
  const envelope = scrubSecrets(outcome.envelope, services.secrets) as ToolEnvelope;
  const text = scrubText(envelopeText(tool, envelope), services.secrets);
  return {
    content: [{ type: "text", text }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    ...(envelope.status === "error" ? { isError: true } : {}),
  };
}

async function guarded(tool: string, services: McpServices, run: () => Promise<ToolOutcome>): Promise<CallToolResult> {
  try {
    return toCallResult(tool, await run(), services);
  } catch (err) {
    const reason = `${tool} failed: ${err instanceof Error ? err.message : String(err)}`;
    return toCallResult(tool, { envelope: errorEnvelope(reason, envelopeMode(services)), httpStatus: 500 }, services);
  }
}

export function createWalkupMcpServer(services: McpServices, caller: Caller): McpServer {
  const sample = sampleOnly(services);
  const presets = presetIdsFor(sample).join(", ");
  const inputs = toolInputs(sample);
  const server = new McpServer({ name: SERVER_NAME, title: "Walkup", version: SERVER_VERSION }, { instructions: serverInstructions(sample) });

  server.registerTool(
    "plan_show",
    {
      title: "Plan a show's street team",
      description:
        "Build a Street Sheet for one booked show: where this bill's crowd over-indexes versus the room's usual crowd, real local partner places ranked in the areas where that crowd stands out, pre/post spots, podcasts, a sponsor and copy hooks, each with receipts. " +
        `Give exactly one of: event (a Ticketmaster event link or "Artist @ Venue, Date"), presetId (${presets}), or planId (resume a plan that returned needs_input, with picks). ` +
        "Optional operator what-ifs (seats left, capacity, radius, street-team days). A fresh run takes about 20 seconds live and counts against a per-caller daily cap; presets do not. " +
        "Returns the envelope: status, summary, planId, sheetUrl, mode, results (the Street Sheet with its ledger), resolution, provenance, limits.",
      inputSchema: inputs.planShow,
      outputSchema: EnvelopeOutput,
      annotations: { title: "Plan a show's street team", ...WRITE },
    },
    async (args) => guarded("plan_show", services, () => planShowTool(services, caller, args)),
  );

  server.registerTool(
    "rank_partners",
    {
      title: "Rank the user's own partners",
      description:
        "Rank the user's own partner list (up to 20 business or channel names) by this bill's crowd, in call order. Names not in Qloo's catalog stay on the list, kept in your order (rank null). " +
        "Give exactly one of planId (a finished plan or preset id), event, or presetId, plus partnerNames. Names only: never emails, phones or contacts. Counts as a fresh run. " +
        "results: the declared partners with rank (null = not scored), entity and receipt chips.",
      inputSchema: inputs.rankPartners,
      outputSchema: EnvelopeOutput,
      annotations: { title: "Rank the user's own partners", ...WRITE },
    },
    async (args) => guarded("rank_partners", services, () => rankPartnersTool(services, caller, args)),
  );

  server.registerTool(
    "bill_vs_house",
    {
      title: "Bill vs house crowd",
      description:
        "For an existing plan (or preset id): where this bill's crowd differs from the venue's usual crowd. results: lift tiles (named, with lift and adult counts), the baseline used (house: the room's roster; tag: a pinned genre tag, only when one is pinned; none: neither, so there is no lift map), what is distinctive to each side, and age/gender skew. Reads the stored plan (a preset not yet stored is run once). " +
        "Lift tiles are where this bill's fans over-index, not where buyers live.",
      inputSchema: inputs.planRef,
      outputSchema: EnvelopeOutput,
      annotations: { title: "Bill vs house crowd", ...READ },
    },
    async (args) => guarded("bill_vs_house", services, () => billVsHouseTool(services, caller, args)),
  );

  server.registerTool(
    "get_sheet",
    {
      title: "Get a Street Sheet",
      description:
        `Re-read an existing plan by id (or a preset id: ${presets}). Returns the same envelope as plan_show: the Street Sheet with its ledger, or the pending picks when the plan is waiting for input. Reads the stored plan (a preset not yet stored is run once).`,
      inputSchema: inputs.planRef,
      outputSchema: EnvelopeOutput,
      annotations: { title: "Get a Street Sheet", ...READ },
    },
    async (args) => guarded("get_sheet", services, () => getSheetTool(services, caller, args)),
  );

  server.registerTool(
    "revise_plan",
    {
      title: "Revise a Street Sheet",
      description:
        "Change a finished plan with the user's note, e.g. \"All ages: no bars\", \"skip Germantown\", \"only Saturday\" or \"within 10 km\". " +
        "The note is read by the model with fixed tools (all ages, leave out place types, skip areas on the sheet, street-team days, radius 5-60 km), or by fixed rules when no model is set up. " +
        "Returns the revised sheet under a new plan id, with results.revision listing the tool calls and every change with receipts. An unclear note returns needs_input with a question and changes nothing. Counts as a fresh run; unchanged requests come from the cache.",
      inputSchema: inputs.revisePlan,
      outputSchema: EnvelopeOutput,
      annotations: { title: "Revise a Street Sheet", ...WRITE },
    },
    async (args) => guarded("revise_plan", services, () => revisePlanTool(services, caller, args)),
  );

  return server;
}
