/**
 * The key-day room tool (lib/tm-room.ts) against an in-process fake of
 * Discovery v2 that serves SYNTHETIC venues and events written below (no
 * real API, no network): exact venue match and ambiguity, the window
 * over-fetch and paging, the rule's working, the roster's Spotify order, and
 * the probe config rewrite round trip.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { HERO_WINDOW } from "@walkup/orchestrator";
import { createTmClient, type TmClient, type TmEvent, type TmVenue } from "@walkup/tm";
import { loadConfig, validateConfig, type ProbeConfig } from "../lib/probe/config.js";
import {
  addDays,
  findVenue,
  normalizeName,
  readRoster,
  readWindow,
  renderReport,
  reportJson,
  rewriteProbeConfig,
  roomReport,
  venueFromEvents,
  type ProbeUpdate,
  type VenueRow,
} from "../lib/tm-room.js";
import { parseArgs } from "../tm-room.js";

const CONFIG_PATH = fileURLToPath(new URL("../probe.config.json", import.meta.url));
const KEY = "test-key-not-real-0123456789";

const spotify = (n: number): string => `SynSpot${String(n).padStart(15, "0")}`;

function venue(id: string, name: string, city: string, extra: Partial<TmVenue> = {}): TmVenue {
  return {
    id,
    name,
    url: `https://tickets.example/venue/${id}`,
    city: { name: city },
    state: { name: "Tennessee", stateCode: "TN" },
    country: { countryCode: "US" },
    address: { line1: "1 Sample Street" },
    location: { latitude: "36.1001", longitude: "-86.7002" },
    timezone: "America/Chicago",
    ...extra,
  };
}

const ROOM = venue("SYN-VEN-ROOM", "The Test Room", "Testville");
const ANNEX = venue("SYN-VEN-ANNEX", "The Test Room Annex", "Testville");
const ELSEWHERE = venue("SYN-VEN-ELSE", "The Test Room", "Othertown");
const TWIN_1 = venue("SYN-VEN-TWIN1", "Twin Hall", "Testville");
const TWIN_2 = venue("SYN-VEN-TWIN2", "Twin Hall", "Testville", { address: { line1: "2 Sample Street" } });
const HIDDEN = venue("SYN-VEN-HIDDEN", "Hidden Room", "Testville");
const VENUES = [ROOM, ANNEX, ELSEWHERE, TWIN_1, TWIN_2];

/** One synthetic event; `utc` is the start instant Discovery filters on (local Central time + 6 h in winter). */
function event(id: string, at: TmVenue, localDate: string, utc: string, genre: string, act: { name: string; spotify?: string } | null, extra: Partial<TmEvent> = {}): TmEvent {
  return {
    id,
    name: act?.name ?? `Synthetic listing ${id}`,
    url: `https://tickets.example/event/${id}`,
    dates: { start: { localDate, localTime: "20:00:00", dateTime: utc }, status: { code: "onsale" } },
    classifications: [{ segment: { name: "Music" }, genre: { name: genre }, subGenre: { name: "Undefined" } }],
    _embedded: {
      venues: [at],
      ...(act
        ? { attractions: [{ id: `att-${act.name}`, name: act.name, ...(act.spotify ? { externalLinks: { spotify: [{ url: `https://open.spotify.com/artist/${act.spotify}` }] } } : {}) }] }
        : {}),
    },
    ...extra,
  };
}

const ROSTER: TmEvent[] = [
  event("syn-r1", ROOM, "2026-11-02", "2026-11-03T02:00:00Z", "Rock", { name: "Synthetic Duo", spotify: spotify(2) }),
  event("syn-r2", ROOM, "2026-11-03", "2026-11-04T02:00:00Z", "Country", { name: "Synthetic Fiddle Band", spotify: spotify(1) }),
  event("syn-r3", ROOM, "2026-11-10", "2026-11-11T02:00:00Z", "Country", { name: "Synthetic Fiddle Band", spotify: spotify(1) }),
  event("syn-r4", ROOM, "2026-11-12", "2026-11-13T02:00:00Z", "Folk", { name: "Synthetic Quiet Act" }),
  event("syn-r5", ROOM, "2026-11-14", "2026-11-15T02:00:00Z", "Rock", { name: "Synthetic Canceled Act", spotify: spotify(9) }, { dates: { start: { localDate: "2026-11-14", dateTime: "2026-11-15T02:00:00Z" }, status: { code: "canceled" } } }),
  event("syn-r6", ROOM, "2026-11-15", "2026-11-15T18:00:00Z", "Undefined", null, { name: "Synthetic Parking Pass" }),
  event("syn-r7", ROOM, "2026-12-01", "2026-12-02T02:00:00Z", "Pop", { name: "Synthetic Pop Act", spotify: spotify(3) }),
];

const WINDOW: TmEvent[] = [
  // Local Dec 19 at 20:00 is Dec 20 02:00 UTC: Discovery returns it, the rule leaves it out.
  event("syn-w0", ROOM, "2026-12-19", "2026-12-20T02:00:00Z", "Country", { name: "Synthetic Early Act", spotify: spotify(10) }),
  event("syn-w1", ROOM, "2026-12-21", "2026-12-22T02:00:00Z", "Folk", { name: "Synthetic Canceled Folk", spotify: spotify(11) }, { dates: { start: { localDate: "2026-12-21", dateTime: "2026-12-22T02:00:00Z" }, status: { code: "canceled" } } }),
  event("syn-w2", ROOM, "2027-01-09", "2027-01-10T02:00:00Z", "Country", { name: "Synthetic Fiddle Band", spotify: spotify(1) }),
  event("syn-w3", ROOM, "2027-01-15", "2027-01-16T02:00:00Z", "Hip-Hop/Rap", { name: "Synthetic Rap Act" }),
  // Local Feb 28 at 20:00 is Mar 1 02:00 UTC: read only because the request runs past the window's end.
  event("syn-w4", ROOM, "2027-02-28", "2027-03-01T02:00:00Z", "R&B", { name: "Synthetic Late Show", spotify: spotify(12) }),
  event("syn-w5", ROOM, "2027-03-01", "2027-03-01T18:00:00Z", "Hip-Hop/Rap", { name: "Synthetic March Act", spotify: spotify(13) }),
  event("syn-w6", ROOM, "2027-03-02", "2027-03-03T02:00:00Z", "Hip-Hop/Rap", { name: "Synthetic Out Of Range", spotify: spotify(14) }),
];

const OTHER: TmEvent[] = [event("syn-h1", HIDDEN, "2026-11-20", "2026-11-21T02:00:00Z", "Folk", { name: "Hidden Room Sessions" })];

interface FakeOptions {
  /** Pretend the result has this many pages; each page then serves one slice of the list. */
  totalPages?: number;
}

/** A fake Discovery v2: /venues.json by keyword, /events.json by venue, keyword, city and start instant. */
function discovery(o: FakeOptions = {}) {
  const calls: URL[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fetch = async (url: string): Promise<Response> => {
    const u = new URL(url);
    calls.push(u);
    const p = u.searchParams;
    if (u.pathname.endsWith("/venues.json")) {
      const kw = (p.get("keyword") ?? "").toLowerCase();
      const list = VENUES.filter((v) => (v.name ?? "").toLowerCase().includes(kw) && (!p.get("stateCode") || v.state?.stateCode === p.get("stateCode")));
      return json({ ...(list.length > 0 ? { _embedded: { venues: list } } : {}), page: { size: list.length, totalElements: list.length, totalPages: 1, number: 0 } });
    }
    if (u.pathname.endsWith("/events.json")) {
      const start = p.get("startDateTime") ?? "";
      const end = p.get("endDateTime") ?? "9999";
      const kw = (p.get("keyword") ?? "").toLowerCase();
      const list = [...ROSTER, ...WINDOW, ...OTHER]
        .filter((e) => !p.get("venueId") || e._embedded?.venues?.[0]?.id === p.get("venueId"))
        .filter((e) => !kw || `${e.name} ${e._embedded?.venues?.[0]?.name}`.toLowerCase().includes(kw))
        .filter((e) => !p.get("city") || e._embedded?.venues?.[0]?.city?.name === p.get("city"))
        .filter((e) => (e.dates?.start?.dateTime ?? "") >= start && (e.dates?.start?.dateTime ?? "") <= end)
        .sort((a, b) => ((a.dates?.start?.dateTime ?? "") < (b.dates?.start?.dateTime ?? "") ? -1 : 1));
      const size = Number(p.get("size") ?? 20);
      const page = Number(p.get("page") ?? 0);
      const pages = o.totalPages ?? Math.max(1, Math.ceil(list.length / size));
      const per = o.totalPages ? Math.ceil(list.length / o.totalPages) : size;
      const slice = list.slice(page * per, (page + 1) * per);
      return json({ _embedded: { events: slice }, page: { size, totalElements: list.length, totalPages: pages, number: page } });
    }
    return new Response("{}", { status: 404 });
  };
  const tm: TmClient = createTmClient({ apiKey: KEY, fetch, now: () => Date.parse("2026-11-01T12:00:00Z"), sleep: async () => {}, ratePerSecond: 10_000 });
  return { tm, calls };
}

const rowOf = (v: TmVenue): VenueRow => ({
  id: v.id as string,
  name: v.name as string,
  city: v.city?.name as string,
  state: "TN",
  address: v.address?.line1 ?? null,
  url: v.url ?? null,
  point: { lat: 36.1001, lon: -86.7002 },
});

describe("flags", () => {
  const today = "2026-11-01";
  it("defaults to the hero window, today and the-truth", () => {
    expect(parseArgs(["--name", "The Test Room", "--city=Testville", "--state=tn"], today)).toMatchObject({
      name: "The Test Room",
      city: "Testville",
      state: "TN",
      venueId: null,
      asOf: today,
      window: { from: HERO_WINDOW.from, to: HERO_WINDOW.to },
      probeKey: "the-truth",
      writeProbe: false,
      json: false,
    });
    expect(parseArgs(["--venue-id=SYN-VEN-ROOM", "--window=2027-01-01:2027-01-31", "--as-of", "2026-12-01", "--write-probe", "--json"], today)).toMatchObject({
      venueId: "SYN-VEN-ROOM",
      asOf: "2026-12-01",
      window: { from: "2027-01-01", to: "2027-01-31" },
      writeProbe: true,
      json: true,
    });
  });

  it("needs a room, and refuses bad dates, windows and keys", () => {
    expect(() => parseArgs([], today)).toThrow(/--name \(with --city and --state\), or --venue-id/);
    expect(() => parseArgs(["--name=The Test Room", "--state=TN"], today)).toThrow(/--name needs --city and --state/);
    expect(() => parseArgs(["--venue-id=x", "--as-of=2026-02-30"], today)).toThrow(/--as-of/);
    expect(() => parseArgs(["--venue-id=x", "--window=2027-02-01:2027-01-01"], today)).toThrow(/--window/);
    expect(() => parseArgs(["--venue-id=x", "--probe-key=The Truth"], today)).toThrow(/--probe-key/);
    expect(() => parseArgs(["--venue-id=x", "--state=Tennessee"], today)).toThrow(/--state/);
    expect(() => parseArgs(["--venue-id=x", "--bogus"], today)).toThrow(/unknown argument/);
  });
});

describe("venue lookup", () => {
  it("matches the exact name in the exact city, nothing looser", async () => {
    expect(normalizeName("The Test Room.")).toBe(normalizeName("the test room"));
    expect(normalizeName("Rock & Roll Hall")).toBe(normalizeName("Rock and Roll Hall"));
    expect(normalizeName("The Test Room Annex")).not.toBe(normalizeName("The Test Room"));
    const { tm, calls } = discovery();
    const found = await findVenue(tm, { name: "the test room", city: "Testville", state: "TN" });
    expect(found.kind).toBe("found");
    if (found.kind !== "found") return;
    expect(found.venue).toEqual(rowOf(ROOM));
    expect(found.query).toBe('venues.json keyword="the test room" stateCode=TN countryCode=US');
    expect(found.candidates.map((c) => c.id)).toEqual(["SYN-VEN-ROOM", "SYN-VEN-ANNEX", "SYN-VEN-ELSE"]);
    expect(calls.map((c) => c.pathname.split("/").pop())).toEqual(["venues.json"]);
    expect(calls[0]!.searchParams.get("countryCode")).toBe("US");
  });

  it("asks for --venue-id when two rooms share the name, or none has it", async () => {
    const { tm } = discovery();
    const twins = await findVenue(tm, { name: "Twin Hall", city: "Testville", state: "TN" });
    expect(twins.kind).toBe("choose");
    if (twins.kind !== "choose") return;
    expect(twins.reason).toMatch(/2 Ticketmaster venues are named exactly "Twin Hall" in Testville, TN\. Pass --venue-id/);
    expect(twins.candidates.map((c) => c.id)).toEqual(["SYN-VEN-TWIN1", "SYN-VEN-TWIN2"]);
    const none = await findVenue(tm, { name: "The Test", city: "Testville", state: "TN" });
    expect(none.kind).toBe("choose");
    if (none.kind !== "choose") return;
    expect(none.reason).toMatch(/^No Ticketmaster venue is named exactly "The Test" in Testville, TN\. Pass --venue-id with one of the venues listed/);
    expect(none.candidates.map((c) => c.id)).toEqual(["SYN-VEN-ROOM", "SYN-VEN-ANNEX", "SYN-VEN-ELSE"]);
  });

  it("falls back to the venue on matching events", async () => {
    const { tm, calls } = discovery();
    const found = await findVenue(tm, { name: "Hidden Room", city: "Testville", state: "TN" });
    expect(found.kind).toBe("found");
    if (found.kind !== "found") return;
    expect(found.venue.id).toBe("SYN-VEN-HIDDEN");
    expect(found.query).toMatch(/^events\.json keyword="Hidden Room" city="Testville" stateCode=TN countryCode=US/);
    expect(calls.map((c) => c.pathname.split("/").pop())).toEqual(["venues.json", "events.json"]);
    expect(venueFromEvents("SYN-VEN-ROOM", ROSTER)?.name).toBe("The Test Room");
  });
});

describe("roster", () => {
  it("lists the next 60 events and the headliners' Spotify ids in house-set order, deduped", async () => {
    const { tm, calls } = discovery();
    const r = await readRoster(tm, "SYN-VEN-ROOM", "2026-11-01");
    expect(calls[0]!.searchParams.get("startDateTime")).toBe("2026-11-01T00:00:00Z");
    expect(calls[0]!.searchParams.get("size")).toBe("60");
    expect(r.rows[1]).toEqual({ id: "syn-r2", localDate: "2026-11-03", name: "Synthetic Fiddle Band", labels: "Music / Country", genreClass: "roots", status: "onsale", spotifyId: spotify(1) });
    // Recency x frequency: three nights beat one, nearer beats later. The canceled act and the parking
    // pass are not headliners, and the two acts without a Spotify link (quiet act, rap act) have no id.
    expect(r.spotifyIds).toEqual([spotify(1), spotify(2), spotify(3), spotify(10), spotify(12), spotify(13), spotify(14)]);
    expect(r.headliners).toBe(9);
  });
});

describe("window and rule", () => {
  it("reads past the window's last day and keeps local dates inside it", async () => {
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    const { tm, calls } = discovery();
    const w = await readWindow(tm, "SYN-VEN-ROOM", HERO_WINDOW);
    expect(calls[0]!.searchParams.get("startDateTime")).toBe("2026-12-20T00:00:00Z");
    expect(calls[0]!.searchParams.get("endDateTime")).toBe("2027-03-01T23:59:59Z");
    expect(w.events.map((e) => e.id)).toEqual(["syn-w0", "syn-w1", "syn-w2", "syn-w3", "syn-w4", "syn-w5"]);
    expect(w).toMatchObject({ pages: 1, truncated: false });
  });

  it("pages while Discovery has more, and stops at its 1000-result limit", async () => {
    const two = discovery({ totalPages: 2 });
    const w = await readWindow(two.tm, "SYN-VEN-ROOM", HERO_WINDOW);
    expect(two.calls.map((c) => c.searchParams.get("page"))).toEqual(["0", "1"]);
    expect(w.events.map((e) => e.id)).toEqual(["syn-w0", "syn-w1", "syn-w2", "syn-w3", "syn-w4", "syn-w5"]);
    const many = discovery({ totalPages: 9 });
    const capped = await readWindow(many.tm, "SYN-VEN-ROOM", HERO_WINDOW);
    expect(many.calls.map((c) => Number(c.searchParams.get("page")))).toEqual([0, 1, 2, 3, 4]);
    expect(many.calls.every((c) => (Number(c.searchParams.get("page")) + 1) * Number(c.searchParams.get("size")) <= 1000)).toBe(true);
    expect(capped.truncated).toBe(true);
  });

  it("explains the picks and warns about what would stop a plan", async () => {
    const { tm } = discovery();
    const r = await roomReport(tm, { venue: rowOf(ROOM), venueId: "SYN-VEN-ROOM", venueQuery: "test", asOf: "2026-11-01", window: HERO_WINDOW });
    expect(r.explanation.candidates.map((c) => [c.id, c.eligible])).toEqual([
      ["syn-w1", false],
      ["syn-w2", true],
      ["syn-w3", true],
      ["syn-w4", true],
    ]);
    expect(r.explanation.billA.id).toBe("syn-w2");
    expect(r.explanation.billB.id).toBe("syn-w3");
    expect(r.explanation.billB.reason).toMatch(/^Genre most distant from bill A \(hip-hop, distance 1\): Synthetic Rap Act on 2027-01-15/);
    expect(r.picks.map((p) => [p.bill, p.headliner, p.spotifyId])).toEqual([
      ["A", "Synthetic Fiddle Band", spotify(1)],
      ["B", "Synthetic Rap Act", null],
    ]);
    expect(r.warnings).toEqual([expect.stringMatching(/^Bill B: the headliner Synthetic Rap Act has no Spotify link on Ticketmaster/)]);

    const text = renderReport(r).join("\n");
    expect(text).toContain("Bill A  syn-w2  First Americana, country or folk bill from 2026-12-20 to 2027-02-28");
    expect(text).toContain("Synthetic Canceled Folk");
    expect(text).toMatch(/canceled \(skipped\)/);
    const json = JSON.stringify(reportJson(r));
    expect(json).not.toContain("_embedded");
    for (const out of [text, json]) expect(out).not.toContain(KEY);
  });

  it("with --venue-id, reads the venue from the room's own events", async () => {
    const { tm } = discovery();
    const r = await roomReport(tm, { venue: null, venueId: "SYN-VEN-ROOM", venueQuery: "events.json venueId=SYN-VEN-ROOM", asOf: "2026-11-01", window: HERO_WINDOW });
    expect(r.venue).toEqual(rowOf(ROOM));
  });
});

// ---------------------------------------------------------------------------
// probe.config.json rewrite (always into a temporary copy)
// ---------------------------------------------------------------------------

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const TRUTH: VenueRow = {
  id: "SYN-VEN-TRUTH",
  name: "The Truth",
  city: "Nashville",
  state: "TN",
  address: "1 Sample Street",
  url: "https://tickets.example/venue/SYN-VEN-TRUTH",
  point: { lat: 36.15, lon: -86.79 },
};

/** The config text outside the two spans the rewrite owns (venues.the-truth and roster). */
function untouched(s: string): string[] {
  const between = (a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b));
  return [s.slice(0, s.indexOf('"the-truth"')), between('"hampton-coliseum"', '"roster"'), s.slice(s.indexOf('"kg1"'))];
}

function update(over: Partial<ProbeUpdate> = {}): ProbeUpdate {
  return {
    key: "the-truth",
    venue: TRUTH,
    venueQuery: 'venues.json keyword="The Truth" stateCode=TN countryCode=US',
    spotifyIds: [spotify(1), spotify(2)],
    rosterCount: 42,
    asOf: "2026-12-01",
    retrieved: "2026-12-01",
    ...over,
  };
}

describe("probe config rewrite", () => {
  const original = readFileSync(CONFIG_PATH, "utf8");

  it("writes the room's point and roster, keeps the rest byte for byte, and validates", () => {
    const { text, notes } = rewriteProbeConfig(original, update());
    const before = JSON.parse(original) as ProbeConfig;
    const after = JSON.parse(text) as ProbeConfig;
    expect(validateConfig(after)).toEqual([]);
    const truth = after.venues["the-truth"]!;
    expect(truth).toMatchObject({ name: "The Truth", city: "Nashville", state: "TN", lat: 36.15, lon: -86.79 });
    expect(truth.note).not.toMatch(/fill .* on key day/);
    expect(truth.note).toContain("SYN-VEN-TRUTH");
    expect(truth.source).toEqual({
      provider: "Ticketmaster Discovery API v2",
      query: 'venues.json keyword="The Truth" stateCode=TN countryCode=US',
      url: "https://tickets.example/venue/SYN-VEN-TRUTH",
      result: "SYN-VEN-TRUTH",
      retrieved: "2026-12-01",
    });
    expect(truth.searchAnchor).toEqual(before.venues["the-truth"]!.searchAnchor);
    expect(after.roster.venue).toBe("the-truth");
    expect(after.roster.spotifyIds).toEqual([spotify(1), spotify(2)]);
    expect(after.roster.note).toMatch(/SYN-VEN-TRUTH/);
    expect(after.roster.note).toMatch(/2026-12-01/);
    expect(after.roster.note).not.toMatch(/fill on key day/);
    // Everything else is unchanged, hand formatting included.
    for (const k of Object.keys(before) as (keyof ProbeConfig)[]) if (k !== "venues" && k !== "roster") expect(after[k], k).toEqual(before[k]);
    for (const k of Object.keys(before.venues)) if (k !== "the-truth") expect(after.venues[k], k).toEqual(before.venues[k]);
    expect(untouched(text)).toEqual(untouched(original));
    expect(text).toContain('{ "key": "bar", "queries": ["bar"], "parentType": "urn:entity:place" },');
    expect(notes).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), "tm-room-"));
    tmp.push(dir);
    const file = join(dir, "probe.config.json");
    writeFileSync(file, text, "utf8");
    expect(loadConfig(file).venues["the-truth"]!.lat).toBe(36.15);
    // A second run rewrites the same spans in place.
    const again = rewriteProbeConfig(text, update({ spotifyIds: [spotify(3)] }));
    expect((JSON.parse(again.text) as ProbeConfig).roster.spotifyIds).toEqual([spotify(3)]);
    expect(untouched(again.text)).toEqual(untouched(original));
  });

  it("adds a new room under its own key and says KG2 still points elsewhere", () => {
    const other: VenueRow = { ...TRUTH, id: "SYN-VEN-OTHER", name: "The Sample Hall", city: "Nashville" };
    const { text, notes } = rewriteProbeConfig(original, update({ key: "sample-hall", venue: other, spotifyIds: [] }));
    const after = JSON.parse(text) as ProbeConfig;
    expect(validateConfig(after)).toEqual([]);
    expect(after.venues["sample-hall"]).toMatchObject({ name: "The Sample Hall", city: "Nashville", state: "TN", lat: 36.15, lon: -86.79 });
    expect(after.venues["the-truth"]).toEqual((JSON.parse(original) as ProbeConfig).venues["the-truth"]);
    expect(after.roster).toMatchObject({ venue: "sample-hall", spotifyIds: [] });
    expect(after.roster.note).toMatch(/has a Spotify link, so the house set stays a stand-in/);
    expect(notes).toEqual(["Added venues.sample-hall.", 'kg2.venue is still "the-truth": point it at "sample-hall" to run KG2 on this room.']);
  });

  it("refuses a venue with no point or a key that names another room", () => {
    expect(() => rewriteProbeConfig(original, update({ venue: { ...TRUTH, point: null } }))).toThrow(/has no coordinates/);
    expect(() => rewriteProbeConfig(original, update({ venue: { ...TRUTH, name: "The Sample Hall" } }))).toThrow(/Pass --probe-key with a new key/);
    expect(() => rewriteProbeConfig(original, update({ key: "ryman" }))).toThrow(/venues\.ryman is "Ryman Auditorium, Nashville"/);
  });
});
