import { describe, expect, it } from "vitest";
import {
  classificationLabel,
  inferRole,
  parseSpotifyArtistId,
  toBill,
  toTmDateTime,
  toVenue,
  TmMapError,
  tryToBill,
  weekdayOfLocalDate,
  type TmEvent,
} from "../src/index";
import { loadSynthetic } from "./helpers";

const event = loadSynthetic<TmEvent>("event.synthetic.json");
const clone = (): TmEvent => structuredClone(event);

describe("toBill", () => {
  it("maps acts, venue, date and flags from a synthetic event", () => {
    const bill = toBill(event);
    expect(bill.acts).toEqual([
      { name: "Marlow Pines", role: "headliner", tmAttractionId: "SynAtt01", spotifyId: "SynSpot000000000000001" },
      { name: "The Juniper Line", role: "co", tmAttractionId: "SynAtt02", spotifyId: "SynSpot000000000000002" },
      { name: "Hollis Avery", role: "support", tmAttractionId: "SynAtt03" },
    ]);
    expect(bill.venue).toEqual({
      name: "The Lantern Hall",
      lat: 36.16,
      lon: -86.77,
      city: "Riverton",
      state: "TN",
      country: "US",
      tmVenueId: "SynVen01",
      timeZone: "America/Chicago",
    });
    expect(bill.date).toBe("2026-11-28");
    // The UTC instant is already Sunday; the local calendar date is Saturday.
    expect(bill.weekday).toBe("saturday");
    expect(bill.legalAgeEnforced).toBe(true);
    expect(bill.classification).toBe("Music / Country");
    expect(bill.tmEventId).toBe("SynEvt0001");
    expect(bill.tmUrl).toBe("https://www.ticketmaster.com/event/SynEvt0001");
  });

  it("keeps legalAgeEnforced null when Discovery omits it, false when false", () => {
    const a = clone();
    delete a.ageRestrictions;
    expect(toBill(a).legalAgeEnforced).toBeNull();
    const b = clone();
    b.ageRestrictions = {};
    expect(toBill(b).legalAgeEnforced).toBeNull();
    const c = clone();
    c.ageRestrictions = { legalAgeEnforced: false };
    expect(toBill(c).legalAgeEnforced).toBe(false);
  });

  it("marks comedians from the classification", () => {
    const e = clone();
    e.name = "Jody Marsh with Pete Lowell and Ana Brisk";
    e.classifications = [{ segment: { name: "Arts & Theatre" }, genre: { name: "Comedy" } }];
    e._embedded!.attractions = [
      { id: "C1", name: "Jody Marsh" },
      { id: "C2", name: "Pete Lowell" },
      { id: "C3", name: "Ana Brisk" },
    ];
    const bill = toBill(e);
    expect(bill.acts.map((a) => [a.name, a.role, a.isComedian])).toEqual([
      ["Jody Marsh", "headliner", true],
      ["Pete Lowell", "support", true],
      ["Ana Brisk", "support", true],
    ]);
    expect(bill.classification).toBe("Arts & Theatre / Comedy");
  });

  it("returns issues instead of a bill when venue coordinates or date are missing", () => {
    const e = clone();
    delete e._embedded!.venues![0]!.location;
    delete e.dates!.start!.localDate;
    const r = tryToBill(e);
    expect(r.bill).toBeNull();
    expect(r.issues).toEqual(["venue has no name or coordinates", "event has no local start date (TBA/TBD)"]);
    expect(() => toBill(e)).toThrow(TmMapError);
  });

  it("builds a bill with no acts and reports it", () => {
    const e = clone();
    delete e._embedded!.attractions;
    const r = tryToBill(e);
    expect(r.bill?.acts).toEqual([]);
    expect(r.issues).toEqual(["event has no attractions"]);
  });
});

describe("helpers", () => {
  it("parses Spotify artist ids only", () => {
    expect(parseSpotifyArtistId("https://open.spotify.com/artist/SynSpot000000000000001")).toBe("SynSpot000000000000001");
    expect(parseSpotifyArtistId("https://open.spotify.com/artist/SynSpot000000000000001?si=x")).toBe("SynSpot000000000000001");
    expect(parseSpotifyArtistId("https://open.spotify.com/intl-pt-br/artist/SynSpot000000000000001")).toBe("SynSpot000000000000001");
    expect(parseSpotifyArtistId("spotify:artist:SynSpot000000000000001")).toBe("SynSpot000000000000001");
    expect(parseSpotifyArtistId("https://open.spotify.com/playlist/SynSpot000000000000001")).toBeUndefined();
    expect(parseSpotifyArtistId("https://open.spotify.com/artist/tooShort")).toBeUndefined();
    expect(parseSpotifyArtistId(undefined)).toBeUndefined();
  });

  it("infers co vs support from the event title", () => {
    expect(inferRole("A & B", "B", 1)).toBe("co");
    expect(inferRole("A and B", "B", 1)).toBe("co");
    expect(inferRole("A with B", "B", 1)).toBe("support");
    expect(inferRole("A w/ B", "B", 1)).toBe("support");
    expect(inferRole("A: The Long Road Tour", "B", 1)).toBe("support");
    expect(inferRole("A featuring B & C", "C", 2)).toBe("support");
    expect(inferRole("Anything", "A", 0)).toBe("headliner");
  });

  it("drops Undefined classification parts", () => {
    expect(classificationLabel({ segment: { name: "Music" }, genre: { name: "Undefined" } })).toBe("Music");
    expect(classificationLabel({ segment: { name: "Undefined" } })).toBeUndefined();
    expect(classificationLabel(undefined)).toBeUndefined();
  });

  it("maps venues and rejects missing coordinates", () => {
    expect(toVenue({ name: "X", location: { latitude: "36.1", longitude: "-86.7" } })).toEqual({ name: "X", lat: 36.1, lon: -86.7, city: "" });
    expect(toVenue({ name: "X", location: { latitude: "abc", longitude: "-86.7" } })).toBeNull();
    expect(toVenue({ name: "X" })).toBeNull();
    expect(toVenue(undefined)).toBeNull();
    // Ticketmaster's IANA zone travels as Venue.timeZone; anything malformed is left out.
    expect(toVenue({ name: "X", timezone: "America/Chicago", location: { latitude: "36.1", longitude: "-86.7" } })?.timeZone).toBe("America/Chicago");
    expect(toVenue({ name: "X", timezone: "not a zone", location: { latitude: "36.1", longitude: "-86.7" } })).not.toHaveProperty("timeZone");
  });

  it("computes weekdays from local calendar dates", () => {
    expect(weekdayOfLocalDate("2026-10-13")).toBe("tuesday");
    expect(weekdayOfLocalDate("2026-11-28")).toBe("saturday");
    expect(weekdayOfLocalDate("2026-11-29")).toBe("sunday");
    expect(weekdayOfLocalDate("2027-01-04")).toBe("monday");
    expect(() => weekdayOfLocalDate("2026-02-30")).toThrow(RangeError);
  });

  it("formats Discovery datetimes", () => {
    expect(toTmDateTime(new Date(Date.UTC(2026, 10, 20, 1, 2, 3, 456)))).toBe("2026-11-20T01:02:03Z");
    expect(toTmDateTime("2026-11-20")).toBe("2026-11-20T00:00:00Z");
    expect(toTmDateTime("2026-11-20T00:00:00Z")).toBe("2026-11-20T00:00:00Z");
    expect(toTmDateTime("2026-11-20T00:00:00.000+01:00")).toBe("2026-11-19T23:00:00Z");
    expect(() => toTmDateTime("2026-11-20T00:00:00")).toThrow(RangeError);
    expect(() => toTmDateTime("next friday")).toThrow(RangeError);
  });
});
