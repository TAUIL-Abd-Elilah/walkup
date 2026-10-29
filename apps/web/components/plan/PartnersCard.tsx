"use client";
import { Fragment, useMemo, useState } from "react";
import type { Partner, StreetSheet } from "@walkup/contracts";
import { joinAnd, shortUrl, telHref } from "../../lib/format";
import { FANBAR_HREF, PARTNER_RANK_LINE, categoryLabel } from "../../lib/labels";
import { areaName, humanTimes, isThinSignal, normalizeName, partnerLine, partnerSearchAreas, partnerSummary, popularityLine, tagInSentence, topTiles, withWithout } from "../../lib/sheet-utils";
import { WithWithout } from "../WithWithout";
import { LESS_SURE_NOTE, PHONE_NOT_LISTED, categoryLabel as typeLabel, formatPhone, partnerAreaLabel, partnerLessSure, partnerOtherState } from "@walkup/exports/format";
import { partnerHoursColumn } from "@walkup/exports/sheet-model";
import { CONFIDENCE_LABEL, houseLines, influenceLine, partnerAnchor, partnerWhy, streetDayShort } from "./model";
import { PlanCard } from "./PlanCard";
import { Refs } from "./receipts";

/** Tag names inside a sentence: lower case except acronyms ("R&B") and proper adjectives ("Mexican"). */
const tagWord = tagInSentence;

/**
 * The Type cell: the kind of place, and "national chain" when `partner.chain` is set (any of the four chain signals).
 * The label is the print view's, the PDF's and partners.csv's ("Clothing"), so a place is one kind everywhere.
 */
const typeWords = (p: Partner) => (p.chain ? `${typeLabel(p.category)}, national chain` : typeLabel(p.category));

/** The state of the place's own address when it differs from its area's (the same rule as the print view and files). */
export const otherState = partnerOtherState;

const WEEKDAY_LONG: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

/**
 * Claude's line gives the day the run read hours for (the first street-team day); with a Visit day column a row can
 * be visited on another day ("Sat 8 pm to 5 am" beside "open Thursday 9:30 pm to 4 am"). Says which day each is about,
 * or null when they agree. `visitDay` is the cell's "Sat", or "Sat; Thu" when a holiday's stops move to another day of its week;
 * a day named for the show ("the Saturday show") is skipped.
 */
export function lineDayNote(line: string | undefined, visitDay: string): string | null {
  if (!line || !visitDay) return null;
  const days = visitDay.split(/;\s*/).filter(Boolean);
  for (const m of line.matchAll(/\b(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b/g)) {
    if (/^(?:'s)?\s+(?:show|night|concert|gig)\b/i.test(line.slice((m.index ?? 0) + m[0].length))) continue;
    if (days.includes(m[0].slice(0, 3))) return null;
    return `This line is about ${m[0]}; the street team visits on ${days.map((d) => WEEKDAY_LONG[d] ?? d).join(" and ")}.`;
  }
  return null;
}

/** The note under the partner table that says how far an area's places reach. */
export const AREA_REACH_NOTE =
  "An area's places come from within 2 km of its centre (3.5 km when the search widened), so some sit in the next neighbourhood; the address is the place's own.";

/**
 * The line under a partner Claude wrote no line for, or whose line the checks left out: what it is, near which area,
 * and the tags it shares, all from the row itself. A sentence names the kind as a noun ("Clothing store near ..."),
 * where the Type cell keeps the files' short label.
 */
export function fixedPartnerLine(p: Pick<Partner, "category" | "tileName" | "tileGeohash" | "explain">): string {
  const tags = (p.explain?.tags ?? []).map((t) => tagWord(t.name)).filter(Boolean).slice(0, 3);
  // Only a place from the search around the venue (no area) is "near the venue"; an area with no name stays an area.
  const where = p.tileName ? ` near ${p.tileName}` : p.tileGeohash ? " near an unnamed area" : " near the venue";
  const shares = tags.length > 0 ? `, shares the ${joinWords(tags)} ${tags.length === 1 ? "tag" : "tags"} with this crowd` : "";
  return `${categoryLabel(p.category)}${where}${shares}.`;
}

function joinWords(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

const areaNumbers = (ns: readonly number[]) => `${ns.length === 1 ? "area" : "areas"} ${joinAnd(ns.map(String))}`;

/**
 * Which numbered areas a partner search covered, said after the table's lead: "Walkup searches the top 3 areas for
 * partners; no place in area 3 made the list, and areas 4 and 5 are for flyering only." `searched` are the area numbers
 * the search receipts name (an area whose places were all left out still counts), `kept` the ones with a partner on
 * the list. Empty when every numbered area was searched and kept one, or when none was searched (the partners then
 * come from near the venue, and the section's reason says so).
 */
export function partnerSearchLine(numbered: number, searched: readonly number[], kept: ReadonlySet<number>): string {
  const s = [...new Set(searched)].sort((a, b) => a - b);
  if (s.length === 0) return "";
  const flyer = Array.from({ length: numbered }, (_, i) => i + 1).filter((n) => !s.includes(n));
  const empty = s.filter((n) => !kept.has(n));
  if (flyer.length === 0 && empty.length === 0) return "";
  const which = s.every((n, i) => n === i + 1) ? (s.length === 1 ? "the top area" : `the top ${s.length} areas`) : areaNumbers(s);
  const parts = [
    empty.length > 0 ? `no place in ${areaNumbers(empty)} made the list` : null,
    flyer.length > 0 ? `${areaNumbers(flyer)} ${flyer.length === 1 ? "is" : "are"} for flyering only` : null,
  ].filter((x): x is string => x !== null);
  return `Walkup searches ${which} for partners; ${parts.join(", and ")}.`;
}

/** The "Why this place" detail under a partner row (only when the sheet carries `partner.explain`). */
export function PartnerWhy({ p, area }: { p: Partner; area?: string | undefined }) {
  const x = p.explain;
  if (!x) return null;
  const label = area ?? x.areaName ?? p.tileName;
  const own = label ? otherState(p, label) : null;
  const where = [
    label ? `Near ${label}${own ? ` (the place is in ${own})` : ""}` : null,
    typeof x.distanceKm === "number" && !/\d km \w+$/.test(area ?? x.areaName ?? "") ? `${x.distanceKm.toFixed(1)} km from the venue` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const house = houseLines(p);
  const influence = influenceLine(p);
  return (
    <div className="max-w-[760px] py-1">
      <p>
        <span className="font-semibold">What to ask: </span>
        {x.activation}
      </p>
      <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <dt className="text-muted">Confidence</dt>
        <dd>
          {CONFIDENCE_LABEL[x.confidence]}. {x.confidenceWhy}
        </dd>
        {influence ? (
          <>
            <dt className="text-muted">Whose fans</dt>
            <dd>{influence}</dd>
          </>
        ) : null}
        {x.tags.length > 0 ? (
          <>
            <dt className="text-muted">Tags it shares</dt>
            <dd>{x.tags.map((t) => tagWord(t.name)).join(", ")}</dd>
          </>
        ) : null}
        {where ? (
          <>
            <dt className="text-muted">Where</dt>
            <dd>{where}</dd>
          </>
        ) : null}
        {house.length > 0 ? (
          <>
            <dt className="text-muted">Usual crowd</dt>
            <dd>{house.join(" ")}</dd>
          </>
        ) : null}
        {x.limits && !/not affiliated/i.test(x.limits) ? (
          <>
            <dt className="text-muted">Doesn&apos;t show</dt>
            <dd>{x.limits}</dd>
          </>
        ) : null}
      </dl>
      {x.ledgerRefs.length > 0 ? (
        <p className="mt-1.5 text-sm text-muted">
          Receipts
          <Refs ids={x.ledgerRefs} entityId={p.entity.entityId} />
        </p>
      ) : null}
    </div>
  );
}

/** Phone and website in ink with an underline: they are for calling, not part of the reading. */
function Contact({ p }: { p: Partner }) {
  const bits = [
    // No phone is said, as the print view and the PDF say it, so the row never just lacks one.
    p.phone ? (
      <a key="tel" className="tabular underline underline-offset-2" href={telHref(p.phone)}>
        {formatPhone(p.phone)}
      </a>
    ) : (
      <span key="tel" className="text-muted">
        {PHONE_NOT_LISTED}
      </span>
    ),
    p.website ? (
      <a key="web" className="underline underline-offset-2" href={p.website} target="_blank" rel="noreferrer" title={shortUrl(p.website)}>
        Website<span className="sr-only"> of {p.entity.name} (opens in a new tab)</span>
      </a>
    ) : null,
  ].filter(Boolean);
  return (
    <span className="mt-0.5 block text-sm text-muted">
      {p.address}
      <span className="block text-ink">
        {bits.map((b, i) => (
          <Fragment key={i}>
            {i > 0 ? <span className="text-muted"> · </span> : null}
            {b}
          </Fragment>
        ))}
      </span>
    </span>
  );
}

export function PartnersCard({
  sheet,
  canRevise = false,
}: {
  sheet: StreetSheet;
  /** The "Change something" box is on the page, so an empty list can point to it. */
  canRevise?: boolean;
}) {
  const env = sheet.cards.partners;
  const popularity = sheet.popularityCheck;
  // Live sheets only: a sample's places and ranks are made up, so they make no case either way.
  const withOut = useMemo(() => (sheet.mode === "live" ? withWithout(sheet) : null), [sheet]);
  const day = streetDayShort(sheet.operator.streetTeamDays);
  // The same hours per partner as the PDF, the print view, partners.csv and street-team.ics.
  const hoursCol = useMemo(() => partnerHoursColumn(sheet), [sheet]);
  const top = useMemo(() => topTiles(sheet), [sheet]);
  // The areas the partner pools came from, numbered and named as on the map.
  const byHash = useMemo(() => new Map(sheet.cards.liftMap.results.tiles.map((t) => [t.geohash, t])), [sheet]);
  const areas = [...new Set(env.results.map((p) => p.tileGeohash).filter((g): g is string => !!g))]
    .map((g) => {
      const i = top.findIndex((t) => t.geohash === g);
      return {
        geohash: g,
        marker: i + 1,
        // Named with its own state, like the map and the area list ("Langston, DC").
        name: i >= 0 ? areaName(top[i]) : partnerAreaLabel(env.results.find((p) => p.tileGeohash === g) ?? { tileGeohash: g }, byHash) || areaName(byHash.get(g)),
        count: env.results.filter((p) => p.tileGeohash === g).length,
      };
    })
    .sort((a, b) => (a.marker || 99) - (b.marker || 99));
  const [areaFilter, setAreaFilter] = useState<string | null>(null);
  const [openWhy, setOpenWhy] = useState<Set<string>>(() => new Set());
  const rows = env.results.filter((p) => areaFilter === null || p.tileGeohash === areaFilter);
  const filteredTo = areaFilter === null ? undefined : areas.find((a) => a.geohash === areaFilter);
  const anyWhy = env.results.some((p) => p.explain);
  const notes = env.limits.some((l) => /not affiliated/i.test(l)) ? env.limits : ["Suggested, not affiliated: no partner has agreed to anything.", ...env.limits];
  // Partners this revision added: "new" at the end of their Why cell, no coloured row.
  const added = useMemo(
    () => new Set((sheet.revision?.changes ?? []).filter((c) => c.kind === "partner_added").map((c) => normalizeName(c.label))),
    [sheet.revision],
  );
  // A less certain pick: a dagger after its name, explained once under the table (the same rule as on paper).
  // When every pick is less certain the dagger says nothing, so none is drawn and one line says it instead.
  const allThin = env.results.length > 1 && env.results.every((p) => partnerLessSure(p));
  const thin = (p: Partner) => !allThin && partnerLessSure(p);
  const anyThin = env.results.some(thin);
  // Numbered areas on the map that no partner search covered, or whose places all left the list: say so, or a number
  // with no partner reads as a bug. The searched areas come from the search receipts, not from the rows that stayed.
  const searchedHashes = useMemo(() => partnerSearchAreas(sheet), [sheet]);
  const searchLine = partnerSearchLine(
    top.length,
    top.flatMap((t, i) => (searchedHashes.has(t.geohash) ? [i + 1] : [])),
    new Set(areas.map((a) => a.marker).filter((n) => n > 0)),
  );
  const nearVenue = env.results.some((p) => !p.tileGeohash);
  // The header already says the signal is thin, once; the section doesn't repeat it.
  const reason = env.reason && isThinSignal(sheet) ? env.reason.replace(/\s*The signal is thin, so treat this as a starting list\./, "").trim() || undefined : env.reason;

  const toggleWhy = (id: string) =>
    setOpenWhy((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const areaWords = (p: Partner, a: (typeof areas)[number] | undefined) => {
    const label = a ? a.name : partnerAreaLabel(p, byHash);
    // An address over a state line from its area says so: "Kenilworth, DC · place in MD".
    const own = label ? otherState(p, label) : null;
    const hint = own ? <span className="text-muted"> · place in {own}</span> : null;
    return a ? (
      <>
        {a.marker > 0 ? (
          <>
            <span className="sr-only">Area </span>
            <span className="font-semibold tabular">{a.marker}</span>{" "}
          </>
        ) : null}
        {a.name}
        {hint}
      </>
    ) : label ? (
      <>
        {label}
        {hint}
      </>
    ) : (
      "Near the venue"
    );
  };

  // The model's lines. The template's partner lines repeat the rank line above them, so a sheet the template wrote shows
  // none; on a sheet Claude wrote, a row with no line (none written, or one the checks left out) gets its fixed line.
  const narrated = (p: Partner) => {
    if (!sheet.narration || sheet.narration.templated) return undefined;
    const line = partnerLine(sheet, p.entity.entityId);
    return line ? humanTimes(line) : fixedPartnerLine(p);
  };
  // Claude's line is about the first street-team day; the Visit day cell may name another (only Claude's lines name one).
  const dayNote = (p: Partner) =>
    hoursCol.byVisit && sheet.narration && !sheet.narration.templated ? lineDayNote(partnerLine(sheet, p.entity.entityId), hoursCol.cell(p).visitDay) : null;

  const whyCell = (p: Partner) => {
    const w = partnerWhy(p);
    const isNew = added.has(normalizeName(p.entity.name));
    const note = dayNote(p);
    return (
      <>
        <span>
          {w.text}
          <Refs ids={w.refs} entityId={p.entity.entityId} />
          {isNew ? <span className="text-muted"> new</span> : null}
        </span>
        {/* The narration's one line for this partner: checked against this run's ids, numbers and words. */}
        {narrated(p) ? (
          <span className="mt-1 block">
            {narrated(p)}
            {note ? <span className="text-muted"> {note}</span> : null}
          </span>
        ) : null}
        {/* Controls stay on screen: a printed sheet has no button to press. */}
        {p.explain ? (
          <span className="no-print mt-1 block">
            <button
              type="button"
              className="text-sm text-muted underline underline-offset-2 hover:text-ink"
              aria-expanded={openWhy.has(p.entity.entityId)}
              aria-controls={`${partnerAnchor(p.entity.entityId)}-why`}
              onClick={() => toggleWhy(p.entity.entityId)}
            >
              {openWhy.has(p.entity.entityId) ? "Hide why" : "Why this place"}
              <span className="sr-only">: {p.entity.name}</span>
            </button>
          </span>
        ) : null}
      </>
    );
  };

  return (
    // The card's limits sit under the table here.
    <PlanCard id="partners" title="Partners" count={env.results.length} envelope={{ ...env, limits: [], reason }} summary={partnerSummary(sheet)} wide>
      {env.results.length > 0 ? (
        <p className="link-row mb-4 text-muted" {...(areas.length > 1 ? { role: "group", "aria-label": "Show partners in one area" } : {})}>
          <span className="link-row-lead">
            {areas.length > 0 ? `Listed by area as numbered on the map${nearVenue ? ", then near the venue" : ""}, best fit first.` : "Best fit first."}
            {searchLine ? ` ${searchLine}` : ""}
            {areas.length > 1 ? <span className="no-print"> Show:</span> : null}
            {/* The area buttons don't print, so a filtered list says on paper that it is filtered. */}
            {filteredTo ? (
              <span className="hidden print:inline">
                {` Only ${rows.length === 1 ? "the 1 partner" : `the ${rows.length} partners`} in ${
                  filteredTo.marker > 0 ? `area ${filteredTo.marker} (${filteredTo.name})` : filteredTo.name
                } ${rows.length === 1 ? "is" : "are"} listed here. The other areas were hidden on screen.`}
              </span>
            ) : null}
          </span>
          {areas.length > 1 ? (
            <>
              <button type="button" className="text-button no-print" aria-pressed={areaFilter === null} onClick={() => setAreaFilter(null)}>
                all
              </button>
              {areas.map((a) => (
                <button
                  key={a.geohash}
                  type="button"
                  className="text-button no-print"
                  aria-pressed={areaFilter === a.geohash}
                  onClick={() => setAreaFilter((f) => (f === a.geohash ? null : a.geohash))}
                >
                  {a.marker > 0 ? `${a.marker} ` : ""}
                  {a.name}
                </button>
              ))}
            </>
          ) : null}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="max-w-[760px]">
          No partners came back for this sheet.{" "}
          {canRevise
            ? "Try another street-team day or a wider radius in Change something below."
            : "The partner searches found no place that passed the filters; the steps below say which ones ran."}
        </p>
      ) : (
        <table className="table">
          <caption className="sr-only">
            Suggested partners, best first
            {hoursCol.byVisit ? ", with the day the street team visits each one and its hours that day" : day ? `, with their hours on ${day}` : ""}
          </caption>
          <thead>
            <tr>
              {/* Under 640px the rows are two-line blocks: the lone header is hidden but still read out. */}
              <th scope="col" className="max-sm:border-0 max-sm:p-0 md:w-[30%]">
                <span className="max-sm:sr-only">Name</span>
              </th>
              <th scope="col" className="hidden md:table-cell md:w-[11%]">
                Type
              </th>
              <th scope="col" className="hidden md:table-cell md:w-[17%]">
                Area
              </th>
              <th scope="col" className="hidden md:table-cell md:w-[12%]">
                {hoursCol.header}
              </th>
              <th scope="col" className="hidden sm:table-cell">
                Why
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const id = p.entity.entityId;
              const area = areas.find((a) => a.geohash === p.tileGeohash);
              const h = hoursCol.cell(p);
              const noHours = h.hoursMissing;
              const hours = h.hours;
              const open = openWhy.has(id);
              return (
                <Fragment key={id}>
                  <tr id={partnerAnchor(id)} className={`scroll-mt-4 ${noHours ? "bg-warn" : ""} ${open ? "[&>td]:border-b-0" : ""}`}>
                    <td>
                      <span className="font-semibold">{p.entity.name}</span>
                      {thin(p) ? (
                        <span>
                          <span aria-hidden="true">†</span>
                          <span className="sr-only"> (less certain)</span>
                        </span>
                      ) : null}
                      <span className="mt-0.5 block text-sm text-muted md:hidden">
                        {areaWords(p, area)}
                        {` · ${typeWords(p)} · ${h.withDay}`}
                      </span>
                      <Contact p={p} />
                      <span className="mt-1 block text-sm sm:hidden">{whyCell(p)}</span>
                    </td>
                    <td className="hidden md:table-cell">{typeWords(p)}</td>
                    <td className="hidden md:table-cell">{areaWords(p, area)}</td>
                    <td className={`hidden md:table-cell ${noHours ? "text-sm" : "tabular"}`}>{hours}</td>
                    <td className="hidden sm:table-cell">{whyCell(p)}</td>
                  </tr>
                  {open ? (
                    <tr id={`${partnerAnchor(id)}-why`}>
                      <td colSpan={5} className="bg-subtle px-3">
                        <PartnerWhy p={p} area={area ? area.name : partnerAreaLabel(p, byHash) || undefined} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {anyThin && rows.length > 0 ? <p className="mt-3 max-w-[760px] text-sm text-muted">{LESS_SURE_NOTE}<span className="no-print"> &ldquo;Why this place&rdquo; gives the reason.</span></p> : null}
      {allThin && rows.length > 0 ? (
        <p className="mt-3 max-w-[760px] text-sm text-muted" data-testid="all-less-sure">
          Every pick on this list is less certain: the signal for this bill is thin. Call before you go.<span className="no-print"> &ldquo;Why this place&rdquo; gives the reason.</span>
        </p>
      ) : null}
      {/* Qloo with the bill vs Qloo without a signal, same searches: absent when a twin failed or came back empty. */}
      {popularity && env.results.length > 0 ? (
        <p className="mt-3 max-w-[760px]" data-testid="popularity-check">
          {popularityLine(popularity)}
          <Refs ids={popularity.ledgerRefs} />
        </p>
      ) : null}
      {/*
        The Fan-Bar Test did not support H1 (docs/preregistration/p1-plan.md §13), so no claim that these picks beat
        popularity: one short line here; the sheet's limits state the test once, with its scope and numbers.
      */}
      {env.results.length > 0 ? (
        <p className="mt-3 max-w-[760px]" data-testid="p1-banner">
          {PARTNER_RANK_LINE}{" "}
          <a href={FANBAR_HREF} className="link">
            The test
          </a>
        </p>
      ) : null}
      {/* One area up close: the popularity-only list beside the picks, by name (live sheets with the names stored). */}
      {withOut && env.results.length > 0 ? (
        <WithWithout data={withOut} className="mt-5" refs={<Refs ids={[withOut.popularRef, ...withOut.pickRefs]} />} />
      ) : null}
      <p className="mt-4 max-w-[760px]">
        {notes.join(" ")} Call before you drop posters.
        {areas.length > 0 ? ` ${AREA_REACH_NOTE}` : ""}
        {anyWhy ? <span className="no-print"> Open “Why this place” for what to ask and how sure the pick is.</span> : null}
      </p>
    </PlanCard>
  );
}
