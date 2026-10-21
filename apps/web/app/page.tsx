import Link from "next/link";
import { headers } from "next/headers";
import type { StreetSheet } from "@walkup/contracts";
import { HeroSplit, type HeroSide } from "@/components/HeroSplit";
import { ShowSearch } from "@/components/ShowSearch";
import { actsLine, formatShowDate, headlinerName } from "@/lib/format";
import { genreLabel } from "@/lib/labels";
import { runtimeMode } from "@/lib/mode";
import { PRESET_PLAN_IDS } from "@/lib/plans";
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
  missedPick,
  missedPickLine,
  ordinal,
  popularityAreas,
  recordedSheetsSection,
  topTiles,
  type PopularityArea,
} from "@/lib/sheet-utils";

export const dynamic = "force-dynamic";

/** The worked example opens on this preset and the bill it is paired with. */
const HERO_PLAN_ID = "g1-a";
const HERO_PAIR_FALLBACK = "g1-b";

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

/**
 * One area side by side: Walkup's picks there with their rank for this crowd and for the room's usual crowd, against
 * Qloo's popularity-only search of the same area (no bill as the signal). Shown for an area where none of the picks
 * is in the popularity list's top, so every row can say "No".
 */
function PopularityUpClose({ area, planId }: { area: PopularityArea; planId: string }) {
  const intro = (
    <p className="mt-1 text-sm text-muted">
      Qloo ran the same place search for this area twice: once with this bill as the signal, once with no signal, which returns places in
      popularity order. The popularity-only top {area.k} has none of Walkup&apos;s {area.picks.length} picks here.{" "}
      <Link href={`/plan/${planId}#receipt-${area.popularRef}`} className="link">
        Popularity-only search ({area.popularRef})
      </Link>
    </p>
  );
  // With the names stored on the sheet (`popularTop`): the two lists side by side, row by row.
  if (area.popular) {
    const popular = area.popular;
    const n = Math.max(popular.length, area.picks.length);
    return (
      <div className="mt-8 max-w-[760px]" data-testid="popularity-up-close">
        <h3 className="text-base">Popularity alone against Walkup&apos;s picks, in {area.area}</h3>
        {intro}
        <table className="table mt-2">
          <caption className="sr-only">
            The {area.k} most popular places in {area.area} by popularity alone, beside Walkup&apos;s picks there with their rank for this crowd
          </caption>
          <thead>
            <tr>
              <th scope="col" className="num w-8">
                #
              </th>
              <th scope="col">Popularity alone</th>
              <th scope="col">Walkup&apos;s pick</th>
              <th scope="col" className="num hidden sm:table-cell">
                Rank for the usual crowd
              </th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: n }, (_, i) => {
              const pop = popular[i];
              const pick = area.picks[i];
              return (
                <tr key={i}>
                  <td className="num text-muted">{i + 1}</td>
                  <td>{pop ? pop.name : ""}</td>
                  <td>
                    {pick ? (
                      <>
                        <span className="font-semibold">{pick.name}</span>
                        <span className="block text-sm text-muted">{ordinal(pick.billRank)} for this crowd</span>
                      </>
                    ) : null}
                  </td>
                  <td className="num hidden sm:table-cell">{pick ? (pick.houseRank === null ? "not ranked" : ordinal(pick.houseRank)) : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="mt-8 max-w-[760px]" data-testid="popularity-up-close">
      <h3 className="text-base">Popularity alone against Walkup&apos;s picks, in {area.area}</h3>
      {intro}
      <table className="table mt-2">
        <caption className="sr-only">Walkup&apos;s picks in {area.area} with their ranks, and whether the popularity-only list has them</caption>
        <thead>
          <tr>
            <th scope="col">Walkup&apos;s pick</th>
            <th scope="col" className="num">
              Rank for this crowd
            </th>
            <th scope="col" className="num">
              Rank for the usual crowd
            </th>
            <th scope="col" className="num">
              In the popularity top {area.k}
            </th>
          </tr>
        </thead>
        <tbody>
          {area.picks.map((p) => (
            <tr key={p.entityId}>
              <td>{p.name}</td>
              <td className="num">{ordinal(p.billRank)}</td>
              <td className="num">{p.houseRank === null ? "not ranked" : ordinal(p.houseRank)}</td>
              <td className="num">No</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
    PRESET_PLAN_IDS.map(async (planId): Promise<SheetLink | null> => {
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
  // The up-close area: the first hero area where none of Walkup's picks is in the popularity-only top (live sheets only).
  const upClose = ((): { area: PopularityArea; planId: string } | null => {
    for (const s of [a, b]) {
      if (!s || s.mode !== "live") continue;
      const area = popularityAreas(s).find((x) => x.notInPopularTop >= x.k && x.picks.length === x.k);
      if (area) return { area, planId: s.planId };
    }
    return null;
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
          {upClose ? <PopularityUpClose area={upClose.area} planId={upClose.planId} /> : null}
          <details className="plain-details mt-6 max-w-[760px] text-sm">
            <summary>How we counted</summary>
            <p className="mt-1 text-muted">
              Each sheet numbers up to 5 areas where its crowd is at least 1.3 times the room&apos;s usual crowd, highest first, with no two in the
              same ZIP or within 3 km. An area counts as shared when the same square is numbered on both sheets. A partner counts as shared when the
              same place name is on both lists. A popularity list is Qloo&apos;s same place search with no bill as the signal, cut to as many places
              as the area has partners.
            </p>
          </details>
        </section>
      ) : null}

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
