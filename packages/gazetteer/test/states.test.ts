import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { annotateTile, DEFAULT_GAZETTEER_DIR, loadMetro, parseMetro, stateForPoint, stateFromGeoid, stateFromZctas, stateFromZip } from "../src/index";

describe("state from a ZIP, a GEOID or a ZCTA list", () => {
  it("reads the USPS 3-digit prefix, including the DC, Maryland and Virginia split", () => {
    expect(stateFromZip("20002")).toBe("DC");
    expect(stateFromZip("20019")).toBe("DC");
    expect(stateFromZip("20147")).toBe("VA"); // 201xx is Northern Virginia, not DC
    expect(stateFromZip("20910")).toBe("MD");
    expect(stateFromZip("21114")).toBe("MD");
    expect(stateFromZip("22182")).toBe("VA");
    expect(stateFromZip("22201")).toBe("VA");
    expect(stateFromZip("37206")).toBe("TN");
    expect(stateFromZip("98402")).toBe("WA");
    expect(stateFromZip("23510")).toBe("VA");
    expect(stateFromZip("02134")).toBe("MA");
  });

  it("returns null for anything that is not a 5-digit ZIP with a state prefix", () => {
    for (const z of ["", "1234", "ABCDE", "090xx", "09012", "34012", "96201", null, undefined]) expect(stateFromZip(z), String(z)).toBeNull();
  });

  it("reads the state FIPS at the start of a Census GEOID", () => {
    expect(stateFromGeoid("1150000")).toBe("DC");
    expect(stateFromGeoid("2474375")).toBe("MD");
    expect(stateFromGeoid("5103000")).toBe("VA");
    expect(stateFromGeoid("4752006")).toBe("TN");
    expect(stateFromGeoid("9900001")).toBeNull();
    expect(stateFromGeoid("")).toBeNull();
  });

  it("takes the first ZCTA with a known state (the lists are nearest first)", () => {
    expect(stateFromZctas(["20910", "20012"])).toBe("MD");
    expect(stateFromZctas(["ABCDE", "22306"])).toBe("VA");
    expect(stateFromZctas([])).toBeNull();
    expect(stateFromZctas(undefined)).toBeNull();
  });
});

describe("stateForPoint", () => {
  // Invented coordinates and names; only the ZIPs and GEOIDs carry real state prefixes.
  const metro = parseMetro({
    metro: "borderline",
    bbox: { south: 9, west: -31, north: 11, east: -29 },
    generatedAt: "2026-01-01T00:00:00Z",
    attribution: { osm: "x", census: "y" },
    neighbourhoods: [],
    places: [
      { name: "River City", geoid: "1150000", lat: 10, lon: -30, landKm2: 150 },
      { name: "Hill Town", geoid: "2400001", lat: 10.5, lon: -30.5, landKm2: 20 },
    ],
    zctas: [
      { zcta: "20002", lat: 10, lon: -30, landKm2: 30, totalPop: 1, adults21: 1, medianAge: null, medianIncome: null },
      { zcta: "20910", lat: 10.5, lon: -30.5, landKm2: 30, totalPop: 1, adults21: 1, medianAge: null, medianIncome: null },
      { zcta: "22182", lat: 9.5, lon: -29.5, totalPop: 1, adults21: 1, medianAge: null, medianIncome: null, state: "VA" },
    ],
  });

  it("uses the state of the ZCTA whose land-area circle holds the point", () => {
    expect(stateForPoint(10.01, -30, metro)).toBe("DC");
    expect(stateForPoint(10.49, -30.49, metro)).toBe("MD");
    expect(stateForPoint(9.51, -29.51, metro)).toBe("VA");
  });

  it("prefers a small ZCTA that holds the point over a nearer internal point of a big one", () => {
    const m = parseMetro({
      ...metro,
      metro: "sizes",
      zctas: [
        // A big Maryland ZCTA whose internal point is 1.5 km away and whose circle (r about 2.8 km) holds the point,
        { zcta: "20910", lat: 10.0135, lon: -30, landKm2: 25, totalPop: 1, adults21: 1, medianAge: null, medianIncome: null },
        // and a DC ZCTA whose internal point is nearer (1.2 km) but whose circle (r about 0.6 km) does not.
        { zcta: "20012", lat: 9.989, lon: -30, landKm2: 1, totalPop: 1, adults21: 1, medianAge: null, medianIncome: null },
      ],
    });
    expect(stateForPoint(10, -30, m)).toBe("MD");
  });

  it("falls back to the Census place's state when no ZCTA has one", () => {
    const noZips = parseMetro({ ...metro, metro: "nozips", zctas: [] });
    expect(stateForPoint(10.49, -30.49, noZips)).toBe("MD");
    const nothing = parseMetro({ ...metro, metro: "nothing", zctas: [], places: [{ name: "Nowhere", geoid: "9900001", lat: 10, lon: -30, landKm2: 5 }] });
    expect(stateForPoint(10, -30, nothing)).toBeNull();
  });

  const built = existsSync(join(DEFAULT_GAZETTEER_DIR, "dc.json"));
  it.skipIf(!built)("puts Silver Spring in Maryland, Arlington and Tysons in Virginia, and Capitol Hill in DC (built dc.json)", () => {
    const dc = loadMetro("dc", { dir: DEFAULT_GAZETTEER_DIR });
    expect(stateForPoint(38.9967, -77.0283, dc)).toBe("MD"); // downtown Silver Spring
    expect(stateForPoint(38.9907, -77.0261, dc)).toBe("MD"); // Silver Spring, 0.6 km from the DC line
    expect(stateForPoint(38.8816, -77.091, dc)).toBe("VA"); // Arlington, Clarendon
    expect(stateForPoint(38.9187, -77.2311, dc)).toBe("VA"); // Tysons
    expect(stateForPoint(38.8899, -76.9905, dc)).toBe("DC"); // Capitol Hill
  });

  it.skipIf(!built)("gives a tile the state of its own point: Georgetown is DC though its nearest ZIP (22209, Rosslyn) is VA", () => {
    const dc = loadMetro("dc", { dir: DEFAULT_GAZETTEER_DIR });
    const georgetown = annotateTile({ lat: 38.906119, lon: -77.072526 }, { metro: dc });
    expect(georgetown.zctas?.[0]).toBe("22209");
    expect(stateFromZctas(georgetown.zctas)).toBe("VA");
    expect(georgetown.state).toBe("DC");
    // Takoma Park's point is on the Maryland side, though two of its three ZIPs are DC's.
    expect(annotateTile({ lat: 38.9767, lon: -77.0087 }, { metro: dc }).state).toBe("MD");
  });
});
