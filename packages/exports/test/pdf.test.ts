import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { countPdfPages, FORM_ROW_PT, renderStreetSheetPdf, streetSheetDocument, toPdf } from "../src/pdf";
import { pdfText, isPdfSafe } from "../src/winansi";
import { ACTS, makeBusySheet, makeExplainedSheet, makeSheet } from "./helpers";
import { countOccurrences, pdfPlainText } from "./pdf-text";

const SLOW = 60_000;

interface Node {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function isElement(x: unknown): x is Node {
  return typeof x === "object" && x !== null && "props" in x && "type" in x;
}

/** Every element in a react-pdf tree (the tree uses primitives only, so no rendering is needed). */
function walk(el: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(el)) {
    for (const c of el) walk(c, out);
    return out;
  }
  if (!isElement(el)) return out;
  out.push(el);
  walk(el.props.children, out);
  return out;
}

function textOf(el: unknown): string {
  if (typeof el === "string" || typeof el === "number") return String(el);
  if (Array.isArray(el)) return el.map(textOf).join("");
  if (isElement(el)) return textOf(el.props.children);
  return "";
}

describe("toPdf", () => {
  it(
    "renders a one-page PDF that contains the acts, the venue and the panels",
    async () => {
      const buf = await toPdf(makeSheet());
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(buf.length).toBeGreaterThan(3000);
      expect(countPdfPages(buf)).toBe(1);
      const text = pdfPlainText(buf);
      for (const act of ACTS) expect(text).toContain(act);
      // The day-sheet header: "Walkup street sheet", the headliner and the rest after "with"; date, room, days to go, seats.
      expect(text).toContain("Walkup street sheet");
      expect(text).toContain("Juniper Wire with The Lantern Choir and Mesa Static");
      expect(text).toContain("Fri Nov 20 2026");
      expect(text).toContain("Example Hall, Nashville, TN");
      expect(text).toContain("All ages · street team Thu and Sat · 40 km radius");
      expect(text).toContain("42 days to the show");
      expect(text).toContain("640 of 1,200 seats left");
      for (const title of ["Where this crowd stands out", "Before and after the show", "Partners (6)", "Your list", "What this sheet doesn't show", "Requests behind this sheet"]) {
        expect(text).toContain(title);
      }
      // The street team's page leaves podcasts, the sponsor, copy lines and the budget to the web sheet, and says so.
      expect(text).not.toContain("Podcasts and a sponsor");
      expect(text).not.toContain("Copy lines");
      expect(text).toContain("Podcasts, the sponsor pick, copy lines and the budget split are on the web sheet and in sheet.json.");
      expect(text).toContain("Suggested, not affiliated: no partner has agreed to anything.");
      // Receipts are one quiet group per row, no brackets.
      expect(text).toContain("Q9-Q10");
      expect(text).not.toMatch(/\[Q\d+\]/);
      // The partner table is a form: tick box, number, place, area, hours, why and a blank Notes column.
      for (const head of ["Place and address", "Area", "Open Thu", "Why", "Notes"]) expect(text).toContain(head);
      expect(text).toContain("10 am to 7 pm");
      // Honest blanks: a missing phone is said out loud.
      expect(text).toContain("Phone not listed");
      // Before and after the show is a small table.
      for (const head of ["Spot", "Type", "Distance", "Share", "Vs usual crowd"]) expect(text).toContain(head);
      expect(text).toContain("not in Qloo's catalog, kept in your order");
      expect(text).toContain("not for fans");
      expect(text).toMatch(/Juniper Wire · Example Hall · Fri Nov 20 · printed \w{3} \w{3} \d{1,2} \d{4} · data from Fri Oct 9 2026/);
      expect(text).toContain("Q1-Q12, T1-T2, P1, L1");
      for (const source of ["Ticketmaster", "OpenStreetMap", "U.S. Census Bureau", "Qloo"]) expect(text).toContain(source);
      expect(text).not.toContain("Google");
      for (const limit of makeSheet().limits) expect(text).toContain(limit);
      expect(text).not.toContain("Cold beer");
      // A live, non-hypothetical sheet carries no label and no watermark, and no shouted labels at all.
      expect(text).not.toContain("Sample data");
      expect(text).not.toContain("What-if counts");
      expect(text).not.toMatch(/STREET SHEET|FIXTURE|HYPOTHETICAL/);
      expect(text).not.toContain("Start with this place:");
    },
    SLOW,
  );

  it(
    "labels a sample sheet in its header, footer and one light watermark",
    async () => {
      const buf = await toPdf(makeSheet({ hypothetical: true, mode: "fixture" }));
      const text = pdfPlainText(buf);
      // Header label, the sample credit line in place of the live sources, the footer line and the watermark; no limits bullet.
      expect(text).toContain("Walkup street sheet · Sample data");
      expect(text).toContain("Sample data shaped like Ticketmaster and Qloo answers. Map data © OpenStreetMap contributors.");
      expect(text).not.toContain("Affinity data: Qloo");
      expect(text).not.toContain("Sample data: made-up places and numbers, not a live run.");
      expect(countOccurrences(text, "Sample data")).toBe(3);
      expect(text).toContain("640 of 1,200 seats left (assumed)");
      expect(text).toMatch(/ · Sample/);
    },
    SLOW,
  );

  it(
    "carries a What-if counts watermark on a live what-if sheet",
    async () => {
      const text = pdfPlainText(await toPdf(makeSheet({ hypothetical: true })));
      expect(countOccurrences(text, "What-if counts")).toBeGreaterThanOrEqual(1);
      expect(text).not.toContain("Sample data");
    },
    SLOW,
  );

  it(
    "marks less certain rows with a dagger and one note, and prints the discovery line, still on one page",
    async () => {
      const res = await renderStreetSheetPdf(makeExplainedSheet());
      expect(res.pages).toBe(1);
      const text = pdfPlainText(res.buffer);
      expect(text).toContain("Ranks 3rd here for this crowd.");
      expect(text).not.toContain("check first.");
      expect(text).toContain("Corner Fade Barbers †");
      expect(text).toContain("† Less certain: the search widened, the list was short or the place ranked low. Call before you go.");
      expect(text).toContain("Start with this place:");
      expect(text).toContain("Paper Lantern Books, 4.2 km out in Edgehill.");
      expect(text).toContain("Why this one: the highest-ranked partner that is not a bar");
      const busy = makeBusySheet();
      const explained = makeExplainedSheet();
      busy.cards.partners.results = busy.cards.partners.results.map((p, i) => ({ ...p, explain: explained.cards.partners.results[i % 6]!.explain }));
      busy.discovery = explained.discovery;
      const fitted = await renderStreetSheetPdf(busy);
      expect(fitted.pages).toBe(1);
    },
    SLOW,
  );

  it(
    "says where the room's usual crowd ranks a partner in the why line, with no vs house legend",
    async () => {
      const plain = pdfPlainText(await toPdf(makeSheet()));
      expect(plain).not.toContain("vs house");
      const s = makeSheet();
      s.cards.partners.results = s.cards.partners.results.map((p, i) => ({ ...p, houseRank: i === 0 ? null : p.qlooRank + i }));
      const text = pdfPlainText(await toPdf(s));
      expect(text).not.toContain("vs house");
      expect(text).toContain("not in the usual crowd's list");
      expect(text).toContain("for the room's usual crowd.");
    },
    SLOW,
  );

  it(
    "prints on A4 when asked (US Letter by default)",
    async () => {
      const letter = (await toPdf(makeSheet())).toString("latin1");
      expect(letter).toMatch(/\/MediaBox \[0 0 612 792\]/);
      const a4 = (await toPdf(makeSheet(), { pageSize: "A4" })).toString("latin1");
      expect(a4).toMatch(/\/MediaBox \[0 0 595\.28\d* 841\.89\d*\]/);
    },
    SLOW,
  );

  it(
    "fits a full sheet (25 partners, 12 declared, 8 spots, long names) on one page",
    async () => {
      const res = await renderStreetSheetPdf(makeBusySheet());
      expect(res.pages).toBe(1);
      expect(res.scale).toBeLessThanOrEqual(1);
      const text = pdfPlainText(res.buffer);
      expect(text).toContain("Partners (25)");
    },
    SLOW,
  );

  it(
    "shrinks type before it spills onto a second page, then shortens lists as a last resort",
    async () => {
      const unfitted = await renderStreetSheetPdf(makeBusySheet(), { fit: false, scale: 1.2 });
      expect(unfitted.pages).toBeGreaterThan(1);

      const s = makeBusySheet();
      const many = Array.from({ length: 60 }, (_, i) => ({ ...s.cards.partners.results[i % 25]!, entity: { ...s.cards.partners.results[i % 25]!.entity, entityId: `syn-many-${i}` } }));
      s.cards = { ...s.cards, partners: { ...s.cards.partners, results: many } };
      const res = await renderStreetSheetPdf(s, { maxPartners: 60 });
      expect(res.pages).toBe(1);
      expect(res.truncated).toBe(true);
      const text = pdfPlainText(res.buffer);
      expect(text).toContain("Partners (60)");
      expect(text).toMatch(/\+\d+ more partners in partners\.csv\./);
    },
    SLOW,
  );

  it(
    "draws characters outside the standard font set as safe stand-ins",
    async () => {
      const s = makeSheet();
      s.bill = { ...s.bill, acts: [{ name: "Zoë → Őrs", role: "headliner" }] };
      const text = pdfPlainText(await toPdf(s));
      expect(text).toContain("Zoë -> Ors");
      expect(pdfText("a ≥ b − c \u{1F3B8}")).toBe("a >= b - c ?");
      expect(isPdfSafe(pdfText("日本 é —"))).toBe(true);
    },
    SLOW,
  );
});

describe("React tree", () => {
  it("has a Document with one Page, the act names and one light watermark", () => {
    const el = streetSheetDocument(makeSheet({ hypothetical: true, mode: "fixture" })) as ReactElement;
    const nodes = walk(el);
    expect(nodes.filter((n) => n.type === "PAGE")).toHaveLength(1);
    expect(nodes[0]?.type).toBe("DOCUMENT");
    const all = textOf(el);
    for (const act of ACTS) expect(all).toContain(act);
    const marks = nodes.filter((n) => {
      const style = n.props.style as { position?: string } | undefined;
      return n.type === "TEXT" && style?.position === "absolute" && n.props.fixed === true;
    });
    expect(marks.map((n) => textOf(n))).toEqual(["Sample data"]);
    expect((marks[0]!.props.style as { opacity?: number }).opacity).toBeLessThanOrEqual(0.08);
  });

  it("lays the partner table out as a form: a tick box per row, rows 7 mm tall at full size, a blank Notes column", () => {
    const nodes = walk(streetSheetDocument(makeSheet()));
    const rows = nodes.filter((n) => n.type === "VIEW" && (n.props.style as { minHeight?: number } | undefined)?.minHeight !== undefined);
    expect(rows).toHaveLength(6);
    for (const r of rows) expect((r.props.style as { minHeight: number }).minHeight).toBeCloseTo(FORM_ROW_PT, 5);
    expect(FORM_ROW_PT / 72 * 25.4).toBeCloseTo(7, 1);
    // Each row: tick box, number, place, area, hours, why, notes; the notes cell is the widest blank.
    const cells = (rows[0]!.props.children as Node[]).filter(isElement);
    expect(cells).toHaveLength(7);
    expect((cells[6]!.props.style as { width: string }).width).toBe("22%");
    expect(textOf(cells[6])).toBe("");
    const box = walk(cells[0]).find((n) => (n.props.style as { borderWidth?: number } | undefined)?.borderWidth !== undefined);
    expect(box).toBeDefined();
  });

  it("marks a row with no listed hours in pale yellow, the one thing to act on", () => {
    const s = makeSheet();
    s.cards.partners.results = s.cards.partners.results.map((p, i) => (i === 1 ? { ...p, hoursOnDay: null } : p));
    const rows = walk(streetSheetDocument(s)).filter((n) => n.type === "VIEW" && (n.props.style as { minHeight?: number } | undefined)?.minHeight !== undefined);
    expect(rows.map((r) => (r.props.style as { backgroundColor?: string }).backgroundColor ?? null)).toEqual([null, "#fff8db", null, null, null, null]);
  });

  it("has no watermark on a live sheet with real counts", () => {
    const nodes = walk(streetSheetDocument(makeSheet()));
    expect(nodes.filter((n) => (n.props.style as { position?: string } | undefined)?.position === "absolute")).toHaveLength(0);
  });

  it("draws the lift map as SVG rectangles in the accent, numbered markers, the venue and a scale bar", () => {
    const nodes = walk(streetSheetDocument(makeSheet()));
    const svg = nodes.find((n) => n.type === "SVG");
    expect(svg).toBeDefined();
    const inSvg = walk(svg!.props.children);
    const rects = inSvg.filter((n) => n.type === "RECT");
    // Background, the 5 top tiles, the venue square, the scale bar and the frame.
    expect(rects.length).toBeGreaterThanOrEqual(9);
    // Every tile is a tint of the one accent ink: no other hue on the map.
    const fills = rects.map((r) => String(r.props.fill)).filter((f) => f !== "none" && f !== "#ffffff" && f !== "#111111" && f !== "#555555");
    expect(fills.length).toBeGreaterThanOrEqual(5);
    for (const f of fills) {
      const n = parseInt(f.slice(1), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      expect(r).toBeGreaterThanOrEqual(g);
      expect(g).toBeGreaterThanOrEqual(b - 1);
    }
    // One filled marker per top tile, no rings.
    expect(inSvg.filter((n) => n.type === "CIRCLE")).toHaveLength(5);
    // Grid lines plus one leader line per marker.
    expect(inSvg.filter((n) => n.type === "LINE").length).toBeGreaterThanOrEqual(5);
    // The venue's name, the five numbers that match the list, and the scale bar.
    expect(inSvg.filter((n) => n.type === "TEXT").map(textOf)).toEqual(["Example Hall", "1", "2", "3", "4", "5", expect.stringMatching(/^\d+(\.\d)? km$/)]);
  });
});

describe("repository fixtures", () => {
  const dir = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sheet.json")) : [];

  it.runIf(files.length > 0)(
    "every synthetic sheet renders to one page with its acts and the sample label",
    async () => {
      for (const f of files) {
        const raw = JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as { sheet: StreetSheet };
        const res = await renderStreetSheetPdf(raw.sheet);
        expect(res.pages, f).toBe(1);
        const text = pdfPlainText(res.buffer);
        for (const act of raw.sheet.bill.acts) expect(text, f).toContain(pdfText(act.name));
        if (raw.sheet.mode === "fixture") expect(countOccurrences(text, "Sample data"), f).toBeGreaterThanOrEqual(3);
        if (raw.sheet.hypothetical) expect(text, f).toMatch(/\(assumed\)|Counts are what-ifs/);
      }
    },
    SLOW * 2,
  );
});
