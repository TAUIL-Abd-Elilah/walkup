"use client";
import { useState } from "react";
import { AGE_BUCKETS } from "@walkup/contracts";
import type { AgeBucket, CompareTag, DemographicsBlock, QlooEntity, StreetSheet } from "@walkup/contracts";
import { formatDistance, formatInt, formatPct, formatSigned } from "../../lib/format";
import { CATEGORY_LABEL, STATUS_WORD, categoryLabel, subtypeLabel } from "../../lib/labels";
import { baselineName, crowdBaseline, crowdName, sourceLine, tagInSentence, tagIndex, tagLabel, tagName } from "../../lib/sheet-utils";
import { spotIsFanFacing } from "@walkup/exports/audience";
import { DECLARED_UNRANKED, SPOT_NOT_IN_USUAL, sheetAgeLabel, sheetSpots, spotSharesDiffer, spotsShareNote } from "@walkup/exports/format";
import { TrustTable } from "./LiftCard";
import { PlanCard } from "./PlanCard";
import { chipText } from "./model";
import { ClaimList, Refs, useReceipts } from "./receipts";

/** A spot's claim about the room's usual crowd ("ranks 3 places higher here than for the room's usual crowd"). */
const USUAL_CHIP = /\busual crowd\b|^tonight vs house\b/;

const placeType = (e: QlooEntity, category?: string): string =>
  category ? categoryLabel(category) : (CATEGORY_LABEL[e.tags[0]?.id.split(":").pop() ?? ""] ?? subtypeLabel(e.subtype));

// ---------------------------------------------------------------------------
// Your list (declared partners)
// ---------------------------------------------------------------------------

export function DeclaredCard({ sheet }: { sheet: StreetSheet }) {
  const env = sheet.cards.declared;
  return (
    // An empty list is said once, in the summary line; no status word beside the heading.
    <PlanCard id="declared" title="Your list" envelope={env.results.length === 0 ? { ...env, status: "ok", reason: undefined } : env}>
      {env.results.length === 0 ? null : (
        <table className="table">
          <caption className="sr-only">Your partners in call order for this bill</caption>
          <thead>
            <tr>
              <th scope="col" className="num w-12">
                Rank
              </th>
              <th scope="col">Name</th>
            </tr>
          </thead>
          <tbody>
            {env.results.map((d, i) => (
              <tr key={`${d.declared.label}-${i}`}>
                <td className="num">{d.rank ?? "–"}</td>
                <td>
                  <span className="font-semibold">{d.declared.label}</span>
                  <Refs ids={d.chips.map((c) => c.ledgerRef)} {...(d.entity ? { entityId: d.entity.entityId } : {})} />
                  <span className="mt-0.5 block text-sm text-muted">
                    {d.entity
                      ? [String(d.entity.properties.address ?? ""), placeType(d.entity)].filter(Boolean).join(" · ")
                      : `${DECLARED_UNRANKED.charAt(0).toUpperCase()}${DECLARED_UNRANKED.slice(1)}`}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {env.results.length > 0 ? <p className="hint mt-3">Ranked for this bill. Walkup never adds groups on its own and never emails anyone you didn&apos;t type.</p> : null}
    </PlanCard>
  );
}

// ---------------------------------------------------------------------------
// Before and after the show
// ---------------------------------------------------------------------------

export function PrePostCard({ sheet }: { sheet: StreetSheet }) {
  const env = sheet.cards.prePost;
  const [fanFacing, setFanFacing] = useState(false);
  const [caps, setCaps] = useState<Record<string, number>>(() => Object.fromEntries(env.results.map((s) => [s.entity.entityId, s.assumedCapacity])));
  const attendance = sheet.operator.capacity;
  // The shared spot list (`sheetSpots`, the same as the PDF, the print view and the CSVs): no carts, kiosks, stands
  // or food trucks, local spots nearest to the venue first, then national chains.
  const spots = sheetSpots(env.results);
  // The same fan-facing rule as the PDF and the CSVs: the show's age policy and the operator's all-ages setting.
  const rows = spots.filter((s) => !fanFacing || spotIsFanFacing(s, sheet));
  // The PDF's and print view's age line (sheetAgeLabel): Ticketmaster's policy, then the operator's all-ages setting
  // when that adds a rule. On a 21+ show the setting is what hides bars from fans, so "that policy" must name it.
  const age =
    sheet.bill.legalAgeEnforced === null
      ? `not on the listing, so treated as all ages${sheet.operator.allAges === true ? ". The operator set this sheet to all ages: no bars" : ""}`
      : sheetAgeLabel(sheet.bill, sheet.operator).long;
  const hidden = spots.length - rows.length;
  // Every spot with the same share says nothing per row (and neither do the guests it implies): the Share and Guests
  // columns are left out and the share goes in the note under the table instead, as on the PDF.
  const showShare = spotSharesDiffer(spots.map((s) => s.expectedShare));
  const uniformShare = !showShare && spots.length > 0 ? spots[0]!.expectedShare : null;
  const showGuests = attendance !== null && showShare;
  // When the usual crowd's list came back, a spot it left out says so, as the PDF's "Vs usual crowd" column does, with
  // the receipt of that list. The run gives such a spot no chip of its own.
  const usualBack = spots.some((s) => s.deltaRank !== null && Number.isFinite(s.deltaRank));
  const usualRef = spots.flatMap((s) => s.chips).find((c) => USUAL_CHIP.test(c.label))?.ledgerRef ?? "";
  const claims = (s: (typeof spots)[number]) =>
    usualBack && (s.deltaRank === null || !Number.isFinite(s.deltaRank)) && !s.chips.some((c) => USUAL_CHIP.test(c.label))
      ? [...s.chips, { label: SPOT_NOT_IN_USUAL, ledgerRef: usualRef }]
      : s.chips;

  return (
    <PlanCard id="prepost" title="Before and after the show" envelope={env}>
      <p className="mb-3">
        Age policy: {age}.
        {fanFacing && hidden > 0 ? ` ${hidden} ${hidden === 1 ? "spot is" : "spots are"} hidden from fans under that policy.` : ""}{" "}
        <button type="button" className="text-button text-sm no-print" aria-pressed={fanFacing} onClick={() => setFanFacing((v) => !v)}>
          {fanFacing ? "Show every spot" : "Show what fans see"}
        </button>
      </p>
      <table className="table">
        <caption className="sr-only">Spots near the venue with their expected share of the crowd</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" className="num hidden sm:table-cell">
              Distance
            </th>
            {showShare ? (
              <th scope="col" className="num">
                Share
              </th>
            ) : null}
            {showGuests ? (
              <th scope="col" className="num hidden sm:table-cell">
                Guests
              </th>
            ) : null}
            <th scope="col" className="num">
              Capacity
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const cap = caps[s.entity.entityId] ?? s.assumedCapacity;
            const expected = attendance !== null ? Math.round(attendance * s.expectedShare) : null;
            const capped = expected !== null && expected > cap;
            const inputId = `cap-${s.entity.entityId}`;
            return (
              <tr key={s.entity.entityId}>
                <td>
                  <span className="font-semibold">{s.entity.name}</span>
                  <span className="mt-0.5 block text-sm text-muted">
                    {[placeType(s.entity, s.category), s.chain ? "national chain" : null, !spotIsFanFacing(s, sheet) ? "not shown to fans" : null].filter(Boolean).join(" · ")}
                    {formatDistance(s.entity.distanceM) ? <span className="sm:hidden"> · {formatDistance(s.entity.distanceM)} away</span> : null}
                  </span>
                  {claims(s).length > 0 ? (
                    <span className="mt-0.5 block text-sm">
                      <ClaimList chips={claims(s)} entityId={s.entity.entityId} wording={chipText} />
                    </span>
                  ) : null}
                </td>
                <td className="num hidden whitespace-nowrap sm:table-cell">{formatDistance(s.entity.distanceM)}</td>
                {showShare ? <td className="num">{formatPct(s.expectedShare, 1)}</td> : null}
                {showGuests && expected !== null ? (
                  <td className="num hidden sm:table-cell">
                    {formatInt(Math.min(expected, cap))}
                    {capped ? <span className="block text-sm text-muted">capped</span> : null}
                  </td>
                ) : null}
                <td className="num">
                  <label htmlFor={inputId} className="sr-only">
                    Assumed capacity for {s.entity.name}
                  </label>
                  <input
                    id={inputId}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={5}
                    value={cap}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setCaps((c) => ({ ...c, [s.entity.entityId]: Number.isFinite(v) && v >= 0 ? v : 0 }));
                    }}
                    className="ml-auto block w-16 rounded-[4px] border border-transparent bg-transparent px-1 py-0.5 text-right tabular hover:border-control focus:border-control max-sm:border-control"
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint mt-3">
        {uniformShare !== null
          ? `Each spot gets the same share of the crowd, ${formatPct(uniformShare, 1)}.${attendance !== null ? ` That is about ${formatInt(Math.round(attendance * uniformShare))} of ${formatInt(attendance)} people:` : " It is"} a rule of thumb, not a forecast.`
          : <>
              {spotsShareNote(spots.map((s) => s.assumedCapacity))}{" "}
              {attendance !== null
                ? <>Guests is the assumed {formatInt(attendance)} times the share, capped at the capacity<span className="no-print">; change a capacity to see it move</span>.</>
                : "Capacity isn't entered, so there is no Guests column."}
            </>}
      </p>
    </PlanCard>
  );
}

// ---------------------------------------------------------------------------
// Podcasts and a sponsor
// ---------------------------------------------------------------------------

const NO_SPONSOR = "No sponsor brand came back.";

export function MediaCard({ sheet }: { sheet: StreetSheet }) {
  const env = sheet.cards.media;
  const podcasts = env.results.filter((m) => m.kind === "podcast");
  const sponsors = env.results.filter((m) => m.kind === "sponsor");
  // The summary says once that every pick is national; a row says its scope only when some are local.
  const anyLocal = env.results.some((m) => m.scope === "local");
  const noSponsorSaid = (env.reason ?? "").includes(NO_SPONSOR);
  return (
    <PlanCard id="media" title="Podcasts and a sponsor" envelope={env}>
      <h3 className="text-base">Podcasts for a host read or a giveaway</h3>
      <p className="hint mt-0.5">Each is ranked for this bill&apos;s crowd.</p>
      {podcasts.length === 0 ? (
        <p className="mt-1">No podcast came back for this bill.</p>
      ) : (
        <ul className="mt-2 border-t border-rule">
          {podcasts.map((m) => (
            <li key={m.entity.entityId} className="border-b border-rule py-2">
              <span className="font-semibold">{m.entity.name}</span>
              <Refs ids={m.chips.map((c) => c.ledgerRef)} entityId={m.entity.entityId} />
              <span className="text-muted">
                {[m.entity.properties.publisher ? ` · ${String(m.entity.properties.publisher)}` : "", anyLocal ? ` · ${m.scope === "local" ? "local" : "national"}` : ""].join("")}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* Said once: when the section's "Why:" line already says no sponsor came back, the sponsor part is left out (as on the PDF). */}
      {sponsors.length === 0 && noSponsorSaid ? null : <h3 className="mt-6 text-base">One sponsor to approach</h3>}
      {sponsors.length === 0 ? (
        noSponsorSaid ? null : <p className="mt-1">{NO_SPONSOR}</p>
      ) : (
        sponsors.map((m) => (
          <p key={m.entity.entityId} className="mt-1">
            <span className="font-semibold">{m.entity.name}</span>
            <Refs ids={m.chips.map((c) => c.ledgerRef)} entityId={m.entity.entityId} />
            <span className="text-muted">
              {" "}
              · {subtypeLabel(m.entity.subtype)}
              {anyLocal ? ` · ${m.scope === "local" ? "local" : "national"}` : ""}
            </span>
          </p>
        ))
      )}
    </PlanCard>
  );
}

// ---------------------------------------------------------------------------
// Copy lines
// ---------------------------------------------------------------------------

export function CopyHooksCard({ sheet }: { sheet: StreetSheet }) {
  const env = sheet.cards.copyHooks;
  const tags = tagIndex(sheet);
  const [copied, setCopied] = useState<number | null>(null);
  return (
    <PlanCard id="hooks" title="Copy lines" envelope={env}>
      <ul className="border-t border-rule">
        {env.results.map((h, i) => (
          <li key={h.text} className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-rule py-3">
            <div className="min-w-0 flex-1">
              <p className="text-base">&ldquo;{h.text}&rdquo;</p>
              <p className="mt-0.5 text-sm text-muted">
                {h.tagIds.length === 1 ? "From the tag: " : "From the tags: "}
                {h.tagIds.map((id) => tagName(tags, id)).join(", ")}
              </p>
            </div>
            <button
              type="button"
              className="no-print btn btn-ghost min-h-0 px-3 py-1 text-sm whitespace-nowrap"
              aria-label={copied === i ? "Copied" : "Copy this line"}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(h.text);
                  setCopied(i);
                  setTimeout(() => setCopied(null), 2000);
                } catch {
                  setCopied(null);
                }
              }}
            >
              {copied === i ? "Copied" : "Copy"}
            </button>
          </li>
        ))}
      </ul>
    </PlanCard>
  );
}

// ---------------------------------------------------------------------------
// How this crowd differs (tags and age skew)
// ---------------------------------------------------------------------------

const AGE_LABEL: Record<AgeBucket, string> = {
  "24_and_younger": "24 and under",
  "25_to_29": "25 to 29",
  "30_to_34": "30 to 34",
  "35_to_44": "35 to 44",
  "45_to_54": "45 to 54",
  "55_and_older": "55 and over",
};

function avgAge(blocks: DemographicsBlock[], b: AgeBucket): number | null {
  const vals = blocks.map((x) => x.age[b]).filter((v): v is number => typeof v === "number");
  if (vals.length === 0) return null;
  return vals.reduce((a, c) => a + c, 0) / vals.length;
}

function TagColumn({ title, tags }: { title: string; tags: CompareTag[] }) {
  return (
    <div className="min-w-0">
      <h3 className="text-base">{title}</h3>
      {tags.length === 0 ? (
        <p className="mt-1 text-muted">Nothing stood out.</p>
      ) : (
        <ul className="mt-2 border-t border-rule">
          {tags.map((t) => (
            <li key={t.id} className="flex justify-between gap-3 border-b border-rule py-1.5">
              <span>{tagLabel(t.name)}</span>
              {typeof t.score === "number" ? <span className="tabular text-muted">{t.score.toFixed(2)}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * "More about this crowd": one closed disclosure with the map checks in full, how this crowd differs from the
 * usual crowd, and the age mix. The street team rarely needs them; they stay one click away.
 */
export function DifferentCard({ sheet }: { sheet: StreetSheet }) {
  const env = sheet.cards.whatsDifferent;
  const demo = sheet.cards.demographics;
  const r = env.results;
  const demoWord = STATUS_WORD[demo.status];
  const word = STATUS_WORD[env.status];
  // The crowd these two compared with, which is not always the lift map's (a failed room heatmap leaves the genre on
  // the map only): the room's usual acts, the genre's fans, or nobody.
  const crowd = crowdName(sheet);
  const vsTag = crowdBaseline(sheet) === "tag";
  const against = crowd ?? baselineName(sheet);
  const Against = `${against.charAt(0).toUpperCase()}${against.slice(1)}`;
  const { entries, sample = false } = useReceipts();
  const source = sourceLine(env.provenance, entries, sample);
  // A tag both crowds rank high is listed once, under "Both rank high", never in a lean column too.
  const sharedIds = new Set(r.shared.map((t) => t.id));
  const leansA = r.a.filter((t) => !sharedIds.has(t.id));
  const leansB = r.b.filter((t) => !sharedIds.has(t.id));
  // No usual crowd and no genre stand-in: nothing to lean away from, so no columns that name one. The summary says why.
  const noUsual = crowd === null;
  const columns = !(noUsual && leansA.length === 0 && leansB.length === 0);
  // The age table's second column is whoever the age blocks came from: the room's usual acts, or the genre's fans.
  const ageVs = noUsual ? null : vsTag ? against : "the usual crowd";
  const ageVsCol = ageVs === null ? null : vsTag ? Against : "Usual crowd";
  // With no age block at all, a table of dashes says nothing the line above it doesn't.
  const ageTable = demo.results.bill.length > 0 || demo.results.house.length > 0;
  // Hosted sheets often have one bill block (one act, or one stand-in title): nothing is averaged then.
  const onlyBlock = demo.results.bill.length === 1 ? demo.results.bill[0] : undefined;
  const standInIds = new Set(sheet.cards.resolution.results.flatMap((x) => (x.proxy ? [x.proxy.entity.entityId] : [])));
  const ageOver = onlyBlock
    ? standInIds.has(onlyBlock.entityId)
      ? " for the bill's stand-in title"
      : " for the bill's act"
    : ", averaged across the bill's acts";
  return (
    <section id="different" aria-labelledby="different-title" className="section scroll-mt-4">
      <details className="plain-details">
        <summary>
          <h2 id="different-title" className="inline text-lg">
            More about this crowd
          </h2>
        </summary>
        <div className="mt-4 max-w-[760px]">
          <h3 className="text-base">How far to trust the map</h3>
          <TrustTable sheet={sheet} />
        </div>
        <div className="mt-8">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h3 className="text-base">How this crowd differs</h3>
            {word ? <span className="text-sm text-muted">{word}</span> : null}
          </div>
          {source ? (
            <p className="hint mt-0.5">
              {source}
              <Refs ids={env.provenance} />
            </p>
          ) : null}
          {env.summary ? <p className="mt-1 max-w-[760px]">{env.summary}</p> : null}
          {env.reason ? <p className="mt-1 max-w-[760px] text-muted">{env.reason.replace(/^(ok|empty|partial|degraded|error)\s*:\s*/i, "")}</p> : null}
          {columns ? (
            <div className="mt-3 grid gap-8 sm:grid-cols-2">
              <TagColumn title="This bill leans toward" tags={leansA} />
              <TagColumn title={`${Against} ${against.endsWith("crowd") ? "leans" : "lean"} toward`} tags={leansB} />
            </div>
          ) : null}
          {r.shared.length > 0 ? (
            <p className="mt-4">
              <span className="text-muted">Both rank high: </span>
              {r.shared.map((t) => tagInSentence(t.name)).join(", ")}.
              {r.fromTagDiff ? <span className="text-muted"> Worked out from two tag lists ranked against each other.</span> : null}
            </p>
          ) : null}
        </div>

        <div className="mt-8">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h3 className="text-base">{ageVs === null ? "Age mix" : `Age mix, this bill and ${ageVs}`}</h3>
            {demoWord ? <span className="text-sm text-muted">{demoWord}</span> : null}
          </div>
          <p className="hint mt-0.5">
            {demo.summary}
            <Refs ids={demo.provenance} />
            {demo.reason ? ` ${demo.reason}` : ""}
          </p>
          {ageTable ? (
            <>
              <table className="table mt-2 max-w-[480px]">
                <caption className="sr-only">
                  Over or under index per age group{ageOver}{ageVs === null ? "" : vsTag ? ` and ${against}` : " and the room's usual acts"}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Age</th>
                    <th scope="col" className="num">
                      This bill
                    </th>
                    {ageVsCol === null ? null : (
                      <th scope="col" className="num">
                        {ageVsCol}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {AGE_BUCKETS.map((b) => {
                    const bill = avgAge(demo.results.bill, b);
                    const house = avgAge(demo.results.house, b);
                    return (
                      <tr key={b}>
                        <th scope="row" className="font-normal text-ink">
                          {AGE_LABEL[b]}
                        </th>
                        <td className="num">{bill === null ? "–" : formatSigned(bill)}</td>
                        {ageVsCol === null ? null : <td className="num">{house === null ? "–" : formatSigned(house)}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="hint mt-2">Above 0 means the age group is more common in this crowd than in Qloo&apos;s audience overall. Use it for creative and timing only.</p>
            </>
          ) : null}
        </div>
      </details>
    </section>
  );
}
