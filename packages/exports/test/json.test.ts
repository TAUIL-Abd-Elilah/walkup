import { describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { sanitizeSheet, SHEET_JSON_FORMAT, toSheetJson, type SheetJsonDocument } from "../src/json";
import { ledgerEntry, makeSheet, place, tag } from "./helpers";

describe("toSheetJson", () => {
  it("wraps the whole sheet, ledger included, and parses back unchanged when nothing needs cleaning", () => {
    const sheet = makeSheet();
    const doc = JSON.parse(toSheetJson(sheet)) as SheetJsonDocument;
    expect(doc.format).toBe(SHEET_JSON_FORMAT);
    expect(doc.formatVersion).toBe(1);
    expect(doc.planId).toBe("test-plan-1");
    expect(doc.mode).toBe("live");
    expect(doc.notice).toBeUndefined();
    expect(doc.sanitized).toEqual({ tagsRemoved: 0, secretsRedacted: 0 });
    expect(doc.sheet.ledger).toHaveLength(sheet.ledger.length);
    expect(doc.sheet.ledger.map((e) => e.id)).toEqual(sheet.ledger.map((e) => e.id));
    expect(doc.sheet).toEqual(JSON.parse(JSON.stringify(sheet)));
  });

  it("is pretty by default, compact on request, and ends with a newline", () => {
    const sheet = makeSheet();
    expect(toSheetJson(sheet)).toContain('\n  "format"');
    expect(toSheetJson(sheet, { pretty: false })).not.toContain('\n  "');
    expect(toSheetJson(sheet).endsWith("}\n")).toBe(true);
  });

  it("says so on fixture sheets", () => {
    const doc = JSON.parse(toSheetJson(makeSheet({ mode: "fixture" }))) as SheetJsonDocument;
    expect(doc.mode).toBe("fixture");
    expect(doc.notice).toBe("Sample data: made-up places and numbers, not a live run.");
  });

  it("is deterministic", () => {
    expect(toSheetJson(makeSheet())).toBe(toSheetJson(makeSheet()));
  });

  it("drops an older sheet's Google Places list, its step and its limits line", () => {
    const old: StreetSheet = {
      ...makeSheet(),
      control: { arm: "F", places: [{ placeId: "gp-1", name: "Example Tavern", query: "bar" }], overlapWithQloo: [], ledgerRefs: ["P1"] },
      steps: [{ id: "control", kind: "other", label: "Without Qloo", decision: "Built a list without Qloo from 1 Google Places search", status: "ok", ledgerRefs: ["P1"] }],
      limits: [...makeSheet().limits, "The Google Places list used fixed searches because no model key is set."],
    };
    const text = toSheetJson(old);
    expect(text).not.toContain("Example Tavern");
    expect(text).not.toContain("Without Qloo");
    expect(text).not.toContain("The Google Places list");
    const doc = JSON.parse(text) as SheetJsonDocument;
    expect(doc.sheet.control).toBeUndefined();
    expect(doc.sheet.steps).toEqual([]);
    expect(doc.sheet.limits).toEqual(makeSheet().limits);
  });
});

describe("sanitizeSheet", () => {
  function dirtySheet(): StreetSheet {
    const s = makeSheet();
    const p0 = s.cards.partners.results[0]!;
    const dirtyPartner = {
      ...p0,
      entity: {
        ...p0.entity,
        tags: [...p0.entity.tags, tag("urn:tag:religion:place:example", "Example denomination"), tag("urn:tag:cost_description:place:cheap", "Cheap")],
      },
    };
    const person = { ...place("syn-person-1", "A Performer"), subtype: "urn:entity:person", tags: [tag("urn:tag:genre:music:americana", "Americana")] };
    return {
      ...s,
      cards: {
        ...s.cards,
        partners: { ...s.cards.partners, results: [dirtyPartner, ...s.cards.partners.results.slice(1)] },
        resolution: { ...s.cards.resolution, results: [{ input: "A Performer", role: "headliner", status: "exact", entity: person }] },
        whatsDifferent: {
          ...s.cards.whatsDifferent,
          results: { shared: [], a: [tag("urn:tag:genre:music:americana", "Americana"), tag("urn:tag:political:media:x", "X")], b: [], fromTagDiff: false },
        },
        copyHooks: { ...s.cards.copyHooks, results: [{ text: "Americana night.", tagIds: ["urn:tag:genre:music:americana", "urn:tag:ethnicity:media:x"] }] },
      },
      ledger: [
        ...s.ledger,
        ledgerEntry("P2", "places", { params: { key: "AIzaLiteralValue123", textQuery: "record stores" }, curl: "curl -H 'X-Goog-Api-Key: AIzaLiteralValue123' 'https://example.com'" }),
        ledgerEntry("Q13", "qloo", { params: { "filter.type": "urn:entity:place", api_key: "$QLOO_API_KEY" }, curl: "curl 'https://example.com/v2/insights?apikey=literal123&x=1' -H \"X-Api-Key: $QLOO_API_KEY\"" }),
        ledgerEntry("L2", "anthropic", { curl: "curl -H 'Authorization: Bearer $ANTHROPIC_API_KEY'" }),
      ],
    };
  }

  it("removes denied tags wherever a tag list appears and strips person tags", () => {
    const { sheet, tagsRemoved } = sanitizeSheet(dirtySheet());
    expect(sheet.cards.partners.results[0]!.entity.tags.map((t) => t.id)).toEqual(["urn:tag:category:place:restaurant"]);
    expect(sheet.cards.resolution.results[0]!.entity!.tags).toEqual([]);
    expect(sheet.cards.whatsDifferent.results.a.map((t) => t.id)).toEqual(["urn:tag:genre:music:americana"]);
    expect(sheet.cards.copyHooks.results[0]!.tagIds).toEqual(["urn:tag:genre:music:americana"]);
    // 2 on the partner, 1 person tag, 1 compare tag, 1 hook tag id.
    expect(tagsRemoved).toBe(5);
  });

  it("redacts literal credentials but keeps $ENV references", () => {
    const { sheet, secretsRedacted } = sanitizeSheet(dirtySheet());
    const byId = new Map(sheet.ledger.map((e) => [e.id, e]));
    expect(byId.get("P2")!.params.key).toBe("[redacted]");
    expect(byId.get("P2")!.params.textQuery).toBe("record stores");
    expect(byId.get("P2")!.curl).toBe("curl -H 'X-Goog-Api-Key: [redacted]' 'https://example.com'");
    expect(byId.get("Q13")!.params.api_key).toBe("$QLOO_API_KEY");
    expect(byId.get("Q13")!.curl).toBe("curl 'https://example.com/v2/insights?apikey=[redacted]&x=1' -H \"X-Api-Key: $QLOO_API_KEY\"");
    expect(byId.get("L2")!.curl).toBe("curl -H 'Authorization: Bearer $ANTHROPIC_API_KEY'");
    expect(byId.get("T1")!.params.apikey).toBe("$TICKETMASTER_API_KEY");
    expect(secretsRedacted).toBe(3);
    expect(JSON.stringify(sheet)).not.toContain("AIzaLiteralValue123");
    expect(JSON.stringify(sheet)).not.toContain("literal123");
  });

  it("never mutates its input", () => {
    const input = dirtySheet();
    const before = JSON.stringify(input);
    sanitizeSheet(input);
    toSheetJson(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("can be turned off", () => {
    const doc = JSON.parse(toSheetJson(dirtySheet(), { sanitize: false })) as SheetJsonDocument;
    expect(doc.sanitized).toBeNull();
    expect(doc.sheet.ledger.find((e) => e.id === "P2")!.params.key).toBe("AIzaLiteralValue123");
  });
});
