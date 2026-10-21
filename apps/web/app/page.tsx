import Link from "next/link";
import { headers } from "next/headers";
import type { StreetSheet } from "@walkup/contracts";
import { HeroSplit, type HeroSide } from "@/components/HeroSplit";
import { WithWithout } from "@/components/WithWithout";
import { ShowSearch } from "@/components/ShowSearch";
import { actsLine, formatShowDate, headlinerName, joinAnd } from "@/lib/format";
import { genreLabel } from "@/lib/labels";
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
  missedPick,
  missedPickLine,
  popularityLine,
  recordedSheetsSection,
  topTiles,
  withWithout,
  type WithWithoutArea,
} from "@/lib/sheet-utils";

export const dynamic = "force-dynamic";

/** The worked example opens on this preset and the bill it is paired with. */
const HERO_PLAN_ID = "g1-a";
const HERO_PAIR_FALLBACK = "g1-b";
/** The second example: another room, the same rule. */
const SECOND_PLAN_ID = "g4-a";
const SECOND_PAIR_FALLBACK = "g4-b";

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
  const bill = (s: StreetSheet, letter: "A" | "B") => {
    const headliner = headlinerName(s.bill);
    const support = s.bill.acts.map((x) => x.name).filter((n) => n !== headliner);
    const top = topTiles(s);
    const pc = s.popularityCheck;
    const near = pc?.perArea.length === 1 && pc.perArea[0]?.tileGeohash === null;
    const n = s.cards.partners.results.length;
    return (
      <div key={s.planId} className="min-w-0" data-testid={`second-${letter}`}>
        <h3 className="text-base">{headliner}</h3>
        {support.length > 0 ? <p className="text-sm text-muted">with {joinAnd(support)}</p> : null}
        <p className="text-sm text-muted">{[formatShowDate(s.bill.date), genreLabel(s.bill.classification, `Bill ${letter}`)].join(" · ")}</p>
        <p className="mt-2">
          Stands out most in {joinAnd(top.slice(0, 3).map((t) => t.name ?? areaName(t)))}.
          {near ? " The two halves of the bill disagree on where its crowd is, so the partners are places near the room, marked as a starting list." : ""}
        </p>
        {pc && n > 0 ? <p className="mt-1">{popularityLine(pc)}</p> : null}
        <p className="mt-2">
          <Link href={`/plan/${s.planId}`} className="link">
            Open {headliner}&apos;s sheet
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
        {bill(a, "A")}
        {bill(b, "B")}
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
    ALL_PRESET_IDS.map(async (planId): Promise<SheetLink | null> => {
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

export default async function Home() {
  const mode = runtimeMode();
  const fixture = mode.kind === "fixture";
  const a = await sheetFor(HERO_PLAN_ID);
  const [b, links] = await Promise.all([sheetFor(a?.pairedPlanId ?? HERO_PAIR_FALLBACK), sheetLinks(fixture)]);
  const fresh = mode.kind === "live" ? freshRunsBody(freshRuns().status(clientIp(await headers()))) : null;
  // A live (or recorded) sheet beside a sample one would set real numbers against made-up ones: no worked example then.
  const cmp = a && b && a.mode === b.mode ? compareBills(a, b) : null;
  // One frame for both maps: every numbered area of both bills, and the venue(s), so the two scales match.
  // Stored revisions of each hero sheet ("All ages, no bars"), found by parent id in the plan store.
  const [revA, revB] = await Promise.all([
    a ? revisionsOf(a.planId, a.mode === "live" ? "live" : undefined) : Promise.resolve([]),
    b ? revisionsOf(b.planId, b.mode === "live" ? "live" : undefined) : Promise.resolve([]),
  ]);
  const heroA = a ? side(a, "Bill A", revA) : null;
  const heroB = b ? side(b, "Bill B", revB) : null;
  // With Qloo and without: one area per live hero sheet, the popularity-only list beside Walkup's picks.
  const withOut = [a, b]
    .map((s) => (s && s.mode === "live" ? { sheet: s, data: withWithout(s) } : null))
    .filter((x): x is { sheet: StreetSheet; data: WithWithoutArea } => x !== null && x.data !== null);
  // The second room (live recordings only; it has no sample sheets).
  const second = await (async () => {
    const s1 = await sheetFor(SECOND_PLAN_ID);
    if (!s1 || s1.mode !== "live") return null;
    const s2 = await sheetFor(s1.pairedPlanId ?? SECOND_PAIR_FALLBACK);
    if (!s2 || s2.mode !== "live") return null;
    const [r1, r2] = await Promise.all([revisionsOf(s1.planId, "live"), revisionsOf(s2.planId, "live")]);
    return { a: s1, b: s2, revisions: { [s1.planId]: r1, [s2.planId]: r2 } };
  })();
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

  return (
    <div className="wrap-wide">
      <section className="pt-6 pb-6" aria-labelledby="intro-title">
        <h1 id="intro-title">Walkup</h1>
        <p className="mt-2 max-w-[760px]">
          For a booked show with seats left, Walkup finds the areas where this bill&apos;s crowd stands out from the room&apos;s usual crowd and the
          local places that crowd already likes, and puts them on one page for your street team.
        </p>
      </section>

      {a && b && cmp && heroA && heroB ? (
        <section className="section" aria-labelledby="split-title">
          <h2 id="split-title">{cmp.sameRoom ? "Same room, two crowds" : "Two bills, two crowds"}</h2>
          <div className="mt-2 max-w-[760px] space-y-2">
            {/* One screen: what the two maps are, the contrast in one sentence, then the maps. The legend names the baseline. */}
            <p>
              <span className="text-muted">
                {cmp.sameRoom
                  ? `Both bills play ${place(a)}; each map compares one bill's crowd with the crowd for the shows this room usually books. `
                  : `${heroA.headliner} plays ${place(a)} and ${heroB.headliner} plays ${place(b)}; each map compares one bill's crowd with its room's usual crowd. `}
              </span>
              <span data-testid="hero-comparison">{comparisonSentence(cmp, { a: heroA.headliner, b: heroB.headliner, venue: a.bill.venue.name })}</span>
            </p>
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
          {withOut.length > 0 ? (
            <div className="mt-10" data-testid="hero-with-without">
              <h3>With Qloo and without</h3>
              <p className="mt-1 max-w-[760px]">
                One area from each sheet, searched twice in Qloo. With no signal, Qloo lists the area&apos;s places by popularity. With the
                show&apos;s acts as the signal, it ranks them for these fans, and Walkup marks down what the room&apos;s usual crowd likes just as
                much.
              </p>
              <div className="mt-4 grid gap-x-10 gap-y-10 md:grid-cols-2">
                {withOut.map(({ sheet, data }) => (
                  <WithWithout
                    key={sheet.planId}
                    data={data}
                    as="h4"
                    lead={headlinerName(sheet.bill)}
                    explain={false}
                    refs={<AreaRefs data={data} planId={sheet.planId} />}
                  />
                ))}
              </div>
            </div>
          ) : null}
          <details className="plain-details mt-6 max-w-[760px] text-sm">
            <summary>How we counted</summary>
            <p className="mt-1 text-muted">
              Each sheet numbers up to 5 areas where its crowd is at least 1.3 times the room&apos;s usual crowd, highest first, with no two in the
              same ZIP or within 3 km. An area counts as shared when the same square is numbered on both sheets. A partner counts as shared when the
              same place name is on both lists. A popularity list is Qloo&apos;s same place search with no bill as the signal, cut to as many places
              as the area has partners. Each with-and-without table shows the sheet&apos;s area where the most picks are missing from that list.
            </p>
          </details>
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
