import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { Partner } from "@walkup/contracts";
import { LESS_SURE_NOTE, LIFT_KEY } from "@walkup/exports/format";
import { buildSheetModel, podcastsOmittedText, spotColumnWidths, type PartnerRow, type SheetModel, type SpotRow } from "@walkup/exports/sheet-model";
import { PrintButton } from "@/components/sheet/PrintButton";
import { StaticLiftMap } from "@/components/StaticLiftMap";
import { telHref } from "@/lib/format";
import { liftColor } from "@/lib/lift";
import { runtimeMode } from "@/lib/mode";
import { presetForPlan } from "@/lib/presets";
import { SESSION_COOKIE } from "@/lib/server/http";
import { loadPlan } from "@/lib/server/service";
import { vettedSheet } from "@/lib/vetted";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const v = await loadPlan(id, { view: "api" });
  if (v?.kind !== "sheet") return { title: "Sheet not found" };
  // The checked sheet, the same one the page body prints; its summary is the plan page's description too.
  const s = vettedSheet(v.sheet).sheet;
  const m = buildSheetModel(s);
  const summary = s.narration?.summary?.trim();
  return {
    // A revision's title names the change, in the plan page's words (`sheetTitle`), so it differs from its parent's.
    title: `${m.headliner} at ${s.bill.venue.name}: street sheet${s.revision?.instruction?.trim() ? `, revised: “${s.revision.instruction.trim()}”` : ""}${s.mode === "fixture" ? " (sample)" : ""}`,
    // Not "one-page": this view prints on two pages for most sheets; the downloaded PDF is the one-page version.
    description: summary ? summary : `Street sheet for ${m.headliner} at ${s.bill.venue.name}, ${m.dateLine}.`,
  };
}

/**
 * Receipts as one footnote group after a claim. The model gives them as one compact string ("Q2-Q3, Q7 +2");
 * each group links to its first request on the plan page, which opens that receipt.
 */
function Refs({ refs, planId }: { refs: string; planId: string }) {
  const text = refs.trim();
  if (!text) return null;
  const parts = text.split(/,\s*|\s+(?=\+\d)/).filter(Boolean);
  return (
    <sup className="fn fn-flat">
      {parts.map((part, i) => {
        const first = /^[A-Za-z]+\d+/.exec(part)?.[0];
        return (
          <span key={`${part}-${i}`}>
            {i > 0 ? (part.startsWith("+") ? " " : ", ") : null}
            {first ? (
              <a href={`/plan/${planId}#receipt-${first}`} aria-label={`receipt ${part}`}>
                {part}
              </a>
            ) : (
              part
            )}
          </span>
        );
      })}
    </sup>
  );
}

function SheetSection({
  id,
  title,
  status,
  children,
  className = "",
  keepTogether = true,
}: {
  id: string;
  title: string;
  status?: string | null;
  children: React.ReactNode;
  className?: string;
  /** Keep the section on one printed page (off for the long partner table, which may run on). */
  keepTogether?: boolean;
}) {
  return (
    <section className={`${keepTogether ? "print-avoid-break" : ""} min-w-0 ${className}`} aria-labelledby={`sec-${id}`}>
      <h2 id={`sec-${id}`} className="mb-1.5 border-b border-ink pb-1 text-[1.15em] leading-snug font-semibold">
        {title}
      </h2>
      {status ? <p className="mb-1.5 text-[0.92em] text-muted">{status}</p> : null}
      {children}
    </section>
  );
}

function PartnerName({ row, partner }: { row: PartnerRow; partner: Partner | undefined }) {
  const name = (
    <span className="font-semibold">
      {row.name}
      {row.lessSure ? (
        <>
          <span aria-hidden="true">†</span>
          <span className="sr-only"> (less certain)</span>
        </>
      ) : null}
    </span>
  );
  return row.webUrl ? (
    <a href={row.webUrl} className="hover:underline" title={partner?.website ?? row.webUrl}>
      {name}
    </a>
  ) : (
    name
  );
}

/**
 * The phone as a call link, printed the way the PDF prints it ("(202) 733-4604"); the link dials the raw number.
 * The caller says "Phone not listed" on paper when there is none.
 */
function Phone({ row }: { row: PartnerRow }) {
  return (
    <a href={telHref(row.phone)} className="tabular hover:underline">
      {row.phoneText}
    </a>
  );
}

/**
 * The partner table, as a form the street team writes on: a tick box, the row number, the place (name and type,
 * then address and phone), the area's map number, the visit day and its hours (as in partners.csv and the calendar), the why line with its
 * receipts, and a Notes column about a quarter of the width, blank except "No time left on the route: call to
 * arrange" (as on the PDF) when the street-team route had no time for the place. Rows with no listed hours are the ones to act
 * on (call first) and get the pale yellow row. Under 640px each row is a short block instead, so nothing scrolls
 * sideways.
 */
function PartnersTable({ m, partners, discoveryId }: { m: SheetModel; partners: Map<string, Partner>; discoveryId: string | null }) {
  const rows = m.panel2.rows;
  return (
    <>
      <ol className="space-y-2 sm:hidden print:hidden">
        {rows.map((r) => (
          <li key={r.entityId} className={`border-b border-rule pb-2 ${r.hoursMissing ? "bg-warn" : ""}`}>
            <p>
              <span className="tabular text-muted">{r.n}</span> <PartnerName row={r} partner={partners.get(r.entityId)} />
              <Refs refs={r.refs} planId={m.planId} />
              <span className="text-muted">
                {" "}
                {r.tileRank !== null ? `${r.tileRank} ` : ""}
                {r.tile}
              </span>
            </p>
            <p className="text-[0.92em] text-muted">{[r.category, `${m.panel2.hoursHeader}: ${r.hours}`].filter(Boolean).join(" · ")}</p>
            {r.address ? <p className="text-[0.92em] text-muted">{r.address}</p> : null}
            <p className="text-[0.92em] text-muted">{r.phone ? <Phone row={r} /> : r.phoneText}</p>
            <p className="text-[0.92em]">{r.why}</p>
          </li>
        ))}
      </ol>
      <table className="table w-full table-fixed border-collapse text-[0.94em] leading-[1.3] max-sm:hidden print:table [&_td]:py-[3px] [&_td]:pr-2 [&_td]:align-top [&_th]:py-[2px] [&_th]:pr-2 [&_th]:text-[1em] print:[&_td]:py-[1px]">
        <caption className="sr-only">Partners, one row each, with a box to tick and a column for notes.</caption>
        <colgroup>
          <col style={{ width: "3%" }} />
          <col style={{ width: "3%" }} />
          <col style={{ width: "27.5%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "24.5%" }} />
          <col style={{ width: "21%" }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Done</span>
            </th>
            <th scope="col">#</th>
            <th scope="col">Place, address and phone</th>
            <th scope="col">Area</th>
            <th scope="col">{m.panel2.hoursHeader}</th>
            <th scope="col">Why</th>
            <th scope="col">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            // A row never splits across a printed page (its phone stays with its name).
            <tr
              key={r.entityId}
              id={`p-${r.entityId}`}
              className={`h-[7mm] print:h-[5.6mm] print:break-inside-avoid ${discoveryId !== null && r.entityId === discoveryId ? "bg-subtle" : r.hoursMissing ? "bg-warn" : ""}`}
            >
              <td>
                <span aria-hidden="true" className="inline-block size-[0.85em] translate-y-[1px] border border-ink" />
              </td>
              <td className="tabular text-muted">{r.n}</td>
              {/* Nothing in a row is cut: long names, addresses and why lines wrap, on screen and on paper. */}
              <td className="wrap-break-word">
                <span className="block">
                  <PartnerName row={r} partner={partners.get(r.entityId)} />
                  {r.category ? <span className="text-muted"> · {r.category}</span> : null}
                </span>
                {/* The address on its own line, then the phone on a line of its own, or "Phone not listed". */}
                {r.address ? <span className="block text-muted">{r.address}</span> : null}
                <span className="block whitespace-nowrap text-muted">{r.phone ? <Phone row={r} /> : r.phoneText}</span>
              </td>
              <td className="wrap-break-word">
                {r.tileRank !== null ? <span className="tabular font-semibold">{r.tileRank} </span> : null}
                {r.tile}
              </td>
              <td>{r.dayHours}</td>
              <td>
                {r.why}
                <Refs refs={r.refs} planId={m.planId} />
              </td>
              {/* Blank for the street team, except a day the route had no time for: in Notes, as on the PDF. */}
              <td>{r.routeNote ? `${r.routeNote.charAt(0).toUpperCase()}${r.routeNote.slice(1)}` : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * Before and after the show: a short table (spot, type, distance, share, rank against the usual crowd), blocks under
 * 640px. No Share column when every spot gets the same share, no "Vs usual crowd" column without a usual-crowd list.
 */
function SpotsTable({ rows, planId, showShare, showVsUsual }: { rows: SpotRow[]; planId: string; showShare: boolean; showVsUsual: boolean }) {
  const w = spotColumnWidths(showShare, showVsUsual);
  return (
    <>
      <ol className="space-y-1.5 sm:hidden print:hidden">
        {rows.map((r) => (
          <li key={r.name}>
            <strong className="font-semibold">{r.name}</strong>
            <Refs refs={r.refs} planId={planId} />
            <span className="block text-[0.92em] text-muted">{r.detail}</span>
          </li>
        ))}
      </ol>
      <table className="table w-full table-fixed text-[0.94em] leading-[1.3] max-sm:hidden print:table [&_td]:py-[2px] [&_td]:pr-2 [&_th]:py-[2px] [&_th]:pr-2 [&_th]:text-[1em]">
        <caption className="sr-only">Spots for before and after the show, nearest first, national chains last{showShare ? ", with their share of the crowd" : ""}.</caption>
        {/* The same widths as the PDF (`spotColumnWidths`). Cells wrap rather than cut, so "not for fans" and the rank
            change print in full in the narrower paper column. */}
        <colgroup>
          <col style={{ width: w.spot }} />
          <col style={{ width: w.type }} />
          <col style={{ width: w.distance }} />
          {w.share ? <col style={{ width: w.share }} /> : null}
          {w.vsUsual ? <col style={{ width: w.vsUsual }} /> : null}
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Spot</th>
            <th scope="col">Type</th>
            <th scope="col" className="num">
              Distance
            </th>
            {showShare ? (
              <th scope="col" className="num">
                Share
              </th>
            ) : null}
            {showVsUsual ? <th scope="col">Vs usual crowd</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="wrap-break-word">
                <strong className="font-semibold">{r.name}</strong>
                <Refs refs={r.refs} planId={planId} />
              </td>
              <td className="wrap-break-word">{r.category}</td>
              <td className="num tabular">{r.distance}</td>
              {showShare ? <td className="num tabular">{r.share}</td> : null}
              {showVsUsual ? <td className="wrap-break-word text-muted">{r.vsUsual}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * The map key in one line: the four steps the maps use, then the venue square, under the caption that names the baseline.
 * A map with no lift (no areas, or nothing to compare with) has only the venue on it, so the key has only the venue.
 */
function MapKey({ caption, noLift }: { caption: string; noLift: boolean }) {
  const steps: [string, number][] = noLift ? [] : LIFT_KEY.map((k) => [k.label, k.sample]);
  return (
    <div className="mt-1 text-[0.9em] text-muted">
      <p>{caption}</p>
      <ul className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5" aria-label="Map key">
        {steps.map(([label, lift]) => (
          <li key={label} className="flex items-center gap-1">
            <span aria-hidden="true" className="inline-block h-[0.7em] w-[1em] border border-control" style={{ background: liftColor(lift) }} />
            {label}
          </li>
        ))}
        <li className="flex items-center gap-1">
          <span aria-hidden="true" className="inline-block size-[0.7em] bg-ink" />
          venue
        </li>
      </ul>
    </div>
  );
}

export default async function SheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const v = await loadPlan(id, { view: "api", sessionId });
  if (!v) notFound();
  if (v.kind !== "sheet") {
    return (
      <div className="wrap py-16">
        <h1>Nothing to print yet</h1>
        <p className="mt-2 text-muted">This plan is still running, or it is waiting for you to pick an act. The sheet appears here when the plan is done.</p>
        <Link href={`/plan/${id}`} className="btn btn-primary mt-6">
          Open the plan
        </Link>
      </div>
    );
  }
  // The narration and copy lines as checked at view time, the same as the plan page and the PDF.
  const s = vettedSheet(v.sheet).sheet;
  const preset = presetForPlan(v.presetId ?? id, s.mode, s.bill);
  // Days to the show count from today, as on the plan page.
  const m = buildSheetModel(s, { ...(preset?.showName ? { showName: preset.showName } : {}), recorded: runtimeMode().kind === "recorded", asOf: new Date().toISOString() });
  const partners = new Map(s.cards.partners.results.map((p) => [p.entity.entityId, p]));
  const d = m.discovery;
  const discoveryId = d?.entityId && partners.has(d.entityId) ? d.entityId : null;
  const p1 = m.panel1;
  // No lift map on this run (nothing to compare with, or no areas): the drawing has only the venue, and so has its key.
  const noLift = p1.allTiles.length === 0 || s.cards.liftMap.results.diagnostics.baseline === "none";

  return (
    <div className="py-6 sm:py-8 print:p-0">
      <div className="no-print wrap-wide mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link href={`/plan/${s.planId}`} className="link">
          Back to the plan
        </Link>
        {/* The downloaded PDF fits one page (it may list fewer partners); this view prints on two pages for most sheets. */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="hint hidden sm:inline">The PDF is one page. Printing this view can take two.</span>
          <span>
            Download PDF:{" "}
            <a href={`/api/sheet/${s.planId}/pdf`} download className="link">
              US Letter
            </a>
            {" · "}
            <a href={`/api/sheet/${s.planId}/pdf?size=a4`} download className="link">
              A4
            </a>
          </span>
          <PrintButton />
        </div>
      </div>

      <div className="px-4 sm:px-6 print:px-0">
        <article
          className="paper print-sheet relative mx-auto w-full max-w-[210mm] overflow-hidden border border-rule px-4 py-5 text-[14px] leading-[1.45] sm:px-[9mm] sm:py-[8mm] sm:text-[12px] print:border-0 print:text-[6.3pt] print:leading-[1.25]"
          aria-label="Street sheet"
        >
          {m.watermarks[0] ? (
            <div className="sheet-watermark" aria-hidden="true">
              <span>{m.watermarks[0]}</span>
            </div>
          ) : null}

          {/* Day-sheet header: who on the left; date, room, days to go and seats on the right. */}
          <header className="relative flex flex-col gap-x-6 gap-y-2 border-b border-ink pb-2 sm:flex-row sm:items-start sm:justify-between print:flex-row print:items-start print:justify-between">
            <div className="min-w-0 sm:flex-1 print:flex-1">
              <p className="text-muted">
                Walkup street sheet
                {m.sampleLabel ? (
                  <>
                    {" · "}
                    <strong className="font-semibold text-ink">{m.sampleLabel}</strong>
                  </>
                ) : null}
              </p>
              <h1 className="mt-0.5 text-[1.75em] leading-[1.15] font-normal">
                <span className="font-semibold">{m.headliner}</span>
                {m.support ? <> {m.support}</> : null}
              </h1>
              <p className="mt-0.5 text-muted">{m.subline}</p>
            </div>
            <div className="sm:max-w-[40%] sm:text-right print:max-w-[40%] print:text-right">
              <p className="tabular text-[1.2em] leading-tight font-semibold">{m.dateLine}</p>
              <p>{m.placeLine}</p>
              {m.tMinus ? <p className="tabular font-semibold">{m.tMinus}</p> : null}
              {m.seatsLine ? <p className="tabular text-muted">{m.seatsLine}</p> : null}
              {m.labels
                .filter((l) => l !== m.sampleLabel)
                .map((l) => (
                  <p key={l} className="font-semibold">
                    {l}
                  </p>
                ))}
            </div>
          </header>
          {m.notes.map((n) => (
            <p key={n} className={`relative mt-1 ${/thin/i.test(n) ? "font-semibold" : "text-muted"}`}>
              {n}
            </p>
          ))}
          {d ? (
            <p className="relative mt-2 border-b border-rule pb-2">
              <strong className="font-semibold">{d.label}:</strong> {discoveryId ? <a href={`#p-${discoveryId}`} className="hover:underline">{d.text}</a> : d.text}
              <Refs refs={d.refs} planId={m.planId} />
              {d.kind === "none" ? (
                <>
                  {" "}
                  {/* The full stop is inside the link: paper, where the link is left off, ends at the reason. */}
                  <a href="/system-card#pick" className="link no-print">
                    How the top pick is chosen.
                  </a>
                </>
              ) : null}
              {/* A less certain pick keeps the table's dagger; its note is said once, under the table, as in the PDF. */}
              {d.rule ? <span className="block text-[0.92em] text-muted">{d.rule}</span> : null}
            </p>
          ) : null}

          {/* Where to flyer, beside before and after the show */}
          <div className="relative mt-3 grid gap-x-6 gap-y-4 print:mt-2 print:grid-cols-[1.35fr_1fr]">
            <SheetSection id="map" title={p1.title} status={p1.status}>
              {/* Map and areas side by side (stacked under 640px), as in the PDF. */}
              <div className="grid gap-3 sm:grid-cols-[1.1fr_1fr] print:grid-cols-[1.1fr_1fr]">
                <div>
                  <StaticLiftMap
                    tiles={p1.allTiles}
                    venue={p1.venue}
                    ranked={p1.topTiles.map((t) => t.geohash)}
                    theme="paper"
                    width={420}
                    height={280}
                    idBase={`sheet-${s.planId}`}
                    title={noLift ? `The area around ${p1.venue.name}` : `Areas where this crowd stands out, around ${p1.venue.name}`}
                    className="h-auto w-full border border-rule"
                    noLift={noLift}
                  />
                  <MapKey caption={p1.legendCaption} noLift={noLift} />
                </div>
                {p1.tiles.length > 0 ? (
                  <ol className="space-y-1.5 print:space-y-1">
                    {p1.tiles.map((t) => (
                      <li key={t.geohash} className="flex gap-2">
                        <span className="marker mt-[1px] size-[1.45em] text-[0.85em]" aria-hidden="true">
                          {t.rank}
                        </span>
                        <span className="min-w-0">
                          <span className="block">
                            <span className="sr-only">{t.rank}. </span>
                            <strong className="font-semibold">{t.name}</strong> <span className="tabular">{t.lift}</span>
                          </span>
                          {/* The paper's blurb: the ZIPs, then whole sentences of the why line (the PDF prints the same). */}
                          <span className="block text-[0.92em] text-muted">{t.blurb}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-muted">{p1.empty}</p>
                )}
              </div>
              {p1.baseline ? <p className="mt-1.5 text-[0.92em] text-muted">{p1.baseline}</p> : null}
            </SheetSection>

            {/* Before and after the show, with the budget split under it (the right column has room there, as in the PDF). */}
            <div className="min-w-0">
              <SheetSection id="prepost" title={m.panel4.title} status={m.panel4.status}>
                {m.panel4.rows.length === 0 ? <p className="text-muted">{m.panel4.empty}</p> : <SpotsTable rows={m.panel4.rows} planId={m.planId} showShare={m.panel4.showShare} showVsUsual={m.panel4.showVsUsual} />}
                {m.panel4.shareNote ? <p className="mt-1.5 text-[0.92em] text-muted">{m.panel4.shareNote}</p> : null}
                <p className="text-[0.92em] text-muted">{m.panel4.ageLine}</p>
              </SheetSection>
              <SheetSection id="budget" title={m.footer.budgetTitle} className="mt-3 print:mt-2">
                {m.footer.budget.length > 0 ? (
                  <ul>
                    {m.footer.budget.map((b, i) => (
                      <li key={`${b.name}-${i}`} className="flex justify-between gap-2">
                        <span className="min-w-0">
                          {b.rank !== null ? <span className="tabular font-semibold">{b.rank} </span> : null}
                          {b.name}
                        </span>
                        <span className="tabular shrink-0">
                          {b.share}
                          {b.usd ? ` · ${b.usd}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted">{m.footer.budgetEmpty}</p>
                )}
              </SheetSection>
            </div>
          </div>

          {/* Partners, as a form */}
          <div className="relative mt-4 print:mt-2.5">
            <SheetSection id="partners" title={m.panel2.title} status={m.panel2.status} keepTogether={false}>
              {m.panel2.rows.length > 0 ? (
                <PartnersTable m={m} partners={partners} discoveryId={discoveryId} />
              ) : (
                <p className="text-muted">No partners came back for this sheet. Try another street-team day in Change something on the plan page.</p>
              )}
              {m.panel2.omitted > 0 ? <p className="mt-1 text-muted">+{m.panel2.omitted} more {m.panel2.omitted === 1 ? "partner" : "partners"} in partners.csv.</p> : null}
              {m.panel2.rows.some((r) => r.lessSure) || d?.lessSureNote ? <p className="mt-1 text-[0.92em] text-muted">{LESS_SURE_NOTE}</p> : null}
              <p className="mt-1.5">
                {/* On paper the numbers open nothing, so the paper says what they are. */}
                <span className="font-semibold">{m.panel2.footer}</span>{" "}
                <span className="text-[0.92em] text-muted">
                  The small Q numbers after each line <span className="print:hidden">open</span>
                  <span className="hidden print:inline">point to</span> the request behind it.
                </span>
              </p>
            </SheetSection>
          </div>

          {/* Podcasts and a sponsor beside copy lines, under the partner table: on paper too, as in the PDF. */}
          <div className="relative mt-4 grid gap-x-6 gap-y-4 border-t border-ink pt-2 sm:grid-cols-[42fr_58fr] print:mt-2.5 print:grid-cols-[42fr_58fr] [&_h2]:border-b-0 [&_h2]:pb-0">
            <SheetSection id="media" title={m.panel5.title} status={m.panel5.status}>
              <ul className="space-y-0.5">
                {m.panel5.podcasts.map((r) => (
                  <li key={r.name}>
                    {r.name}
                    <Refs refs={r.refs} planId={m.planId} /> <span className="text-muted">· podcast, {r.scope}</span>
                  </li>
                ))}
                {m.panel5.podcasts.length === 0 ? <li className="text-muted">No podcasts came back for this bill.</li> : null}
                {m.panel5.podcastsOmitted > 0 ? <li className="text-muted">{podcastsOmittedText(m.panel5.podcastsOmitted)}</li> : null}
                {m.panel5.sponsor ? (
                  <li className="pt-1">
                    <strong className="font-semibold">{m.panel5.sponsor.name}</strong>
                    <Refs refs={m.panel5.sponsor.refs} planId={m.planId} /> <span className="text-muted">· sponsor, {m.panel5.sponsor.scope}</span>
                  </li>
                ) : null}
                {m.panel5.sponsorNote ? <li className="pt-1 text-muted">{m.panel5.sponsorNote}</li> : null}
              </ul>
            </SheetSection>
            <SheetSection id="hooks" title={m.panel6.title} status={m.panel6.status}>
              <ul className="space-y-1">
                {m.panel6.hooks.map((h) => (
                  <li key={h}>“{h}”</li>
                ))}
                {m.panel6.hooks.length === 0 ? <li className="text-muted">No copy lines on this sheet.</li> : null}
              </ul>
              {m.panel6.withheld > 0 ? (
                <p className="mt-1 text-[0.92em] text-muted">
                  {m.panel6.withheld} {m.panel6.withheld === 1 ? "line" : "lines"} left out: alcohol words on a show that is not 21+.
                </p>
              ) : null}
              <p className="mt-1 text-[0.92em] text-muted">{m.panel6.note}</p>
            </SheetSection>
          </div>

          {/* Foot: your list to call, what the sheet doesn't show, the requests behind it */}
          <footer className="print-avoid-break relative mt-4 grid gap-x-6 gap-y-3 border-t border-ink pt-2 text-[0.94em] sm:grid-cols-[1fr_1.4fr_1.1fr] print:mt-2.5 print:grid-cols-[0.9fr_1.4fr_1.1fr] print:gap-x-4">
            <div>
              <h2 className="text-[1em] font-semibold">
                {m.panel3.title}
                {m.panel3.rows.length > 0 ? <span className="font-normal text-muted"> in call order</span> : null}
              </h2>
              {m.panel3.rows.length === 0 ? (
                <p className="mt-0.5 text-muted">{m.panel3.empty}</p>
              ) : (
                <ol className="mt-0.5">
                  {m.panel3.rows.map((r, i) => (
                    <li key={`${r.label}-${i}`} className="flex gap-2">
                      <span className="tabular w-5 shrink-0 font-semibold">{r.rank}</span>
                      <span className="min-w-0">
                        {r.label}
                        <Refs refs={r.refs} planId={m.planId} />
                        {r.note ? <span className="text-muted"> · {r.note}</span> : null}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {m.panel3.omitted > 0 ? <p className="mt-0.5 text-muted">+{m.panel3.omitted} more in partners.csv.</p> : null}
            </div>
            <div>
              <h2 className="text-[1em] font-semibold">{m.footer.limitsTitle}</h2>
              <ul className="mt-0.5 list-disc pl-4 text-muted">
                {m.footer.limits.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="text-[1em] font-semibold">{m.footer.receiptsTitle}</h2>
              <p className="mt-0.5 break-words text-muted">{m.footer.ledgerLine}</p>
              <p className="no-print mt-0.5">
                <a href={`/plan/${s.planId}#ledger`} className="link">
                  Open the requests on the plan page
                </a>
              </p>
              <p className="mt-1 hidden text-muted print:block">{m.footer.elsewhere}</p>
              <p className="mt-1 text-muted">{m.footer.attribution}</p>
            </div>
          </footer>
          <p className="relative mt-2 border-t border-rule pt-1 text-[0.85em] text-muted print:text-[6pt]">{m.footer.printLine}</p>
        </article>
      </div>
    </div>
  );
}
