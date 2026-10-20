"use client";
import { Fragment, useMemo, useState } from "react";
import type { ControlArmResult, Partner, StreetSheet } from "@walkup/contracts";
import { formatInt, shortUrl, telHref } from "../../lib/format";
import { categoryLabel } from "../../lib/labels";
import { areaName, formatHours, isThinSignal, normalizeName, overlapSummary, partnerSummary, topTiles } from "../../lib/sheet-utils";
import { LESS_SURE_NOTE, partnerLessSure } from "@walkup/exports/format";
import { CONFIDENCE_LABEL, houseLines, influenceLine, partnerAnchor, partnerWhy, streetDayShort } from "./model";
import { PlanCard } from "./PlanCard";
import { Refs } from "./receipts";

/** Tag names inside a sentence: lower case except acronyms ("R&B"). */
const tagWord = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => ((w.match(/[A-Z]/g)?.length ?? 0) >= 2 ? w : w.toLowerCase()))
    .join(" ");

/** The "Why this place" detail under a partner row (only when the sheet carries `partner.explain`). */
export function PartnerWhy({ p, area }: { p: Partner; area?: string }) {
  const x = p.explain;
  if (!x) return null;
  const where = [area ?? x.areaName ?? p.tileName, typeof x.distanceKm === "number" && !/\d km \w+$/.test(area ?? x.areaName ?? "") ? `${x.distanceKm.toFixed(1)} km from the venue` : null]
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
    p.phone ? (
      <a key="tel" className="underline underline-offset-2" href={telHref(p.phone)}>
        {p.phone}
      </a>
    ) : null,
    p.website ? (
      <a key="web" className="underline underline-offset-2" href={p.website} target="_blank" rel="noreferrer" title={shortUrl(p.website)}>
        Website<span className="sr-only"> of {p.entity.name} (opens in a new tab)</span>
      </a>
    ) : null,
  ].filter(Boolean);
  if (!p.address && bits.length === 0) return null;
  return (
    <span className="mt-0.5 block text-sm text-muted">
      {p.address}
      {bits.length > 0 ? (
        <span className="block text-ink">
          {bits.map((b, i) => (
            <Fragment key={i}>
              {i > 0 ? <span className="text-muted"> · </span> : null}
              {b}
            </Fragment>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** "3 of its 20 places are also among the 24 partners above." / "None of its 20 places is among the 24 partners above." */
export function controlOverlapLine(inBoth: number, controlCount: number, partnerCount: number): string {
  if (controlCount === 0) return "";
  if (controlCount === 1) return `Its one place ${inBoth > 0 ? "is also" : "isn't"} among the ${partnerCount} partners above.`;
  if (inBoth === 0) return `None of its ${controlCount} places is among the ${partnerCount} partners above.`;
  return `${inBoth} of its ${controlCount} places ${inBoth === 1 ? "is" : "are"} also among the ${partnerCount} partners above.`;
}

function ControlList({
  control,
  both,
  templated,
  partnerCount,
  sample,
}: {
  control: ControlArmResult;
  both: Set<string>;
  templated: boolean;
  partnerCount: number;
  sample: boolean;
}) {
  const inBoth = control.places.filter((pl) => both.has(normalizeName(pl.name))).length;
  return (
    <div className="mt-10" id="without-qloo">
      <h3 className="text-base">The same inputs with Google Places</h3>
      {control.places.length > 0 ? (
        <p className="mt-1 max-w-[760px]" data-testid="control-overlap">
          {controlOverlapLine(inBoth, control.places.length, partnerCount)}
        </p>
      ) : null}
      <p className="hint mt-0.5 max-w-[760px]">
        {templated
          ? "No model key is set, so fixed searches ranked by Google rating stood in for the model's own searches."
          : "Claude, given the same inputs, picking its own Google Places searches."}{" "}
        Shown for comparison; neither list is the right answer. These places are listed here only and never drawn on the map.
        <Refs ids={control.ledgerRefs} />
      </p>
      {control.places.length === 0 ? (
        <p className="mt-3">The Google Places list is empty for this sheet.</p>
      ) : (
        <ol className="mt-3 list-decimal space-y-2 pl-6 md:columns-2 md:gap-x-10">
          {control.places.map((pl) => {
            const inBoth = both.has(normalizeName(pl.name));
            const facts = [
              typeof pl.rating === "number" ? `${pl.rating.toFixed(1)} stars from ${formatInt(pl.userRatingCount ?? 0)} reviews` : null,
              `searched “${pl.query}”`,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={pl.placeId} className="break-inside-avoid">
                <span className="font-semibold">{pl.name}</span>
                {inBoth ? <span className="text-muted"> (also a partner above)</span> : null}
                {pl.address ? <span className="block text-sm text-muted">{pl.address}</span> : null}
                <span className="block text-sm text-muted">{facts}</span>
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-3 text-sm text-muted">
        {sample ? "Sample data: made-up places standing in for Google Places results." : "Place data from Google. Kept for 30 days at most."}
      </p>
    </div>
  );
}

export function PartnersCard({
  sheet,
  control,
  compare,
  canRevise = false,
}: {
  sheet: StreetSheet;
  control: ControlArmResult;
  compare: boolean;
  /** The "Change something" box is on the page, so an empty list can point to it. */
  canRevise?: boolean;
}) {
  const env = sheet.cards.partners;
  const day = streetDayShort(sheet.operator.streetTeamDays);
  const top = useMemo(() => topTiles(sheet), [sheet]);
  // The areas the partner pools came from, numbered and named as on the map.
  const byHash = useMemo(() => new Map(sheet.cards.liftMap.results.tiles.map((t) => [t.geohash, t])), [sheet]);
  const areas = [...new Set(env.results.map((p) => p.tileGeohash).filter((g): g is string => !!g))]
    .map((g) => {
      const i = top.findIndex((t) => t.geohash === g);
      return {
        geohash: g,
        marker: i + 1,
        name: i >= 0 ? areaName(top[i]) : (env.results.find((p) => p.tileGeohash === g)?.tileName ?? areaName(byHash.get(g))),
        count: env.results.filter((p) => p.tileGeohash === g).length,
      };
    })
    .sort((a, b) => (a.marker || 99) - (b.marker || 99));
  const [areaFilter, setAreaFilter] = useState<string | null>(null);
  const [openWhy, setOpenWhy] = useState<Set<string>>(() => new Set());
  const ov = overlapSummary(env.results, control);
  const rows = env.results.filter((p) => areaFilter === null || p.tileGeohash === areaFilter);
  const anyWhy = env.results.some((p) => p.explain);
  const notes = env.limits.some((l) => /not affiliated/i.test(l)) ? env.limits : ["Suggested, not affiliated: no partner has agreed to anything.", ...env.limits];
  const templated = sheet.limits.some((l) => /^The Google Places list used fixed searches|^Without-Qloo list \(template\)/.test(l));
  // Partners this revision added: "new" at the end of their Why cell, no coloured row.
  const added = useMemo(
    () => new Set((sheet.revision?.changes ?? []).filter((c) => c.kind === "partner_added").map((c) => normalizeName(c.label))),
    [sheet.revision],
  );
  // A less certain pick: a dagger after its name, explained once under the table (the same rule as on paper).
  const thin = (p: Partner) => partnerLessSure(p);
  const anyThin = env.results.some(thin);
  // Numbered areas on the map that no partner search covered: say so, or it reads as a bug.
  const searchedNumbers = new Set(areas.map((a) => a.marker).filter((n) => n > 0));
  const flyerOnly = top.map((_, i) => i + 1).filter((n) => !searchedNumbers.has(n));
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

  const areaWords = (p: Partner, a: (typeof areas)[number] | undefined) =>
    a ? (
      <>
        {a.marker > 0 ? (
          <>
            <span className="sr-only">Area </span>
            <span className="font-semibold tabular">{a.marker}</span>{" "}
          </>
        ) : null}
        {a.name}
      </>
    ) : (
      (p.tileName ?? "Near the venue")
    );

  const whyCell = (p: Partner) => {
    const w = partnerWhy(p);
    const isNew = added.has(normalizeName(p.entity.name));
    return (
      <>
        <span>
          {w.text}
          <Refs ids={w.refs} entityId={p.entity.entityId} />
          {isNew ? <span className="text-muted"> new</span> : null}
        </span>
        {p.explain ? (
          <span className="mt-1 block">
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
    // The card's limits sit under the table here, before the comparison list.
    <PlanCard id="partners" title="Partners" count={env.results.length} envelope={{ ...env, limits: [], reason }} summary={partnerSummary(sheet)} wide>
      {env.results.length > 0 ? (
        <p className="link-row mb-4 text-muted" {...(areas.length > 1 ? { role: "group", "aria-label": "Show partners in one area" } : {})}>
          <span className="link-row-lead">
            {areas.length > 0 ? `Listed by area as numbered on the map${nearVenue ? ", then near the venue" : ""}, best fit first.` : "Best fit first."}
            {flyerOnly.length > 0 && searchedNumbers.size > 0
              ? ` Walkup searches the top ${searchedNumbers.size} ${searchedNumbers.size === 1 ? "area" : "areas"} for partners; ${
                  flyerOnly.length === 1 ? `area ${flyerOnly[0]} is` : `areas ${flyerOnly.slice(0, -1).join(", ")} and ${flyerOnly[flyerOnly.length - 1]} are`
                } for flyering only.`
              : ""}
            {areas.length > 1 ? " Show:" : ""}
          </span>
          {areas.length > 1 ? (
            <>
              <button type="button" className="text-button" aria-pressed={areaFilter === null} onClick={() => setAreaFilter(null)}>
                all
              </button>
              {areas.map((a) => (
                <button
                  key={a.geohash}
                  type="button"
                  className="text-button"
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

      {compare ? (
        <p className="mb-4 max-w-[760px]" aria-live="polite">
          {ov.both.size === 0
            ? `None of these ${env.results.length} partners is on the Google Places list, which has ${control.places.length} places of its own.`
            : `${ov.both.size} of these ${env.results.length} partners ${ov.both.size === 1 ? "is" : "are"} also on the Google Places list; ${ov.controlOnly} of its ${control.places.length} places are only there.`}{" "}
          <a href="#without-qloo" className="link">
            See that list
          </a>
          . This shows where the lists differ, not which one sells tickets.
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
          <caption className="sr-only">Suggested partners, best first{day ? `, with their hours on ${day}` : ""}</caption>
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
                {day ? `Open ${day}` : "Hours"}
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
              const noHours = !p.hoursOnDay;
              const hours = p.hoursOnDay ? formatHours(p.hoursOnDay.replace(/^[A-Z][a-z]{2} /, "")) : "Hours not listed: call first";
              const inBoth = compare && ov.both.has(normalizeName(p.entity.name));
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
                      {inBoth ? <span className="text-muted"> (also on the Google Places list)</span> : null}
                      <span className="mt-0.5 block text-sm text-muted md:hidden">
                        {areaWords(p, area)}
                        {` · ${categoryLabel(p.category)} · ${day ? `${day} ${hours}` : hours}`}
                      </span>
                      <Contact p={p} />
                      <span className="mt-1 block text-sm sm:hidden">{whyCell(p)}</span>
                    </td>
                    <td className="hidden md:table-cell">{categoryLabel(p.category)}</td>
                    <td className="hidden md:table-cell">{areaWords(p, area)}</td>
                    <td className={`hidden md:table-cell ${p.hoursOnDay ? "tabular" : "text-sm"}`}>{hours}</td>
                    <td className="hidden sm:table-cell">{whyCell(p)}</td>
                  </tr>
                  {open ? (
                    <tr id={`${partnerAnchor(id)}-why`}>
                      <td colSpan={5} className="bg-subtle px-3">
                        <PartnerWhy p={p} {...(area ? { area: area.name } : {})} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {anyThin && rows.length > 0 ? <p className="mt-3 max-w-[760px] text-sm text-muted">{LESS_SURE_NOTE} &ldquo;Why this place&rdquo; gives the reason.</p> : null}
      <p className="mt-4 max-w-[760px]">
        {notes.join(" ")} Call before you drop posters.
        {anyWhy ? " Open “Why this place” for what to ask and how sure the pick is." : ""}
      </p>
      {compare ? (
        <ControlList control={control} both={ov.both} templated={templated} partnerCount={env.results.length} sample={sheet.mode === "fixture"} />
      ) : null}
    </PlanCard>
  );
}
