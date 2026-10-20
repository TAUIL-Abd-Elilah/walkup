import { createMemoryLedger } from "@walkup/contracts";
import { describe, expect, it } from "vitest";
import {
  ACS_GET_VARIABLES,
  AcsError,
  adults21PlusOf,
  createAcsClient,
  parseCensusNumber,
  parseCensusTable,
  summarizeAreas,
  VARS_FEMALE_UNDER_21,
  VARS_MALE_UNDER_21,
} from "../src/index";
import { fakeClock, fakeFetch, json, loadSynthetic } from "./helpers";

// Not a real key: a placeholder that must never reach the ledger or curl.
const KEY = "unit-test-placeholder-key";
const table = loadSynthetic<string[][]>("zcta.synthetic.json");
const header = table[0]!;

/** Synthetic responder: one row per requested ZCTA (all values derived from the ZCTA). */
function echoZctas(url: string): Response {
  const forParam = new URL(url).searchParams.get("for") ?? "";
  const zctas = forParam.split(":")[1]!.split(",");
  const rows = zctas.map((z) => header.map((h) => (h === "NAME" ? `ZCTA5 ${z}` : h === "zip code tabulation area" ? z : "100")));
  return json([header, ...rows]);
}

function setup(responder: (url: string, n: number) => Response, extra: Parameters<typeof createAcsClient>[0] = {}) {
  const clock = fakeClock();
  const ledger = createMemoryLedger();
  const f = fakeFetch((u, _i, n) => responder(u, n), clock);
  const acs = createAcsClient({ apiKey: "", fetch: f.fn, ledger, now: clock.now, sleep: clock.sleep, ...extra });
  return { clock, ledger, f, acs };
}

describe("variables and arithmetic", () => {
  it("uses the documented B01001 under-21 bins", () => {
    expect(VARS_MALE_UNDER_21).toEqual(["B01001_003E", "B01001_004E", "B01001_005E", "B01001_006E", "B01001_007E", "B01001_008E"]);
    expect(VARS_FEMALE_UNDER_21).toEqual(["B01001_027E", "B01001_028E", "B01001_029E", "B01001_030E", "B01001_031E", "B01001_032E"]);
    expect(ACS_GET_VARIABLES).toHaveLength(17);
    expect(ACS_GET_VARIABLES.length).toBeLessThanOrEqual(50);
  });

  it("computes adults 21+ as total minus the twelve under-21 bins", () => {
    const [r1, r2, r3] = parseCensusTable(table);
    // 10000 - (300+310+320+200+150+80) - (290+300+310+190+140+70) = 10000 - 1360 - 1300
    expect(adults21PlusOf(r1!)).toBe(7340);
    // 5000 - 420 - 420
    expect(adults21PlusOf(r2!)).toBe(4160);
    expect(adults21PlusOf(r3!)).toBe(0);
  });

  it("returns null adults when any bin is a sentinel or missing", () => {
    const [r1] = parseCensusTable(table);
    expect(adults21PlusOf({ ...r1!, B01001_031E: "-666666666" })).toBeNull();
    expect(adults21PlusOf({ ...r1!, B01001_001E: null })).toBeNull();
    const { B01001_008E: _drop, ...partial } = r1!;
    expect(adults21PlusOf(partial)).toBeNull();
    // Bins larger than the total: inconsistent, so null rather than a clamped 0.
    expect(adults21PlusOf({ ...r1!, B01001_001E: "1000" })).toBeNull();
  });

  it("parses numbers and sentinels", () => {
    expect(parseCensusNumber("-666666666")).toBeNull();
    expect(parseCensusNumber("-999999999")).toBeNull();
    expect(parseCensusNumber(-888888888)).toBeNull();
    expect(parseCensusNumber("250001")).toBe(250001);
    expect(parseCensusNumber(" 34.5 ")).toBe(34.5);
    expect(parseCensusNumber("")).toBeNull();
    expect(parseCensusNumber(null)).toBeNull();
    expect(parseCensusNumber("N")).toBeNull();
  });

  it("parses tables robustly", () => {
    const recs = parseCensusTable([["NAME", "B01003_001E", "state"], ["X", 12, "47"], ["Y", null], "junk"]);
    expect(recs).toEqual([
      { NAME: "X", B01003_001E: "12", state: "47" },
      { NAME: "Y", B01003_001E: null, state: null },
    ]);
    expect(parseCensusTable([["NAME"]])).toEqual([]);
    expect(() => parseCensusTable({ error: "x" })).toThrow(TypeError);
    expect(() => parseCensusTable([])).toThrow(TypeError);
  });
});

describe("byZctas", () => {
  it("requests ZCTAs and maps rows, reading columns by header", async () => {
    const { f, ledger, acs } = setup(() => json(table));
    const res = await acs.byZctas(["00001", "00002", " 00003", "00001", "00004"]);
    const url = f.calls[0]!.url;
    expect(url.startsWith("https://api.census.gov/data/2024/acs/acs5?get=NAME,B01003_001E,B01002_001E,B19013_001E,B01001_001E,")).toBe(true);
    expect(url).toContain("&for=zip%20code%20tabulation%20area:00001,00002,00003,00004");
    expect(url).not.toContain("key=");

    expect(res.year).toBe(2024);
    expect(res.missing).toEqual(["00004"]);
    expect(res.rows).toEqual([
      { geoType: "zcta", geoId: "00001", name: "ZCTA5 00001", totalPopulation: 10000, medianAge: 34.5, medianHouseholdIncome: 72000, adults21Plus: 7340, year: 2024 },
      { geoType: "zcta", geoId: "00002", name: "ZCTA5 00002", totalPopulation: 5000, medianAge: null, medianHouseholdIncome: null, adults21Plus: 4160, year: 2024 },
      { geoType: "zcta", geoId: "00003", name: "ZCTA5 00003", totalPopulation: 0, medianAge: null, medianHouseholdIncome: null, adults21Plus: 0, year: 2024 },
    ]);
    expect(ledger.entries()[0]).toMatchObject({
      id: "C1",
      kind: "acs",
      method: "GET",
      endpoint: "/data/2024/acs/acs5",
      httpStatus: 200,
      envelopeStatus: "ok",
      resultCount: 3,
    });
    expect(ledger.entries()[0]!.params.for).toBe("zip code tabulation area:00001,00002,00003,00004");
  });

  it("does not depend on column order", async () => {
    const order = [...header.keys()].reverse();
    const shuffled = table.map((row) => order.map((i) => row[i]!));
    const { acs } = setup(() => json(shuffled));
    const res = await acs.byZctas(["00001"]);
    expect(res.rows[0]).toMatchObject({ geoId: "00001", adults21Plus: 7340, medianHouseholdIncome: 72000 });
  });

  it("batches 50 ZCTAs per request at a polite pace", async () => {
    const { f, ledger, acs } = setup(echoZctas);
    const zctas = Array.from({ length: 120 }, (_, i) => String(10000 + i));
    const res = await acs.byZctas(zctas);
    expect(f.calls).toHaveLength(3);
    const sizes = f.calls.map((c) => new URL(c.url).searchParams.get("for")!.split(":")[1]!.split(",").length);
    expect(sizes).toEqual([50, 50, 20]);
    expect(f.calls[1]!.at - f.calls[0]!.at).toBeGreaterThanOrEqual(1000);
    expect(f.calls[2]!.at - f.calls[1]!.at).toBeGreaterThanOrEqual(1000);
    expect(res.rows).toHaveLength(120);
    expect(res.missing).toEqual([]);
    expect(res.ledgerRefs).toEqual(["C1", "C2", "C3"]);
    expect(ledger.entries().every((e) => e.kind === "acs")).toBe(true);
    // 100 total minus 12 bins of 100 is negative: an inconsistent row gives null, not 0.
    expect(res.rows[0]!.adults21Plus).toBeNull();
    expect(summarizeAreas(res.rows)).toMatchObject({ adults21Plus: null, adultsMissing: 120 });
  });

  it("falls back to 2023 on 404 and stays there", async () => {
    const { f, ledger, acs } = setup((url) => (url.includes("/2024/") ? new Response("<h1>404</h1>", { status: 404 }) : json(table)));
    const res = await acs.byZctas(["00001"]);
    expect(res.year).toBe(2023);
    expect(res.rows[0]!.year).toBe(2023);
    expect(acs.year()).toBe(2023);
    expect(res.ledgerRefs).toEqual(["C1", "C2"]);
    expect(ledger.entries()[0]).toMatchObject({ httpStatus: 404, envelopeStatus: "error", endpoint: "/data/2024/acs/acs5" });
    expect(ledger.entries()[0]!.note).toMatch(/falling back to 2023/);
    expect(ledger.entries()[1]).toMatchObject({ httpStatus: 200, endpoint: "/data/2023/acs/acs5" });

    await acs.byZctas(["00002"]);
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(["/data/2024/acs/acs5", "/data/2023/acs/acs5", "/data/2023/acs/acs5"]);
  });

  it("throws on 404 when fallback is disabled", async () => {
    const { acs } = setup(() => new Response("not found", { status: 404 }), { fallbackYear: null });
    await expect(acs.byZctas(["00001"])).rejects.toBeInstanceOf(AcsError);
  });

  it("treats 204 No Content as no rows", async () => {
    const { ledger, acs } = setup(() => new Response(null, { status: 204 }));
    const res = await acs.byZctas(["00009"]);
    expect(res.rows).toEqual([]);
    expect(res.missing).toEqual(["00009"]);
    expect(ledger.entries()[0]).toMatchObject({ httpStatus: 204, envelopeStatus: "empty" });
  });

  it("surfaces Census text errors and bad keys", async () => {
    const a = setup(() => new Response("error: unknown variable 'B01001_999E'", { status: 400 }));
    const err = (await a.acs.byZctas(["00001"]).catch((e: unknown) => e)) as AcsError;
    expect(err).toBeInstanceOf(AcsError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("unknown variable");

    const b = setup(() => new Response("<html><body>Invalid Key: the key is not valid</body></html>", { status: 200 }), { apiKey: KEY });
    const err2 = (await b.acs.byZctas(["00001"]).catch((e: unknown) => e)) as AcsError;
    expect(err2.message).toMatch(/rejected the API key/);
    expect(JSON.stringify(b.ledger.entries())).not.toContain(KEY);
  });

  it("sends the key when set and redacts it", async () => {
    const { f, ledger, acs } = setup(() => json(table), { apiKey: KEY });
    await acs.byZctas(["00001"]);
    expect(new URL(f.calls[0]!.url).searchParams.get("key")).toBe(KEY);
    const e = ledger.entries()[0]!;
    expect(e.params.key).toBe("$CENSUS_API_KEY");
    expect(e.curl).toContain("&key=$CENSUS_API_KEY");
    expect(JSON.stringify(ledger.entries())).not.toContain(KEY);
  });

  it("rejects malformed ZCTAs and sends nothing for an empty list", async () => {
    const { f, acs } = setup(() => json(table));
    await expect(acs.byZctas(["3720"])).rejects.toThrow(RangeError);
    const res = await acs.byZctas([]);
    expect(res.rows).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });
});

describe("tractsInCounty", () => {
  it("asks for every tract in a county and builds 11-digit GEOIDs", async () => {
    const tractHeader = [...header.slice(0, -1), "state", "county", "tract"];
    const body = [tractHeader, [...table[1]!.slice(0, -1), "47", "037", "019200"], [...table[2]!.slice(0, -1), "47", "037", "019300"]];
    const { f, acs } = setup(() => json(body));
    const res = await acs.tractsInCounty("47", "037");
    const url = f.calls[0]!.url;
    expect(url).toContain("&for=tract:*&in=state:47%20county:037");
    expect(res.rows.map((r) => [r.geoType, r.geoId, r.adults21Plus])).toEqual([
      ["tract", "47037019200", 7340],
      ["tract", "47037019300", 4160],
    ]);
    await expect(acs.tractsInCounty("7", "37")).rejects.toThrow(RangeError);
  });
});

describe("summarizeAreas", () => {
  it("sums populations and approximates median age by population weight", async () => {
    const { acs } = setup(() => json(table));
    const { rows } = await acs.byZctas(["00001", "00002", "00003"]);
    expect(summarizeAreas(rows)).toEqual({
      areas: 3,
      totalPopulation: 15000,
      adults21Plus: 11500,
      adultsMissing: 0,
      approxMedianAge: 34.5,
    });
    expect(summarizeAreas([])).toEqual({ areas: 0, totalPopulation: null, adults21Plus: null, adultsMissing: 0, approxMedianAge: null });
  });
});
