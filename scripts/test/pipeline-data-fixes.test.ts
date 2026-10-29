/**
 * Re-audit fixes (Oct 29) in the recorded-plan scripts: a revision's reused roster receipt names its node once, and the
 * recheck reads the kinds each place carries across one show's recorded sheets. Synthetic plans only.
 */
import { describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { createMemoryLedger } from "@walkup/contracts";
import { createRunLedger } from "../../packages/orchestrator/src/ledger";
import { reusedRosterNote } from "../precompute-revisions";
import { kindsByShow } from "../refresh-recorded-plans";

describe("a revision's reused roster receipt", () => {
  it("names its node once, as the run's ledger adds it", () => {
    const parent = { note: "node Q3 house roster (Ticketmaster)", startedAt: "2026-10-21T04:30:00.000Z" };
    expect(reusedRosterNote(parent)).toBe("the parent sheet's answer (2026-10-21), reused so the room's usual crowd stays the same");
    const ledger = createRunLedger(createMemoryLedger(), { fixture: false });
    ledger.node("Q3 house roster (Ticketmaster)", "venue");
    const id = ledger.add({
      kind: "tm",
      method: "GET",
      endpoint: "/discovery/v2/events.json",
      params: {},
      httpStatus: 200,
      envelopeStatus: "ok",
      latencyMs: 1,
      bytes: 0,
      cacheHit: true,
      resultCount: 41,
      curl: "",
      startedAt: parent.startedAt,
      note: reusedRosterNote(parent),
    });
    expect(ledger.entries().find((e) => e.id === id)?.note).toBe(
      "node Q3 house roster (Ticketmaster); the parent sheet's answer (2026-10-21), reused so the room's usual crowd stays the same",
    );
  });
  it("keeps the parent note's own detail", () => {
    expect(reusedRosterNote({ note: "node Q3 house roster (Ticketmaster); 41 shows", startedAt: "2026-10-21T04:30:00.000Z" })).toBe(
      "41 shows; the parent sheet's answer (2026-10-21), reused so the room's usual crowd stays the same",
    );
  });
});

describe("kinds across one show's recorded sheets", () => {
  const sheet = (rows: [string, string][], parent?: string) =>
    ({
      cards: { partners: { results: rows.map(([entityId, category]) => ({ entity: { entityId }, category })) } },
      ...(parent ? { revision: { parentPlanId: parent } } : {}),
    }) as unknown as StreetSheet;
  const plans = [
    { planId: "P", sheet: sheet([["X", "restaurant"], ["Y", "cafe"]]) },
    { planId: "C1", sheet: sheet([["X", "bar"]], "P") },
    { planId: "C2", sheet: sheet([["X", "bar"]], "C1") },
    { planId: "Q", sheet: sheet([["X", "cafe"]]) },
  ];
  it("gathers a place's kinds from the parent and every change of it, never from another show", () => {
    const kinds = kindsByShow(plans);
    expect(kinds("P")("X")).toEqual(["restaurant", "bar"]);
    expect(kinds("C2")("X")).toEqual(["restaurant", "bar"]);
    expect(kinds("Q")("X")).toEqual(["cafe"]);
    expect(kinds("P")("Z")).toEqual([]);
  });
});
