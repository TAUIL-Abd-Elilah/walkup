import { describe, expect, it } from "vitest";
import { PARSE_SYSTEM_PROMPT, heuristicShowQuery, parseShowQuery } from "../src/index";
import { fakeMessage, mockClient } from "./helpers";

describe("parseShowQuery", () => {
  it("uses structured output at effort low and keeps the reference date out of the system prompt", async () => {
    const { client, calls } = mockClient([
      fakeMessage({ content: JSON.stringify({ artist: "Test Headliner", venue: "Sample Hall", city: "Exampleton", date: "2026-11-28" }) }),
    ]);
    const res = await parseShowQuery("Test Headliner at Sample Hall this Saturday", { client, today: "2026-11-23" });
    expect(res).toMatchObject({ source: "llm", artist: "Test Headliner", venue: "Sample Hall", city: "Exampleton", date: "2026-11-28" });
    const p = calls[0]!;
    expect(p.output_config?.effort).toBe("low");
    expect(p.output_config?.format?.type).toBe("json_schema");
    expect(p.fallbacks).toBe("default");
    expect((p.system as { text: string }[])[0]!.text).toBe(PARSE_SYSTEM_PROMPT);
    expect(String(p.messages[0]!.content)).toContain("Reference date: 2026-11-23");
  });

  it("drops nulls and invalid dates", async () => {
    const { client } = mockClient([
      fakeMessage({ content: JSON.stringify({ artist: "Test Headliner", venue: null, city: null, date: "2026-02-31" }) }),
    ]);
    const res = await parseShowQuery("Test Headliner", { client });
    expect(res.source).toBe("llm");
    expect(res).not.toHaveProperty("venue");
    expect(res).not.toHaveProperty("date");
  });

  it("falls back to the heuristic on refusal and when the LLM is off", async () => {
    const { client } = mockClient([fakeMessage({ content: [], stop_reason: "refusal" })]);
    const refused = await parseShowQuery("Test Headliner at Sample Hall, Exampleton on 2026-11-28", { client });
    expect(refused).toMatchObject({ source: "heuristic", reason: "refusal", artist: "Test Headliner", venue: "Sample Hall", city: "Exampleton", date: "2026-11-28" });
    const off = await parseShowQuery("Test Headliner at Sample Hall");
    expect(off).toMatchObject({ source: "heuristic", reason: "llm_off", artist: "Test Headliner", venue: "Sample Hall" });
  });
});

describe("heuristicShowQuery", () => {
  it("parses month-name dates and 'in City'", () => {
    expect(heuristicShowQuery("Test Headliner @ Sample Hall in Exampleton, Sat Nov 28 2026")).toEqual({
      artist: "Test Headliner",
      venue: "Sample Hall",
      city: "Exampleton",
      date: "2026-11-28",
    });
  });

  it("never guesses a year", () => {
    expect(heuristicShowQuery("Test Headliner at Sample Hall Nov 28")).not.toHaveProperty("date");
  });
});
