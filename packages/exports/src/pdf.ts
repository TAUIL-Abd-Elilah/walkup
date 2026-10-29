/**
 * The one-page Street Sheet PDF (@react-pdf/renderer, built-in Helvetica, no
 * font files). The tree is built with React.createElement from react-pdf
 * primitives only (no components, no hooks), so tests can walk it directly.
 *
 * Look: a crew day sheet. Black text on white, thin rules, one accent ink (the
 * map tiles), weights regular and bold only. Order: the day-sheet header (who
 * and where on the left; date, room, days to go and seats on the right), where
 * to flyer beside before-and-after spots, the partner table as a form to write
 * on (tick box, place, area, hours, why, a blank Notes column, rows about 7 mm
 * tall), podcasts and a sponsor beside copy lines, the operator's list, what
 * the sheet doesn't show, and one footer line with the print and data dates;
 * the budget split sits under the before-and-after table. The sections are the model's `sections`, the same as
 * the print view's. A sample (fixture) sheet says "Sample data" in its header
 * and footer and carries one light watermark; a live sheet has none.
 *
 * Fitting: the sheet is rendered at full size first; if it runs past one page
 * it is re-rendered at smaller type (the form rows shrink with it), and as a
 * last resort with shorter lists (the full lists stay in partners.csv and
 * sheet.json, and the sheet says how many rows are left out).
 */
import React from "react";
import { Circle, Document, Line, Link, Page, Rect, renderToBuffer, Svg, Text, View } from "@react-pdf/renderer";
import type { Style } from "@react-pdf/types";
import type { StreetSheet } from "@walkup/contracts";
import { DECLARED_UNRANKED, LESS_SURE_NOTE, LIFT_KEY } from "./format";
import { LABEL_RADIUS, layoutTileMap, liftFill, MAP_COLORS, MIN_VISIBLE_CELL, niceKm, VENUE_LABEL_SIZE } from "./map";
import { buildSheetModel, spotColumnWidths, type PartnerRow, type SheetModel, type SheetModelOptions, type SheetSection, type SpotRow } from "./sheet-model";
import { pdfText } from "./winansi";

export type PdfPageSize = "LETTER" | "A4";

export interface PdfOptions extends SheetModelOptions {
  /** US Letter (default) or A4, portrait. */
  pageSize?: PdfPageSize;
  /** Shrink type (then lists) until the sheet fits one page. Default true. */
  fit?: boolean;
  /** Type scale when `fit` is false. Default 1. */
  scale?: number;
}

export interface PdfRenderResult {
  buffer: Buffer;
  pages: number;
  scale: number;
  /** True when lists were shortened to fit (the omitted rows are counted on the sheet). */
  truncated: boolean;
}

export const PAGE_SIZES: Readonly<Record<PdfPageSize, { width: number; height: number }>> = {
  LETTER: { width: 612, height: 792 },
  A4: { width: 595.28, height: 841.89 },
};

const INK = "#111111";
const MUTED = "#555555";
const RULE = "#e3e3e3";
/** The pale yellow row for something the street team must act on (no hours listed: call first). */
const WARN = "#fff8db";
const BOLD = "Helvetica-Bold";
/** 7 mm in points: the height of a form row at full size, enough to write in. */
export const FORM_ROW_PT = 19.85;

const h = React.createElement;
type El = React.ReactElement;
type Kid = El | string | null;

const noHyphen = (word: string): string[] => [word];

/** Text node; every string child is made drawable by the standard fonts. */
function text(style: Style | Style[] | undefined, ...kids: Kid[]): El {
  const clean = kids.filter((k): k is El | string => k !== null).map((k) => (typeof k === "string" ? pdfText(k) : k));
  return h(Text, { style, hyphenationCallback: noHyphen }, ...clean);
}

function view(style: Style | Style[] | undefined, ...kids: (El | null)[]): El {
  return h(View, { style }, ...kids.filter((k): k is El => k !== null));
}

function lines(style: Style, n: number): Style {
  return { ...style, maxLines: n, textOverflow: "ellipsis" };
}

function oneLine(style: Style): Style {
  return lines(style, 1);
}

function makeStyles(s: number) {
  const fs = (n: number) => n * s;
  return {
    base: { fontSize: fs(7.4), lineHeight: 1.25 } satisfies Style,
    small: { fontSize: fs(6.5), color: MUTED, lineHeight: 1.22 } satisfies Style,
    kicker: { fontSize: fs(7.4), color: MUTED } satisfies Style,
    sample: { fontFamily: BOLD, fontSize: fs(7.4), color: INK } satisfies Style,
    title: { fontSize: fs(14), lineHeight: 1.15, marginTop: fs(2) } satisfies Style,
    sub: { fontSize: fs(7.4), color: MUTED, marginTop: fs(1.5) } satisfies Style,
    day: { fontFamily: BOLD, fontSize: fs(9.5), textAlign: "right" } satisfies Style,
    right: { fontSize: fs(7.8), textAlign: "right", marginTop: fs(1) } satisfies Style,
    label: { fontSize: fs(7), textAlign: "right", marginTop: fs(1.5) } satisfies Style,
    sectionHead: {
      borderBottomWidth: 0.6,
      borderBottomColor: INK,
      borderBottomStyle: "solid",
      paddingBottom: fs(1.5),
      marginBottom: fs(2.5),
    } satisfies Style,
    sectionTitle: { fontFamily: BOLD, fontSize: fs(8.4) } satisfies Style,
    status: { fontSize: fs(6.4), color: MUTED, marginTop: fs(-1), marginBottom: fs(2) } satisfies Style,
    bold: { fontFamily: BOLD } satisfies Style,
    muted: { color: MUTED } satisfies Style,
    // Receipts are quiet on paper: muted, small, no brackets (the accent is kept for the map).
    ref: { color: MUTED, fontSize: fs(5.8) } satisfies Style,
    hook: { fontSize: fs(7.8), marginBottom: fs(1.5) } satisfies Style,
    cell: { fontSize: fs(6.6), lineHeight: 1.18 } satisfies Style,
    th: { fontFamily: BOLD, fontSize: fs(6.3), color: MUTED } satisfies Style,
    gap: (n: number): Style => ({ marginTop: fs(n) }),
    fs,
  };
}

type Styles = ReturnType<typeof makeStyles>;

function section(st: Styles, title: string, status: string | null, ...body: (El | null)[]): El {
  return view(
    undefined,
    view(st.sectionHead, text(st.sectionTitle, title)),
    // Three lines: a fallback reason (no usual crowd, a widened search) is said whole, not cut mid-sentence.
    status ? text([st.status, { maxLines: 3, textOverflow: "ellipsis" }], status) : null,
    ...body,
  );
}

/**
 * The day-sheet header: "Walkup street sheet" and the bill (headliner bold, the rest after "with") on the left;
 * the date, the room, the days to go and the seats on the right; one rule under it.
 */
function header(m: SheetModel, st: Styles): El {
  return view(
    { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: INK, borderBottomStyle: "solid", paddingBottom: st.fs(5) },
    view(
      { width: "66%", paddingRight: st.fs(10) },
      text(st.kicker, m.kicker, m.sampleLabel ? text(st.muted, "  ·  ") : null, m.sampleLabel ? text(st.sample, m.sampleLabel) : null),
      text(st.title, text(st.bold, m.headliner), m.support ? ` ${m.support}` : null),
      text(st.sub, m.subline),
    ),
    view(
      { width: "34%", alignItems: "flex-end" },
      text(st.day, m.dateLine),
      text(st.right, m.placeLine),
      m.tMinus ? text([st.right, st.bold], m.tMinus) : null,
      m.seatsLine ? text([st.right, st.muted], m.seatsLine) : null,
      ...m.labels.filter((l) => l !== m.sampleLabel).map((l) => text([st.label, st.bold], l)),
    ),
  );
}

/**
 * The top pick in one line, its rule under it. A less certain pick keeps the partner table's dagger; the note that
 * explains the dagger is printed once, under the table (`panel2`), so it costs the one-page fit no line here.
 */
function discoveryLine(m: SheetModel, st: Styles): El | null {
  const d = m.discovery;
  if (!d) return null;
  return view(
    { marginTop: st.fs(4), paddingBottom: st.fs(3), borderBottomWidth: 0.5, borderBottomColor: RULE, borderBottomStyle: "solid" },
    text(lines(st.base, 2), text(st.bold, `${d.label}: `), d.text, d.refs ? text(st.ref, ` ${d.refs}`) : null),
    d.rule ? text(oneLine(st.small), d.rule) : null,
  );
}

function tileMap(m: SheetModel, width: number, height: number): El {
  // The venue's name is laid out with the markers, so no marker covers it.
  const layout = layoutTileMap(m.panel1.allTiles, m.panel1.topTiles, m.panel1.venue, { width, height, venueLabel: pdfText(m.panel1.venue.name) });
  const kids: El[] = [h(Rect, { x: 0, y: 0, width, height, fill: "#ffffff" })];
  // A light kilometre grid in place of a basemap, centred on the frame.
  if (layout.unitsPerKm > 0) {
    const step = niceKm(Math.max(width, height) / layout.unitsPerKm / 6) * layout.unitsPerKm;
    for (let k = -30; k <= 30; k++) {
      const x = width / 2 + k * step;
      const y = height / 2 + k * step;
      if (x > 0 && x < width) kids.push(h(Line, { x1: x, y1: 0, x2: x, y2: height, stroke: MAP_COLORS.grid, strokeWidth: 0.5 }));
      if (y > 0 && y < height) kids.push(h(Line, { x1: 0, y1: y, x2: width, y2: y, stroke: MAP_COLORS.grid, strokeWidth: 0.5 }));
    }
  }
  for (const r of layout.rects) {
    // A top tile too small to see at this scale is drawn at a minimum size around its centre, as on the web map.
    const min = r.rank !== null ? MIN_VISIBLE_CELL : 0.6;
    const w = Math.max(r.w, min);
    const hh = Math.max(r.h, min * 0.7);
    kids.push(h(Rect, { x: r.x + (r.w - w) / 2, y: r.y + (r.h - hh) / 2, width: w, height: hh, fill: r.fill, stroke: "#ffffff", strokeWidth: 0.4 }));
  }
  if (layout.venue) {
    const v = layout.venue;
    kids.push(h(Rect, { x: v.x - 2.6, y: v.y - 2.6, width: 5.2, height: 5.2, fill: MAP_COLORS.venue, stroke: "#ffffff", strokeWidth: 0.8 }));
  }
  // The venue's name under its square (above it near the bottom edge), kept inside the frame (`layout.venueLabel`).
  if (layout.venueLabel) {
    const l = layout.venueLabel;
    kids.push(h(Text, { x: l.x, y: l.y, textAnchor: "middle", fill: INK, style: { fontSize: VENUE_LABEL_SIZE } }, l.text));
  }
  // Numbered markers beside their tiles (filled ink, white numbers), as on the web maps.
  for (const l of layout.labels) {
    kids.push(h(Line, { x1: l.anchorX, y1: l.anchorY, x2: l.x, y2: l.y, stroke: MAP_COLORS.muted, strokeWidth: 0.4 }));
    // Two areas too close to tell apart share one marker ("3, 4"), drawn as a rounded box.
    if (l.text.length > 2) {
      const w = l.text.length * 3.1 + 4;
      kids.push(h(Rect, { x: l.x - w / 2, y: l.y - LABEL_RADIUS, width: w, height: LABEL_RADIUS * 2, rx: LABEL_RADIUS, fill: INK, stroke: "#ffffff", strokeWidth: 0.6 }));
    } else {
      kids.push(h(Circle, { cx: l.x, cy: l.y, r: LABEL_RADIUS, fill: INK, stroke: "#ffffff", strokeWidth: 0.6 }));
    }
    kids.push(h(Text, { x: l.x, y: l.y + 2.1, textAnchor: "middle", fill: "#ffffff", style: { fontSize: 5.8, fontFamily: BOLD } }, l.text));
  }
  // Scale bar, bottom left; bottom right when the venue and its name sit there.
  if (layout.unitsPerKm > 0) {
    const km = niceKm(width / layout.unitsPerKm / 5);
    const len = km * layout.unitsPerKm;
    const barW = len + 22;
    const v = layout.venue;
    const venueBottomLeft = v !== null && v.x < barW + 30 && v.y > height - 24;
    const x0 = venueBottomLeft ? width - barW - 3 : 5;
    kids.push(h(Rect, { x: x0, y: height - 7, width: len, height: 1.4, fill: MAP_COLORS.muted }));
    kids.push(h(Text, { x: x0 + len + 3, y: height - 4.6, fill: MAP_COLORS.muted, style: { fontSize: 5 } }, `${km} km`));
  }
  kids.push(h(Rect, { x: 0, y: 0, width, height, fill: "none", stroke: MAP_COLORS.frame, strokeWidth: 0.6 }));
  return h(Svg, { width, height, viewBox: `0 0 ${width} ${height}` }, ...kids);
}

/** The map key, one line under the map: the same four steps as the web legend, then the venue square. */
function legend(m: SheetModel, st: Styles): El {
  const swatch = (color: string, label: string) =>
    view(
      { flexDirection: "row", alignItems: "center", marginRight: st.fs(4) },
      view({ width: st.fs(6), height: st.fs(4.5), backgroundColor: color, borderWidth: 0.4, borderColor: "#858585", borderStyle: "solid", marginRight: st.fs(1.5) }),
      text(st.small, label),
    );
  return view(
    { marginTop: st.fs(2) },
    text(st.small, m.panel1.legendCaption),
    view(
      { flexDirection: "row", flexWrap: "wrap", marginTop: st.fs(1) },
      ...LIFT_KEY.map((k) => swatch(liftFill(k.sample), k.label)),
      view({ flexDirection: "row", alignItems: "center" }, view({ width: st.fs(4), height: st.fs(4), backgroundColor: INK, marginRight: st.fs(1.5) }), text(st.small, "venue")),
    ),
  );
}

/** Where to flyer: the static map (about 60 mm wide, numbered circles, scale bar, key under it) beside areas 1-5. */
function panel1(m: SheetModel, st: Styles, mapW: number, mapH: number, listW: number): El {
  const p = m.panel1;
  const list = p.tiles.map((t) =>
    view(
      { flexDirection: "row", marginBottom: st.fs(2.6) },
      view(
        { width: st.fs(9), height: st.fs(9), borderRadius: st.fs(4.5), backgroundColor: INK, alignItems: "center", justifyContent: "center", marginRight: st.fs(3), marginTop: st.fs(0.3) },
        text({ fontFamily: BOLD, fontSize: st.fs(5.6), color: "#ffffff" }, String(t.rank)),
      ),
      view(
        { width: listW - st.fs(12) },
        text(lines(st.base, 2), text(st.bold, t.name), ` ${t.lift}`),
        // Whole sentences only (the model cuts the blurb at a sentence end), so no line limit here.
        text(st.small, t.blurb),
      ),
    ),
  );
  return section(
    st,
    p.title,
    p.status,
    view(
      { flexDirection: "row" },
      view({ width: mapW, marginRight: st.fs(7) }, tileMap(m, mapW, mapH), legend(m, st)),
      // Explicit widths: react-pdf does not shrink flex children that hold text reliably.
      view({ width: listW }, ...list, p.empty ? text(st.small, p.empty) : null),
    ),
    text([lines(st.small, 3), st.gap(2)], p.baseline),
  );
}

interface Col {
  key: string;
  head: (m: SheetModel) => string;
  width: string;
  cell: (r: PartnerRow, st: Styles) => El;
}

/** "1 North Hills Estates": the area's map number in bold, then its name (two lines at most). */
function areaText(r: PartnerRow, st: Styles): El {
  return text(lines(st.cell, 2), r.tileRank !== null ? text(st.bold, `${r.tileRank} `) : null, r.tile);
}

/** The why line in paper width: "Ranks 8th here for this crowd, 20th for the room's usual crowd." -> "Ranks 8th; 20th for the usual crowd." */
export function shortWhy(why: string): string {
  return why.replace(/ here for this crowd/, "").replace(/, (\d+\w\w) for the room's usual crowd/, "; $1 for the usual crowd").replace(/, the same for the room's usual crowd/, "; the same for the usual crowd");
}

/**
 * The partner table, laid out as a form the street team writes on: a tick box, the row number, the place (name
 * and type, then the address and phone, or "Phone not listed"), the area's map number and name, the hours on the
 * street-team day, the why line with its receipts, and a blank Notes column about a quarter of the width. Rows are
 * about 7 mm tall at full size. Widths are explicit because react-pdf does not shrink text cells reliably.
 */
function partnerCols(_m: SheetModel, st: Styles): Col[] {
  const box: Col = {
    key: "box",
    head: () => "",
    width: "2.5%",
    cell: () => view({ width: st.fs(6), height: st.fs(6), borderWidth: 0.7, borderColor: INK, borderStyle: "solid", marginTop: st.fs(0.6) }),
  };
  const num: Col = { key: "n", head: () => "#", width: "3%", cell: (r) => text([oneLine(st.cell), st.muted], r.n) };
  const nameText = (r: PartnerRow) =>
    text(oneLine(st.cell), text(st.bold, r.name), r.lessSure ? text(st.bold, "†") : null, r.category ? text(st.muted, ` · ${r.category}`) : null);
  const place: Col = {
    key: "place",
    head: () => "Place, address and phone",
    width: "29%",
    cell: (r) =>
      view(
        undefined,
        // The name links to the place's website when it has one.
        r.webUrl ? h(Link, { src: r.webUrl, style: { color: INK, textDecoration: "none" } }, nameText(r)) : nameText(r),
        r.address ? text([oneLine(st.cell), st.muted], r.address) : null,
        // The phone has a line of its own and is never cut short.
        text([st.cell, st.muted], r.phoneText),
      ),
  };
  const area: Col = { key: "area", head: () => "Area", width: "12.5%", cell: (r) => areaText(r, st) };
  // Two lines for one visit day; a third when a holiday's move puts the passes on two weekdays (the place column is three).
  const hours: Col = { key: "hours", head: (mm) => mm.panel2.hoursHeader, width: "9%", cell: (r) => text(lines(st.cell, 3), r.hours) };
  const why: Col = {
    key: "why",
    head: () => "Why",
    width: "22%",
    // Two lines in nearly every row; a long line with its receipts may take a third (the row grows).
    cell: (r) => text(lines(st.cell, 3), r.why, r.refs ? text(st.ref, ` ${r.refs}`) : null),
  };
  const notes: Col = { key: "notes", head: () => "Notes", width: "22%", cell: () => view({ height: st.fs(6) }) };
  return [box, num, place, area, hours, why, notes];
}

function panel2(m: SheetModel, st: Styles, rowPt: number): El {
  const p = m.panel2;
  const dagger = p.rows.some((r) => r.lessSure) || !!m.discovery?.lessSureNote;
  const cols = partnerCols(m, st);
  const cellView = (c: Col, child: El): El => view({ width: c.width, paddingRight: c.key === "notes" ? 0 : st.fs(3) }, child);
  const rule: Style = { borderBottomWidth: 0.5, borderBottomColor: "#bdbdbd", borderBottomStyle: "solid" };
  const head = view({ flexDirection: "row", paddingVertical: st.fs(1), borderBottomWidth: 0.6, borderBottomColor: INK, borderBottomStyle: "solid" }, ...cols.map((c) => cellView(c, text(st.th, c.head(m)))));
  const rows = p.rows.map((r) =>
    view(
      { flexDirection: "row", minHeight: rowPt, paddingTop: st.fs(1.6), paddingBottom: st.fs(1), ...rule, ...(r.hoursMissing ? { backgroundColor: WARN } : {}) },
      ...cols.map((c) => cellView(c, c.cell(r, st))),
    ),
  );
  return section(
    st,
    p.title,
    p.status,
    head,
    ...rows,
    p.rows.length === 0 ? text([st.small, st.gap(1)], "No partners came back for this sheet.") : null,
    // The dagger's note is said once: for the rows, and for the top pick's headline even when its row is past the cap.
    // It shares the "+N more" line when there is one, so it costs the one-page fit no line of its own.
    p.omitted > 0 || dagger ? text([st.small, st.gap(1)], [p.omitted > 0 ? `+${p.omitted} more partners in partners.csv.` : "", dagger ? LESS_SURE_NOTE : ""].filter((x) => x !== "").join(" ")) : null,
    p.withheld > 0 ? text([st.small, st.gap(1)], `${p.withheld} bar${p.withheld === 1 ? "" : "s"} left out of this fan-facing version (show not 21+).`) : null,
    text([st.small, st.gap(2)], text([st.bold, { color: INK }], p.footer), ` ${p.refsNote}`),
  );
}

/** Your list, in call order: ranked entries first, then the ones not in Qloo's catalog, in the operator's order. */
function panel3(m: SheetModel, st: Styles): El {
  const p = m.panel3;
  const rows = p.rows.map((r) =>
    text(
      lines(st.small, 2),
      text([st.bold, { color: INK }], `${r.rank}  `),
      text({ color: INK }, r.label),
      r.scored ? null : ` · ${DECLARED_UNRANKED}`,
      r.refs ? text(st.ref, ` ${r.refs}`) : null,
    ),
  );
  return view(
    undefined,
    text([st.base, { marginBottom: st.fs(1) }], text(st.bold, p.title), p.rows.length > 0 ? text(st.muted, "  in call order") : null),
    ...rows,
    p.empty ? text(st.small, p.empty) : null,
    p.omitted > 0 ? text(st.small, `+${p.omitted} more in partners.csv.`) : null,
  );
}

type SpotCol = { head: string; width: string; cell: (r: SpotRow) => El };

/**
 * Before and after the show, as a small table: spot, type, distance (nearest first), share of the crowd (only when
 * the shares differ), and the usual crowd's rank (only when there is a usual-crowd list to compare with; the spot
 * column takes its width otherwise). The print view uses the same widths (`spotColumnWidths`).
 */
function panel4(m: SheetModel, st: Styles): El {
  const p = m.panel4;
  const w = spotColumnWidths(p.showShare, p.showVsUsual);
  const share: SpotCol[] = w.share ? [{ head: "Share", width: w.share, cell: (r) => text(oneLine(st.cell), r.share) }] : [];
  const vsUsual: SpotCol[] = w.vsUsual ? [{ head: "Vs usual crowd", width: w.vsUsual, cell: (r) => text([oneLine(st.cell), st.muted], r.vsUsual) }] : [];
  const cols: SpotCol[] = [
    { head: "Spot", width: w.spot, cell: (r) => text(lines(st.cell, 2), text(st.bold, r.name), r.refs ? text(st.ref, ` ${r.refs}`) : null) },
    { head: "Type", width: w.type, cell: (r) => text(lines(st.cell, 2), r.category) },
    { head: "Distance", width: w.distance, cell: (r) => text(oneLine(st.cell), r.distance) },
    ...share,
    ...vsUsual,
  ];
  const cell = (i: number, child: El): El => view({ width: cols[i]!.width, paddingRight: i === cols.length - 1 ? 0 : st.fs(3) }, child);
  const rowStyle: Style = { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: RULE, borderBottomStyle: "solid", paddingVertical: st.fs(1.2) };
  const head = view({ ...rowStyle, borderBottomColor: INK, borderBottomWidth: 0.6 }, ...cols.map((c, i) => cell(i, text(st.th, c.head))));
  const rows = p.rows.map((r) => view(rowStyle, ...cols.map((c, i) => cell(i, c.cell(r)))));
  return section(
    st,
    p.title,
    p.status,
    ...(p.rows.length > 0 ? [head, ...rows] : []),
    p.empty ? text(st.small, p.empty) : null,
    p.withheld > 0 ? text(st.small, `${p.withheld} operator-only spot${p.withheld === 1 ? "" : "s"} left out of this fan-facing version.`) : null,
    p.shareNote ? text([st.small, st.gap(1.5)], p.shareNote) : null,
    text([st.small, st.gap(0.5)], p.ageLine),
  );
}

/** The budget split by area number, under the before-and-after table (the right column has room there). */
function budgetPanel(m: SheetModel, st: Styles): El | null {
  if (!m.sections.includes("budget")) return null;
  const f = m.footer;
  return view(
    { marginTop: st.fs(6) },
    section(
      st,
      f.budgetTitle,
      null,
      ...f.budget.map((b) =>
        view(
          { flexDirection: "row", justifyContent: "space-between" },
          view({ width: "68%" }, text([oneLine(st.cell)], b.rank !== null ? text(st.bold, `${b.rank} `) : null, b.name)),
          view({ width: "32%" }, text([oneLine(st.cell), { textAlign: "right" }], [b.share, b.usd ?? ""].filter((x) => x !== "").join(" · "))),
        ),
      ),
      f.budgetEmpty ? text(st.small, f.budgetEmpty) : null,
    ),
  );
}

/**
 * Podcasts and a sponsor beside copy lines, under the partner table (each only when the model's `sections` has it,
 * as on the print view).
 */
function mediaRow(m: SheetModel, st: Styles): El | null {
  const has = (x: SheetSection) => m.sections.includes(x);
  if (!has("media") && !has("hooks")) return null;
  const head = (t: string) => text([st.base, st.bold, { marginBottom: st.fs(1) }], t);
  const p5 = m.panel5;
  const p6 = m.panel6;
  const media = view(
    { width: "42%", paddingRight: st.fs(10) },
    head(p5.title),
    p5.status ? text([st.small, { maxLines: 2, textOverflow: "ellipsis" }], p5.status) : null,
    ...p5.podcasts.map((r) => text(lines(st.small, 2), text({ color: INK }, r.name), ` · podcast, ${r.scope}`, r.refs ? text(st.ref, ` ${r.refs}`) : null)),
    p5.podcasts.length === 0 ? text(st.small, "No podcasts came back for this bill.") : null,
    p5.sponsor
      ? text([lines(st.small, 2), st.gap(1)], text([st.bold, { color: INK }], p5.sponsor.name), ` · sponsor, ${p5.sponsor.scope}`, p5.sponsor.refs ? text(st.ref, ` ${p5.sponsor.refs}`) : null)
      : null,
    p5.sponsorNote ? text([st.small, st.gap(1)], p5.sponsorNote) : null,
  );
  const hooks = view(
    { width: "58%" },
    head(p6.title),
    p6.status ? text([st.small, { maxLines: 2, textOverflow: "ellipsis" }], p6.status) : null,
    ...p6.hooks.map((x) => text([st.cell, { marginBottom: st.fs(1) }], `"${x}"`)),
    p6.hooks.length === 0 ? text(st.small, "No copy lines on this sheet.") : null,
    p6.withheld > 0 ? text(st.small, `${p6.withheld} ${p6.withheld === 1 ? "line" : "lines"} left out: alcohol words on a show that is not 21+.`) : null,
    text(st.small, p6.note),
  );
  return view(
    { flexDirection: "row", borderTopWidth: 0.6, borderTopColor: INK, borderTopStyle: "solid", paddingTop: st.fs(4), marginTop: st.fs(7) },
    has("media") ? media : null,
    has("hooks") ? hooks : null,
  );
}

/**
 * The foot of the sheet in three columns: your own list (to call), what this sheet doesn't show (every sheet
 * prints these lines), and the requests behind the sheet with the data credits and, on a sample, the sample line.
 */
function footer(m: SheetModel, st: Styles): El {
  const f = m.footer;
  const has = (x: SheetSection) => m.sections.includes(x);
  const head = (t: string) => text([st.base, st.bold, { marginBottom: st.fs(1) }], t);
  return view(
    { flexDirection: "row", borderTopWidth: 0.6, borderTopColor: INK, borderTopStyle: "solid", paddingTop: st.fs(4), marginTop: st.fs(5) },
    has("declared") ? view({ width: "28%", paddingRight: st.fs(10) }, panel3(m, st)) : null,
    has("limits") ? view({ width: "40%", paddingRight: st.fs(10) }, head(f.limitsTitle), ...f.limits.map((l) => text(st.small, `•  ${l}`))) : null,
    view(
      { width: "32%" },
      head(f.receiptsTitle),
      f.ledgerUrl
        ? h(Link, { src: f.ledgerUrl, style: { color: INK, textDecoration: "none" } }, text(st.small, breakUrl(f.ledgerLine, f.ledgerUrl)))
        : text(st.small, f.ledgerLine),
      text([st.small, st.gap(1.5)], f.elsewhere),
      text([st.small, st.gap(1.5)], f.attribution),
    ),
  );
}

/**
 * A URL is one long word, and a break inside a word would print a hyphen into it, so the line is broken by hand:
 * before the URL and after its last slash (the plan id stays whole on its own line).
 */
export function breakUrl(line: string, url: string): string {
  const at = line.indexOf(url);
  const slash = url.lastIndexOf("/");
  if (at < 0 || slash < 0) return line;
  return `${line.slice(0, at).trimEnd()}\n${url.slice(0, slash + 1)}\n${url.slice(slash + 1)}${line.slice(at + url.length)}`;
}

/** One small line at the foot of the page: the headliner, room and date, the print date, the data date, "Sample" on fixtures. */
function printLine(m: SheetModel, st: Styles): El {
  return text(
    [st.small, { marginTop: st.fs(5), fontSize: Math.max(6.5, st.fs(7.5)), borderTopWidth: 0.5, borderTopColor: RULE, borderTopStyle: "solid", paddingTop: st.fs(2) }],
    m.footer.printLine,
  );
}

/** One light diagonal word per watermark ("Sample data" on sample sheets). */
function watermarks(m: SheetModel, pageH: number): El[] {
  return m.watermarks.map((w, i) =>
    h(
      Text,
      {
        fixed: true,
        hyphenationCallback: noHyphen,
        style: {
          position: "absolute",
          top: pageH * (m.watermarks.length === 1 ? 0.45 : 0.32 + 0.3 * i),
          left: 0,
          right: 0,
          textAlign: "center",
          fontFamily: BOLD,
          fontSize: 54,
          color: INK,
          opacity: 0.05,
          transform: "rotate(-24deg)",
        },
      },
      pdfText(w),
    ),
  );
}

export interface DocumentOptions {
  pageSize?: PdfPageSize;
  scale?: number;
  /** Least height of a partner row, in points. Default: 7 mm at full size, scaled with the type. */
  formRowPt?: number;
  /** Creation date written into the PDF info. Default: the sheet's createdAt. */
  creationDate?: Date;
}

/** The react-pdf element tree for a built model. */
export function streetSheetElement(m: SheetModel, opts: DocumentOptions = {}): El {
  const size = opts.pageSize ?? "LETTER";
  const dims = PAGE_SIZES[size];
  const s = Math.max(0.5, Math.min(1.2, opts.scale ?? 1));
  const st = makeStyles(s);
  const marginX = 24;
  const contentW = dims.width - marginX * 2;
  // Row 1: where to flyer (map about 60 mm wide, then areas 1-5) beside before and after the show.
  const leftW = contentW * 0.58;
  const leftPad = st.fs(12);
  const mapW = Math.round(Math.min(170, leftW * 0.52));
  const mapH = Math.round(mapW * 0.66);
  const listW = leftW - leftPad - mapW - st.fs(7);
  const row = (...kids: El[]) => view({ flexDirection: "row", marginTop: st.fs(8) }, ...kids);

  const page = h(
    Page,
    {
      size,
      style: { paddingTop: 22, paddingBottom: 18, paddingHorizontal: marginX, fontFamily: "Helvetica", fontSize: st.fs(7.4), color: INK, backgroundColor: "#ffffff" },
    },
    header(m, st),
    ...m.notes.map((n, i) => text([st.small, { marginTop: st.fs(i === 0 ? 3 : 0.5), color: /thin/i.test(n) ? INK : MUTED }], n)),
    discoveryLine(m, st),
    row(view({ width: leftW, paddingRight: leftPad }, panel1(m, st, mapW, mapH, listW)), view({ width: contentW - leftW }, panel4(m, st), budgetPanel(m, st))),
    view(st.gap(8), panel2(m, st, opts.formRowPt ?? FORM_ROW_PT * s)),
    mediaRow(m, st),
    footer(m, st),
    printLine(m, st),
    ...watermarks(m, dims.height),
  );
  return h(
    Document,
    {
      title: pdfText(m.docTitle),
      author: "Walkup",
      subject: "Street sheet",
      creator: "Walkup",
      producer: "Walkup",
      language: "en-US",
      ...(opts.creationDate && !Number.isNaN(opts.creationDate.getTime()) ? { creationDate: opts.creationDate } : {}),
    },
    page,
  );
}

/** Build the model and the element tree for a sheet (no rendering). */
export function streetSheetDocument(sheet: StreetSheet, opts: PdfOptions = {}): El {
  return streetSheetElement(buildSheetModel(sheet, opts), { pageSize: opts.pageSize, scale: opts.scale, creationDate: new Date(sheet.createdAt) });
}

/** Number of pages in a PDF produced by this package (counts /Type /Page objects). */
export function countPdfPages(pdf: Uint8Array): number {
  const s = Buffer.from(pdf).toString("latin1");
  return (s.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
}

/**
 * Fitting steps, largest first: the type scale and the least form-row height (7 mm while it fits, then rows
 * no taller than their two lines of text need).
 */
const FIT_PLANS: readonly { scale: number; rowPt: number; caps?: SheetModelOptions }[] = [
  { scale: 1, rowPt: FORM_ROW_PT },
  { scale: 0.92, rowPt: FORM_ROW_PT },
  // Rows stay 7 mm tall so they can be written in: the list gets shorter first (the rest is in partners.csv).
  { scale: 0.92, rowPt: FORM_ROW_PT, caps: { maxPartners: 16 } },
  { scale: 0.86, rowPt: FORM_ROW_PT, caps: { maxPartners: 16 } },
  { scale: 0.8, rowPt: FORM_ROW_PT, caps: { maxPartners: 16 } },
  { scale: 0.8, rowPt: FORM_ROW_PT, caps: { maxPartners: 14 } },
  { scale: 0.8, rowPt: 16, caps: { maxPartners: 14 } },
  { scale: 0.74, rowPt: 14 },
  // Still too long: fewer partner rows before every list is cut (the rest are in partners.csv).
  { scale: 0.74, rowPt: 14, caps: { maxPartners: 20 } },
  { scale: 0.74, rowPt: 14, caps: { maxPartners: 16 } },
];
const SHORT_LISTS: SheetModelOptions = { maxPartners: 12, maxDeclared: 6, maxSpots: 6, maxPodcasts: 3, maxHooks: 3, maxLimits: 6 };

function tighter(user: number | undefined, cap: number | undefined): number | undefined {
  if (cap === undefined) return user;
  return user === undefined ? cap : Math.min(user, cap);
}

/** Renders the sheet and reports how it was fitted. */
export async function renderStreetSheetPdf(sheet: StreetSheet, opts: PdfOptions = {}): Promise<PdfRenderResult> {
  const created = new Date(sheet.createdAt);
  const lastPlan = FIT_PLANS[FIT_PLANS.length - 1] ?? { scale: 0.74, rowPt: 14 };
  const plans: { scale: number; rowPt: number; caps: SheetModelOptions | null }[] =
    opts.fit === false
      ? [{ scale: opts.scale ?? 1, rowPt: FORM_ROW_PT * (opts.scale ?? 1), caps: null }]
      : [...FIT_PLANS.map((x) => ({ scale: x.scale, rowPt: x.rowPt, caps: x.caps ?? null })), { scale: lastPlan.scale, rowPt: lastPlan.rowPt, caps: SHORT_LISTS }];
  let last: PdfRenderResult | null = null;
  for (const plan of plans) {
    const modelOpts: SheetModelOptions = plan.caps
      ? {
          ...opts,
          maxPartners: tighter(opts.maxPartners, plan.caps.maxPartners),
          maxDeclared: tighter(opts.maxDeclared, plan.caps.maxDeclared),
          maxSpots: tighter(opts.maxSpots, plan.caps.maxSpots),
          maxPodcasts: tighter(opts.maxPodcasts, plan.caps.maxPodcasts),
          maxHooks: tighter(opts.maxHooks, plan.caps.maxHooks),
          maxLimits: tighter(opts.maxLimits, plan.caps.maxLimits),
        }
      : opts;
    const element = streetSheetElement(buildSheetModel(sheet, modelOpts), { pageSize: opts.pageSize, scale: plan.scale, formRowPt: plan.rowPt, creationDate: created });
    // react-pdf types its argument as ReactElement<DocumentProps>; the root here is a <Document>.
    const buffer = await renderToBuffer(element as Parameters<typeof renderToBuffer>[0]);
    const pages = countPdfPages(buffer);
    last = { buffer, pages, scale: plan.scale, truncated: plan.caps !== null };
    if (pages <= 1) return last;
  }
  return last as PdfRenderResult;
}

/** street-sheet.pdf: one page, US Letter by default (A4 with `pageSize: "A4"`). */
export async function toPdf(sheet: StreetSheet, opts: PdfOptions = {}): Promise<Buffer> {
  return (await renderStreetSheetPdf(sheet, opts)).buffer;
}
