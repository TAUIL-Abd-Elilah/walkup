import { describe, expect, it } from "vitest";
import { buildNarrationSchema, prepareRun, strictJsonSchema } from "../src/index";
import { makeInput } from "./helpers";

const valid = {
  summary: "Plain summary.",
  tileWhy: [{ geohash: "dn6m9q", text: "North Example over-indexes." }],
  partnerLines: [{ entityId: "E-P1", text: "Record store in North Example." }],
  copyHooks: [{ text: "Test folk at Sample Hall.", tagIds: ["urn:tag:genre:music:test_folk"] }],
};

describe("per-run narration schema", () => {
  const prepared = prepareRun(makeInput());
  const schema = buildNarrationSchema(prepared.ids);

  it("accepts ids present in this run", () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it("rejects a geohash from another run", () => {
    const bad = { ...valid, tileWhy: [{ geohash: "9q8yyk", text: "x" }] };
    expect(schema.safeParse(bad).success).toBe(false);
  });

  it("rejects a foreign entityId", () => {
    const bad = { ...valid, partnerLines: [{ entityId: "E-FOREIGN", text: "x" }] };
    expect(schema.safeParse(bad).success).toBe(false);
  });

  it("rejects a tag id that is not allowlisted", () => {
    const bad = { ...valid, copyHooks: [{ text: "x", tagIds: ["urn:tag:genre:music:not_listed"] }] };
    expect(schema.safeParse(bad).success).toBe(false);
  });

  it("drops denied tags from the allowlist before building the enum", () => {
    expect(prepared.ids.tagIds).not.toContain("urn:tag:religion:test");
    expect(prepared.deniedTagCount).toBe(1);
    const bad = { ...valid, copyHooks: [{ text: "test faith", tagIds: ["urn:tag:religion:test"] }] };
    expect(schema.safeParse(bad).success).toBe(false);
  });

  it("enumerates partner, pre/post and media ids, and no others", () => {
    expect(prepared.ids.entityIds).toEqual(["E-P1", "E-P2", "E-S1", "E-M1"]);
    expect(prepared.ids.geohashes).toEqual(["dn6m9q", "dn6m9r"]);
  });

  it("keeps the enums in the JSON schema sent to the API (not moved into descriptions)", () => {
    const json = strictJsonSchema(schema) as {
      properties: Record<string, { items: { properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }> } }>;
      additionalProperties: boolean;
      required: string[];
    };
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(["summary", "tileWhy", "partnerLines", "copyHooks"]);
    expect(json.properties["tileWhy"]!.items.properties["geohash"]!.enum).toEqual(["dn6m9q", "dn6m9r"]);
    expect(json.properties["partnerLines"]!.items.properties["entityId"]!.enum).toEqual(["E-P1", "E-P2", "E-S1", "E-M1"]);
    expect(json.properties["copyHooks"]!.items.properties["tagIds"]!.items!.enum).toEqual(prepared.ids.tagIds);
    expect(JSON.stringify(json)).not.toContain("$schema");
  });

  it("leaves out array fields whose id set is empty", () => {
    const s = buildNarrationSchema({ geohashes: [], entityIds: ["E-P1"], tagIds: [] });
    const json = strictJsonSchema(s) as { properties: Record<string, unknown> };
    expect(Object.keys(json.properties)).toEqual(["summary", "partnerLines"]);
    expect(s.safeParse({ summary: "s", partnerLines: [] }).success).toBe(true);
  });
});

describe("partner facts", () => {
  it("say which day the hours are for: the street-team day, else the show's weekday", () => {
    const hoursDay = (input: ReturnType<typeof makeInput>) =>
      (prepareRun(input).facts["partners"] as { hoursOnDay: string | null; hoursDay: string | null }[]).find((p) => p.hoursOnDay)?.hoursDay;
    expect(hoursDay({ ...makeInput(), streetTeamDay: "thursday" })).toBe("thursday");
    expect(hoursDay(makeInput())).toBe("saturday");
  });
});
