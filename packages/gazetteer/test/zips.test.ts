/**
 * Area names a promoter recognises and residential ZIPs only, from the built gazetteer (public Census/OSM data in
 * data/gazetteer/out) and the curated tables in data/gazetteer (zip_places.csv, areas.json). The points are
 * picked by hand on public maps; no recorded sheet is used.
 */
import { describe, expect, it } from "vitest";
import {
  annotateTile,
  areaNameForPoint,
  isNeighbourhoodCity,
  isResidentialZip,
  knownAreaNear,
  MAX_AREA_ZIPS,
  MIN_RESIDENTIAL_ADULTS,
  zipForPoint,
  zipPlace,
} from "../src/index";

describe("ZIP places and kinds", () => {
  it("names a ZIP the way people do", () => {
    expect(zipPlace("20707")).toEqual({ zip: "20707", city: "Laurel", kind: "residential" });
    expect(zipPlace("22306")?.city).toBe("Alexandria");
    expect(zipPlace("20785")?.city).toBe("Landover");
    expect(zipPlace("99999")).toBeNull();
  });
  it("is false for federal, single-organisation, military and campus ZIPs and near-empty ones", () => {
    for (const z of ["20045", "20422", "20542", "20317", "20388", "20390", "23665", "23681", "22060", "20742"]) expect(isResidentialZip(z)).toBe(false);
    for (const z of ["20001", "20707", "23669", "37206"]) expect(isResidentialZip(z)).toBe(true);
    expect(isResidentialZip("99999")).toBe(true);
    expect(isResidentialZip("99999", MIN_RESIDENTIAL_ADULTS - 1)).toBe(false);
    expect(isResidentialZip("2000")).toBe(false);
  });
  it("knows which cities are named by neighbourhood", () => {
    expect(isNeighbourhoodCity("dc", "Washington")).toBe(true);
    expect(isNeighbourhoodCity("dc", "Alexandria")).toBe(false);
    expect(isNeighbourhoodCity(null, "Washington")).toBe(false);
  });
  it("finds the nearest well-known district inside its radius", () => {
    expect(knownAreaNear(38.8995, -76.968, "dc")?.name).toBe("H Street NE");
    expect(knownAreaNear(38.9195, -77.0215)?.name).toBe("U Street / Shaw");
    expect(knownAreaNear(39.099, -76.85, "dc")).toBeNull();
    expect(knownAreaNear(38.8995, -76.968, "tacoma")).toBeNull();
  });
});

describe("area names a promoter recognises", () => {
  const cases: [number, number, string][] = [
    [38.8995, -76.968, "H Street NE"],
    [38.9195, -77.0215, "U Street / Shaw"],
    [39.099, -76.85, "Laurel"],
    [38.955, -76.745, "Bowie"],
    [38.97, -77.13, "Bethesda"],
    [39.0, -76.88, "Greenbelt"],
    // Route 1 south of Old Town: the district people name, not the ZIP town (an Alexandria mailing address).
    [38.757, -77.0966, "Hybla Valley"],
    [38.82, -77.09, "Alexandria"],
  ];
  for (const [lat, lon, name] of cases) {
    it(`${lat}, ${lon} reads ${name}`, () => {
      const a = areaNameForPoint(lat, lon, "dc");
      expect(a?.name).toBe(name);
      // The OSM or Census name rides along when it differs, for brackets when two areas share a name.
      if (a?.gazetteerName) expect(a.gazetteerName).not.toBe(name);
    });
  }
  it("inside a city named by neighbourhood, keeps the OSM neighbourhood", () => {
    expect(areaNameForPoint(38.9496, -77.0809, "dc")).toMatchObject({ name: "Tenleytown", source: "neighbourhood" });
  });
  it("in such a city with no neighbourhood nearby, says the city, never the Census legal name", () => {
    expect(areaNameForPoint(36.1, -86.95, "nashville")).toMatchObject({ name: "Nashville", source: "zip", gazetteerName: "Nashville-Davidson" });
  });
  it("the ZIP a point is in is a residential one", () => {
    expect(zipForPoint(38.8995, -76.968, "dc")?.zcta).toBe("20002");
    expect(isResidentialZip(zipForPoint(38.8967, -77.0308, "dc")?.zcta)).toBe(true);
  });
});

describe("annotateTile", () => {
  it("counts residential ZIPs only, at most MAX_AREA_ZIPS, nearest first", () => {
    const t = annotateTile({ lat: 38.9195, lon: -77.0215 });
    expect(t.name).toBe("U Street / Shaw");
    expect(t.zctas!.length).toBeLessThanOrEqual(MAX_AREA_ZIPS);
    for (const z of t.zctas!) expect(isResidentialZip(z)).toBe(true);
    for (const z of ["20045", "20422", "20542", "20317", "20059"]) expect(t.zctas).not.toContain(z);
    expect(t.adultPopulation).toBeGreaterThan(0);
  });
  it("still offers the old naming", () => {
    expect(annotateTile({ lat: 38.8995, lon: -76.968 }, { naming: "gazetteer" }).name).toBe("Langston");
    expect(annotateTile({ lat: 38.8995, lon: -76.968 }).gazetteerName).toBe("Langston");
  });
  it("never lets a base swallow an area: the nearest residential ZIP stands in", () => {
    const t = annotateTile({ lat: 37.0839, lon: -76.3601 });
    expect(t.zctas).not.toContain("23665");
    expect(t.zctas).not.toContain("23681");
  });
});
