/**
 * The email itself: a plain, specific subject, a text body with an HTML twin,
 * and a CAN-SPAM footer (physical postal address and an opt-out line).
 * Built only from facts already on the sheet; no generated copy.
 */
import { LIMITS_EVERY_SHEET, type StreetSheet } from "@walkup/contracts";
import { categoryLabel, partnerHoursColumn, realLimits, streetDaysText, topTiles, TOP_LIFT } from "@walkup/exports";
import { ATTACHMENT_LABELS, type AttachmentFile } from "./attachments";
import { BODY_PARTNER_LIMIT, BODY_TILE_LIMIT, FIXTURE_NOTE, NOT_AFFILIATED_LINE, WHAT_IF_NOTE } from "./constants";

export interface BuiltMessage {
  subject: string;
  text: string;
  html: string;
  /** The footer lines as plain text (also inside `text` and `html`). */
  footer: string;
}

export interface MessageOptions {
  postalAddress: string | null;
  /** Bare reply address for the opt-out line; null in demo mode without RESEND_FROM. */
  replyAddress: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

/** One line, no control characters, collapsed spaces, at most `max` characters. */
export function oneLine(s: string, max = 200): string {
  const t = s.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

function cap(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** "2026-11-20" + "friday" -> "Fri Nov 20 2026" (no time zone math: the date is already local). */
export function showDate(date: string, weekday: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return oneLine(date, 40);
  const [, y, mo, d] = m;
  const month = MONTHS[Number(mo) - 1] ?? mo;
  const wd = weekday ? `${cap(weekday.slice(0, 3))} ` : "";
  return `${wd}${month} ${Number(d)} ${y}`;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function headlinerNames(sheet: StreetSheet): string {
  const acts = sheet.bill.acts;
  const heads = acts.filter((a) => a.role === "headliner");
  const pick = (heads.length > 0 ? heads : acts).slice(0, 2).map((a) => oneLine(a.name, 80));
  return pick.length > 0 ? pick.join(" / ") : "Untitled bill";
}

export function buildSubject(sheet: StreetSheet): string {
  // What-if counts are said in the body; a sample sheet says so in the subject too.
  const suffix = sheet.mode === "fixture" ? " (sample)" : "";
  const venue = oneLine(sheet.bill.venue.name, 80);
  return oneLine(`Street sheet for ${headlinerNames(sheet)}, ${venue}, ${showDate(sheet.bill.date, sheet.bill.weekday)}${suffix}`, 200);
}

export function buildFooter(opts: MessageOptions): string {
  const optOut = opts.replyAddress
    ? `To opt out, reply "unsubscribe" or write to ${opts.replyAddress}; this address will be left off future sends.`
    : `To opt out, reply "unsubscribe"; this address will be left off future sends.`;
  const postal = opts.postalAddress
    ? `Walkup, ${opts.postalAddress
        .split(/\r?\n/)
        .map((l) => oneLine(l, 120))
        .filter(Boolean)
        .join(", ")}`
    : "Postal address not configured (WALKUP_POSTAL_ADDRESS). No real send goes out without it.";
  return [
    "You received this because a Walkup operator confirmed a send to this address, or it went to Resend's test inbox.",
    "Walkup keeps no mailing list and does not store the addresses it sends to.",
    optOut,
    postal,
  ].join("\n");
}

interface Section {
  title: string;
  lines: string[];
  numbered?: boolean;
}

interface Parts {
  intro: [string, string];
  notes: string[];
  body: Section[];
}

function parts(sheet: StreetSheet, files: AttachmentFile[]): Parts {
  const { bill, operator } = sheet;
  const acts = bill.acts.map((a) => oneLine(a.name, 120)).join(", ") || "Untitled bill";
  const place = [bill.venue.name, bill.venue.city, bill.venue.state]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map((s) => oneLine(s, 80))
    .join(", ");
  const intro: [string, string] = [`Street sheet for ${acts}.`, `${place}. ${showDate(bill.date, bill.weekday)}.`];

  const notes: string[] = [];
  if (sheet.mode === "fixture") notes.push(FIXTURE_NOTE);
  if (sheet.hypothetical) {
    // "Capacity 4,400 is an assumed number, not ticket sales."
    const nums: string[] = [];
    if (operator.seatsLeft !== null) nums.push(`${nums.length === 0 ? "Seats left" : "seats left"} ${fmtInt(operator.seatsLeft)}`);
    if (operator.capacity !== null) nums.push(`${nums.length === 0 ? "Capacity" : "capacity"} ${fmtInt(operator.capacity)}`);
    notes.push(nums.length === 0 ? WHAT_IF_NOTE : `${nums.join(" and ")} ${nums.length === 1 ? "is an assumed number" : "are assumed numbers"}, not ticket sales.`);
  }

  const body: Section[] = [];
  if (operator.streetTeamDays.length > 0) {
    body.push({ title: "Street-team days", lines: [streetDaysText(operator.streetTeamDays)] });
  }

  // Same selection as the PDF and the .ics (lift >= TOP_LIFT, highest first), so
  // the body never calls an under-indexing tile "over-index" and never
  // disagrees with the attached sheet, whatever order the tiles arrive in.
  const tiles = topTiles(sheet, { maxTiles: BODY_TILE_LIMIT });
  if (tiles.length > 0) {
    body.push({
      title: `Where this bill's fans stand out from the room's usual crowd (lift ${TOP_LIFT}x or more), numbered as on the map`,
      numbered: true,
      lines: tiles.map((t, i) => {
        const name = t.name ? oneLine(t.name, 80) : `Area ${i + 1}`;
        const z = (t.zctas ?? []).slice(0, 4);
        const zips = z.length > 0 ? `, ${z.length === 1 ? "ZIP" : "ZIPs"} ${z.join(", ")}` : "";
        return `${name}: lift ${t.lift.toFixed(2)}x${zips}.`;
      }),
    });
  }

  const partners = sheet.cards.partners.results;
  // The hours the plan page, the PDF and the CSV show (the visit day's hours with more than one street-team day).
  const hoursCol = partnerHoursColumn(sheet);
  const areaNumber = new Map(tiles.map((t, i) => [t.geohash, i + 1]));
  if (partners.length > 0) {
    const shown = partners.slice(0, BODY_PARTNER_LIMIT);
    const csv = files.find((f) => f.kind === "partners");
    const csvNote = csv ? `; all ${partners.length} are in ${csv.filename}` : "";
    body.push({
      title: `Partners (${shown.length} of ${partners.length}${csvNote})`,
      numbered: true,
      // "Heron & Garden Apparel, clothing, 371 Harlow Rd, Belle Meade. Thu 10 am to 8 pm. +1 555-0137. Area 1."
      lines: shown.map((p) => {
        // "cafe, national chain" on a chain, as the plan page and the paper say it.
        const head = [oneLine(p.entity.name, 100), categoryLabel(p.category).toLowerCase(), p.chain === true ? "national chain" : "", p.address ? oneLine(p.address.replace(/, [A-Z]{2}$/, ""), 140) : ""]
          .filter((x) => x !== "")
          .join(", ");
        // Room for two visit days with their hours ("Thu 5 pm to 9 pm; Sat 11 am to 3 pm") when the passes differ, and
        // the calendar's "no time left on the route: call to arrange" after them.
        const bits = [head, oneLine(hoursCol.cell(p).withDay, 160)];
        if (p.phone) bits.push(oneLine(p.phone, 40));
        // A sample sheet's websites are made up (.example), so the email leaves them out.
        if (p.website && sheet.mode !== "fixture") bits.push(oneLine(p.website, 120));
        const n = p.tileGeohash ? areaNumber.get(p.tileGeohash) : undefined;
        bits.push(n ? `Area ${n}` : p.tileGeohash ? oneLine(p.tileName ?? "Another area", 60) : "Near the venue");
        return `${bits.join(". ")}.`;
      }),
    });
  }
  body.push({ title: "Partners", lines: [NOT_AFFILIATED_LINE, "Walkup did not contact anyone on this sheet."] });

  if (files.length > 0) {
    body.push({ title: "Attached", lines: files.map((f) => `${ATTACHMENT_LABELS[f.kind]}: ${f.filename}`) });
  }

  const limits = realLimits(sheet.limits, LIMITS_EVERY_SHEET);
  body.push({ title: "What this sheet doesn't show", lines: limits.map((l) => oneLine(l, 240)) });
  return { intro, notes, body };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function buildMessage(sheet: StreetSheet, files: AttachmentFile[], opts: MessageOptions): BuiltMessage {
  const subject = buildSubject(sheet);
  const footer = buildFooter(opts);
  const { intro, notes, body } = parts(sheet, files);

  const text = [
    intro.join("\n"),
    ...notes,
    ...body.map((s) => `${s.title}:\n${s.lines.map((l, i) => (s.numbered ? `${i + 1}. ${l}` : `- ${l}`)).join("\n")}`),
    `--\n${footer}`,
  ].join("\n\n");

  const p = "margin:0 0 12px 0;";
  const html = [
    `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#111;max-width:640px;">`,
    `<p style="${p}"><strong>${esc(intro[0])}</strong><br>${esc(intro[1])}</p>`,
    ...notes.map((n) => `<p style="${p}padding:8px;border:1px solid #999;"><strong>${esc(n)}</strong></p>`),
    ...body.map((s) => {
      const tag = s.numbered ? "ol" : "ul";
      const items = s.lines.map((l) => `<li>${esc(l)}</li>`).join("");
      return `<h3 style="font-size:15px;margin:16px 0 6px 0;">${esc(s.title)}</h3><${tag} style="margin:0 0 12px 20px;padding:0;">${items}</${tag}>`;
    }),
    `<hr style="border:none;border-top:1px solid #ccc;margin:20px 0 10px 0;">`,
    `<p style="${p}font-size:12px;color:#444;">${footer.split("\n").map(esc).join("<br>")}</p>`,
    `</body></html>`,
  ].join("\n");

  return { subject, text, html, footer };
}
