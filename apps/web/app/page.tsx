import Link from "next/link";
import { headers } from "next/headers";
import type { LiftTile, StreetSheet } from "@walkup/contracts";
import { HeroSplit, type HeroSide } from "@/components/HeroSplit";
import { WithWithout } from "@/components/WithWithout";
import { ShowSearch } from "@/components/ShowSearch";
import { actsLine, formatShowDate, headlinerName, joinAnd, possessive } from "@/lib/format";
import { FANBAR_HREF, FANBAR_NO_CLAIM, FANBAR_RESULT, genreLabel } from "@/lib/labels";
import { runtimeMode } from "@/lib/mode";
import { ALL_PRESET_IDS } from "@/lib/plans";
import { clientIp } from "@/lib/server/http";
import { freshRuns } from "@/lib/server/limits";
import { freshRunsBody, loadPlan, presetPausedInRecording, presetSheet } from "@/lib/server/service";
import { decodeBbox, unionBbox } from "@/lib/geohash";
import { revisionsOf, type PlanRevisionLink } from "@/lib/server/recorded";
import {
  allTiles,
  baselineName,
  compareBills,
  comparisonSentence,
  areaName,
  distinctAcross,
  landingRooms,
  missedPick,
  missedPickLine,
  popularityLine,
  recordedSheetsSection,
  topTiles,
  withWithout,
  type WithWithoutArea,
} from "@/lib/sheet-utils";

export const dynamic = "force-dynamic";

/**
 * Room pairs in the order the landing shows them. The first pair whose two sheets are served is the worked example;
 * the next one served as two live recordings is the second room. The Salt Shed goes first (neither bill's signal is
 * thin); The Anthem second. A sample server has no Salt Shed sheets, so its worked example is the sample pair.
 */
const PAIRS: readonly (readonly [string, string])[] = [
  ["g4-a", "g4-b"],
  ["g1-a", "g1-b"],
];
/** The sheet the primary button opens when its live recording is served: The Roots at The Salt Shed. */
const FEATURED_PLAN_ID = "g4-b";
/**
 * A real screenshot of that sheet (apps/web/public, captured from its recording), shown only when that recording is
 * served. The key-facts row is cut out: its "Days to show" counts from the day the page is viewed, so a frozen copy
 * would soon disagree with the sheet it links to.
 */
const FEATURED_IMAGE = {
  src: "/roots-sheet.png",
  width: 1424,
  height: 1172,
  alt: "Screenshot of The Roots' street sheet: the header with the requests behind it, then the first two rows of the partner table, each with its area, type, the day the street team visits it and its hours that day, address, phone and why it was picked.",
  caption: "The top of The Roots' sheet and its first two partners, recorded from a live run. Every footnote opens the request behind the claim.",
};
/**
 * One area per sheet for "With Qloo and without", live recordings only: The Roots' (South Shore) and Rhiannon
 * Giddens' (H Street NE). Each sheet's own area is chosen by `withWithout`; FLO's Laurel table stays on FLO's sheet.
 */
const WITH_WITHOUT_IDS = ["g4-b", "g1-a"];

async function sheetFor(id: string): Promise<StreetSheet | null> {
  const v = await loadPlan(id, { view: "api" });
  return v?.kind === "sheet" ? v.sheet : null;
}

function side(s: StreetSheet, fallbackLabel: string, revisions: readonly PlanRevisionLink[]): HeroSide {
  const headliner = headlinerName(s.bill);
  // A real pick only: a sample sheet's places are made up, so it names none.
  const missed = s.mode === "live" ? missedPick(s) : null;
  return {
    planId: s.planId,
    headliner,
    support: s.bill.acts.map((x) => x.name).filter((n) => n !== headliner),
    label: genreLabel(s.bill.classification, fallbackLabel),
    place: s.bill.venue.name,
    date: formatShowDate(s.bill.date),
    tiles: allTiles(s),
    top: topTiles(s),
    venue: { lat: s.bill.venue.lat, lon: s.bill.venue.lon, name: s.bill.venue.name },
    partners: s.cards.partners.results.length,
    sample: s.mode === "fixture",
    missed: missed ? { line: `A pick a popularity list would miss: ${missedPickLine(missed)}`, refs: missed.refs } : null,
    revisions: revisions.map((r) => ({ planId: r.planId, instruction: r.instruction })),
  };
}

/** The receipts behind one area's two lists, as footnote links into the sheet's receipts. */
function AreaRefs({ data, planId }: { data: WithWithoutArea; planId: string }) {
  const ids = [data.popularRef, ...data.pickRefs];
  return (
    <sup className="fn">
      {ids.map((r, i) => (
        <span key={r}>
          {i > 0 ? ", " : ""}
          <Link href={`/plan/${planId}#receipt-${r}`} aria-label={`Receipt ${r}`}>
            {r}
          </Link>
        </span>
      ))}
    </sup>
  );
}

/** The second room, compact: each bill's top areas in words, its partners and the popularity count, with links. */
function SecondExample({ a, b, revisions }: { a: StreetSheet; b: StreetSheet; revisions: Record<string, readonly PlanRevisionLink[]> }) {
  const cmp = compareBills(a, b);
  const names = { a: headlinerName(a.bill), b: headlinerName(b.bill), venue: a.bill.venue.name };
  // The names said for both bills: one on both lists gets its distance and direction (different squares).
  const [topA, topB] = distinctAcross(
    { tiles: topTiles(a).slice(0, 3), venue: a.bill.venue },
    { tiles: topTiles(b).slice(0, 3), venue: b.bill.venue },
  );
  const bill = (s: StreetSheet, letter: "A" | "B", top: LiftTile[]) => {
    const headliner = headlinerName(s.bill);
    const support = s.bill.acts.map((x) => x.name).filter((n) => n !== headliner);
    const pc = s.popularityCheck;
    const near = pc?.perArea.length === 1 && pc.perArea[0]?.tileGeohash === null;
    const n = s.cards.partners.results.length;
    return (
      <div key={s.planId} className="min-w-0" data-testid={`second-${letter}`}>
        <h3 className="text-base">{headliner}</h3>
        {support.length > 0 ? <p className="text-sm text-muted">with {joinAnd(support)}</p> : null}
        <p className="text-sm text-muted">{[formatShowDate(s.bill.date), genreLabel(s.bill.classification, `Bill ${letter}`)].join(" · ")}</p>
        <p className="mt-2">
          Stands out most in {joinAnd(top.map((t) => t.name ?? areaName(t)))}.
          {near ? " The two halves of the bill disagree on where its crowd is, so the partners are places near the room, marked as a starting list." : ""}
        </p>
        {pc && n > 0 ? <p className="mt-1">{popularityLine(pc)}</p> : null}
        <p className="mt-2">
          <Link href={`/plan/${s.planId}`} className="link">
            Open {possessive(headliner)} sheet
          </Link>
          <span className="text-muted">
            {" "}
            · {n} suggested {n === 1 ? "partner" : "partners"}
          </span>
        </p>
        {(revisions[s.planId] ?? []).map((r) => (
          <p key={r.planId} className="mt-1 text-sm">
            <span className="text-muted">Revised: </span>
            <Link href={`/plan/${r.planId}`} className="link">
              {r.instruction} &rarr;
            </Link>
          </p>
        ))}
      </div>
    );
  };
  return (
    <section className="section" aria-labelledby="second-title" data-testid="second-example">
      <h2 id="second-title">
        A second room: {a.bill.venue.name}, {a.bill.venue.city}
      </h2>
      <p className="mt-2 max-w-[760px]">
        <span className="text-muted">Two real bills picked by the same rule at an independent room in another city. </span>
        <span data-testid="second-comparison">{comparisonSentence(cmp, names)}</span>
      </p>
      <div className="mt-5 grid max-w-[1000px] gap-x-10 gap-y-8 md:grid-cols-2">
        {bill(a, "A", topA)}
        {bill(b, "B", topB)}
      </div>
    </section>
  );
}

function place(s: StreetSheet): string {
  return [s.bill.venue.name, s.bill.venue.city].filter(Boolean).join(", ");
}

/** "today", "yesterday", "3 days ago", or the date; null for a time in the future (preset clocks run ahead). */
function agoWords(iso: string, now = Date.now()): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t > now) return null;
  const days = Math.floor((now - t) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return formatShowDate(iso.slice(0, 10));
}

interface SheetLink {
  planId: string;
  sheet: StreetSheet;
  /** On the fixture world this preset's page starts by asking which act you mean. */
  asksFirst: boolean;
}

async function sheetLinks(fixture: boolean): Promise<SheetLink[]> {
  const out = await Promise.all(
    // The room pairs in the order the page shows them, then the other presets.
    [...new Set([...PAIRS.flat(), ...ALL_PRESET_IDS])].map(async (planId): Promise<SheetLink | null> => {
      const sheet = await sheetFor(planId);
      if (!sheet) return null;
      const fx = fixture ? await presetSheet(planId) : null;
      return { planId, sheet, asksFirst: Boolean(fx && presetPausedInRecording(fx)) };
    }),
  );
  return out.filter((x): x is SheetLink => x !== null);
}

/** "The Truth, Nashville · Fri Nov 20 2026 · sample · 24 partners" (a stored live run says when it was recorded instead of "sample"). */
function sheetMeta(l: SheetLink): string {
  const s = l.sheet;
  const n = s.cards.partners.results.length;
  const recorded = s.mode === "live" ? agoWords(s.createdAt) : null;
  return [
    place(s),
    formatShowDate(s.bill.date),
    s.mode === "fixture" ? "sample" : recorded ? `recorded ${recorded}` : null,
    `${n} ${n === 1 ? "partner" : "partners"}`,
    l.asksFirst ? "starts by asking you to pick an act" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function SheetList({ links }: { links: SheetLink[] }) {
  return (
    <ul className="mt-3 max-w-[760px] space-y-2.5">
      {links.map((l) => (
        <li key={l.planId}>
          <Link href={`/plan/${l.planId}`} className="link">
            {actsLine(l.sheet.bill)}
          </Link>
          <span className="block text-sm text-muted">{sheetMeta(l)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Both sheets of a room pair, or null when either is not served. */
async function pairFor([x, y]: readonly [string, string]): Promise<{ a: StreetSheet; b: StreetSheet } | null> {
  const a = await sheetFor(x);
  if (!a) return null;
  const b = await sheetFor(a.pairedPlanId ?? y);
  return b ? { a, b } : null;
}

/** "The Roots at The Salt Shed, Chicago" */
function billAt(s: StreetSheet): string {
  return `${headlinerName(s.bill)} at ${place(s)}`;
}

export default async function Home() {
  const mode = runtimeMode();
  const fixture = mode.kind === "fixture";
  const [pairs, links, featuredLive] = await Promise.all([
    Promise.all(PAIRS.map(pairFor)),
    sheetLinks(fixture),
    sheetFor(FEATURED_PLAN_ID).then((s) => (s?.mode === "live" ? s : null)),
  ]);
  const rooms = landingRooms(pairs);
  const a = rooms.hero?.a ?? null;
  const b = rooms.hero?.b ?? null;
  const fresh = mode.kind === "live" ? freshRunsBody(freshRuns().status(clientIp(await headers()))) : null;
  // A live (or recorded) sheet beside a sample one would set real numbers against made-up ones: no worked example then.
  const cmp = a && b && a.mode === b.mode ? compareBills(a, b) : null;
  // Stored revisions of each hero sheet ("All ages, no bars"), found by parent id in the plan store.
  const [revA, revB] = await Promise.all([
    a ? revisionsOf(a.planId, a.mode === "live" ? "live" : undefined) : Promise.resolve([]),
    b ? revisionsOf(b.planId, b.mode === "live" ? "live" : undefined) : Promise.resolve([]),
  ]);
  // An area name on both lists gets its distance and direction, so two different squares never read as one.
  const [heroA, heroB] = ((): [HeroSide | null, HeroSide | null] => {
    const x = a ? side(a, "Bill A", revA) : null;
    const y = b ? side(b, "Bill B", revB) : null;
    if (!x || !y) return [x, y];
    const [topX, topY] = distinctAcross({ tiles: x.top, venue: x.venue }, { tiles: y.top, venue: y.venue });
    return [
      { ...x, top: topX },
      { ...y, top: topY },
    ];
  })();
  // The second room: the next pair served as two live recordings (it has no sample sheets).
  const second = await (async () => {
    const p = rooms.second;
    if (!p) return null;
    const [r1, r2] = await Promise.all([revisionsOf(p.a.planId, "live"), revisionsOf(p.b.planId, "live")]);
    return { a: p.a, b: p.b, revisions: { [p.a.planId]: r1, [p.b.planId]: r2 } };
  })();
  // With Qloo and without: one area per featured live sheet, the popularity-only list beside Walkup's picks.
  const withOut = (await Promise.all(WITH_WITHOUT_IDS.map(sheetFor)))
    .map((s) => (s && s.mode === "live" ? { sheet: s, data: withWithout(s) } : null))
    .filter((x): x is { sheet: StreetSheet; data: WithWithoutArea } => x !== null && x.data !== null);
  // One frame for both maps: every numbered area of both bills, and the venue(s), so the two scales match.
  const extent =
    heroA && heroB ? unionBbox([...heroA.top, ...heroB.top].map((t) => decodeBbox(t.geohash)), [heroA.venue, heroB.venue]) : null;
  const sample = a?.mode === "fixture" || b?.mode === "fixture";
  // The legend names what both maps were compared with.
  const legendCaption = ((): string | undefined => {
    if (!a || !b) return undefined;
    const [ba, bb] = [baselineName(a), baselineName(b)];
    if (ba !== bb) return "Each bill's fans compared with its own baseline";
    if (ba === "the room's usual crowd" && !cmp?.sameRoom) return "Fans compared with each room's usual crowd";
    return `Fans compared with ${ba}`;
  })();
  const recorded = links.some((l) => l.sheet.mode === "live");
  const recordedSection = mode.kind === "recorded" ? recordedSheetsSection(links.map((l) => l.sheet)) : null;
  // The one button opens The Roots' recorded sheet; without it (a sample server), the worked example's first sheet.
  const featured = featuredLive ?? a ?? links[0]?.sheet ?? null;
  const howWeCounted = (
    <details className="plain-details mt-6 max-w-[760px] text-sm">
      <summary>How we counted</summary>
      <p className="mt-1 text-muted">
        Each sheet numbers up to 5 areas where its crowd is at least 1.3 times the room&apos;s usual crowd, highest first, with no two in the same
        ZIP or within 3 km. An area counts as shared when the same square is numbered on both sheets. A partner counts as shared when the same place
        name is on both lists. A popularity list is Qloo&apos;s same place search with no bill as the signal, cut to as many places as the area has
        partners. Each with-and-without table shows the sheet&apos;s area where the most picks are missing from that list.
      </p>
    </details>
  );

  return (
    <div className="wrap-wide">
      <section className="pt-6 pb-8" aria-labelledby="intro-title" data-testid="pitch">
        <div className={`grid items-start gap-x-10 gap-y-6 ${featuredLive ? "lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" : ""}`}>
          <div className="min-w-0 max-w-[760px]">
            <h1 id="intro-title">Walkup</h1>
            <p className="mt-3">For promoters and venue marketers with a booked show and seats left to sell.</p>
            <p className="mt-2">
              It gives your street team one page: the areas where this show&apos;s fans stand out, the local places they already like there, and the
              PDF, call list and calendar file to work from.
            </p>
            <p className="mt-2">Each area is compared with the room&apos;s usual crowd, not with everyone, and the map and every partner link to the requests behind them.</p>
            {featured ? (
              <>
                <p className="mt-5">
                  <Link href={`/plan/${featured.planId}`} className="btn btn-primary" data-testid="open-sheet">
                    Open a street sheet
                  </Link>
                </p>
                <p className="mt-2 text-sm text-muted">
                  {billAt(featured)}, {formatShowDate(featured.bill.date)}.
                  {featured.mode === "fixture" ? " A sample sheet with made-up places and numbers." : mode.kind === "recorded" ? " Recorded from a live run." : ""}
                </p>
              </>
            ) : null}
          </div>
          {featuredLive ? (
            <figure className="m-0 min-w-0">
              <Link href={`/plan/${featuredLive.planId}`} className="block">
                {/* A fixed screenshot of this very sheet, served as is (no resizing service needed on any host). */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={FEATURED_IMAGE.src}
                  width={FEATURED_IMAGE.width}
                  height={FEATURED_IMAGE.height}
                  alt={FEATURED_IMAGE.alt}
                  className="block h-auto w-full border border-rule"
                  decoding="async"
                />
              </Link>
              <figcaption className="mt-2 text-sm text-muted">{FEATURED_IMAGE.caption}</figcaption>
            </figure>
          ) : null}
        </div>
      </section>

      {a && b && cmp && heroA && heroB ? (
        <section className="section" aria-labelledby="split-title" data-testid="hero">
          <h2 id="split-title">{cmp.sameRoom ? "Same room, two crowds" : "Two bills, two crowds"}</h2>
          <div className="mt-2 max-w-[760px] space-y-2">
            {/* One screen: what lift is (said once, in plain words), the contrast in one sentence, then the maps. */}
            <p className="text-muted" data-testid="lift-explained">
              {cmp.sameRoom ? `Both bills play ${place(a)}. ` : `${heroA.headliner} plays ${place(a)} and ${heroB.headliner} plays ${place(b)}. `}
              Each map shows lift: where this show&apos;s fans stand out from the room&apos;s regulars, the crowd for the other shows{" "}
              {cmp.sameRoom ? "this room books" : "each room books"}. It compares how the two crowds rank each area; it isn&apos;t a head count.
            </p>
            <p data-testid="hero-comparison">{comparisonSentence(cmp, { a: heroA.headliner, b: heroB.headliner, venue: a.bill.venue.name })}</p>
            {sample ? <p className="text-sm text-muted">Sample bills: the acts, businesses and numbers are made up; the venue and the area names are real.</p> : null}
          </div>
          <div className="mt-5">
            <HeroSplit
              a={heroA}
              b={heroB}
              extent={extent}
              legendCaption={legendCaption}
              source={sample ? "Data: made-up sample data in Qloo's format." : mode.kind === "recorded" ? "Data: Qloo, recorded on live runs." : "Data: Qloo."}
            />
          </div>
          {withOut.length === 0 ? howWeCounted : null}
        </section>
      ) : null}

      {withOut.length > 0 ? (
        <section className="section" aria-labelledby="with-without-title" data-testid="hero-with-without">
          <h2 id="with-without-title">With Qloo and without</h2>
          <p className="mt-2 max-w-[760px]">
            One area from each of two sheets, searched twice in Qloo. With no signal, Qloo lists the area&apos;s places by popularity. With the
            show&apos;s acts as the signal, it ranks them for these fans, and Walkup marks down what the room&apos;s usual crowd likes just as much.
          </p>
          <div className="mt-5 grid gap-x-10 gap-y-10 md:grid-cols-2">
            {withOut.map(({ sheet, data }) => (
              <WithWithout key={sheet.planId} data={data} as="h3" lead={billAt(sheet)} explain={false} refs={<AreaRefs data={data} planId={sheet.planId} />} />
            ))}
          </div>
          <p className="mt-6 max-w-[760px]" data-testid="fanbar-home">
            Two lists that differ don&apos;t show which one sells tickets. {FANBAR_RESULT} {FANBAR_NO_CLAIM}{" "}
            <Link href={FANBAR_HREF} className="link">
              The test
            </Link>
          </p>
          {howWeCounted}
        </section>
      ) : null}

      {second ? <SecondExample a={second.a} b={second.b} revisions={second.revisions} /> : null}

      {fixture ? (
        // Without keys there is nothing to search, so the sample sheets take the search's place: no greyed-out box.
        <section id="sheets" className="section scroll-mt-4" aria-labelledby="sheets-title">
          <h2 id="sheets-title">Sample sheets</h2>
          <p className="mt-2 max-w-[760px]">
            Live search needs Qloo and Ticketmaster keys, and this copy of Walkup runs without them. Open a sample sheet:
          </p>
          <SheetList links={links} />
        </section>
      ) : recordedSection ? (
        // Nothing new runs, so the recorded sheets take the search's place, as the sample sheets do without keys.
        <section id="sheets" className="section scroll-mt-4" aria-labelledby="sheets-title">
          <h2 id="sheets-title">{recordedSection.heading}</h2>
          <p className="mt-2 max-w-[760px]">{recordedSection.intro}</p>
          <SheetList links={links} />
        </section>
      ) : (
        <>
          <section className="section" aria-labelledby="search-title">
            <h2 id="search-title">Plan a show</h2>
            <div className="mt-3 max-w-[760px]">
              <ShowSearch enabled={mode.liveSearch} fresh={fresh} />
            </div>
          </section>
          <section id="sheets" className="section scroll-mt-4" aria-labelledby="sheets-title">
            <h2 id="sheets-title">Example sheets</h2>
            {recorded ? <p className="mt-2 max-w-[760px] text-sm text-muted">Recorded from live runs. Opening one makes no new calls.</p> : null}
            <SheetList links={links} />
          </section>
        </>
      )}

      <section className="section" aria-labelledby="how-title">
        <h2 id="how-title">How it works</h2>
        <div className="mt-2 max-w-[760px] space-y-3">
          <p>
            Walkup looks up the acts and the venue in Qloo, and builds the room&apos;s usual crowd from the other shows the room has coming up on
            Ticketmaster. It keeps the areas this bill&apos;s crowd ranks much higher than the usual crowd does. In those areas it picks the places this
            crowd already likes that are open on your street-team day. Each pick links to the request behind it, and nothing goes to your street team
            until you confirm.
          </p>
          <p className="link-row text-base">
            <Link href="/system-card" className="link">
              System card: what Walkup does and where it stops
            </Link>
            <Link href="/eval" className="link">
              Eval: how it is checked
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
