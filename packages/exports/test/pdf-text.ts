/**
 * Minimal text extraction for PDFs written by react-pdf/pdfkit with the
 * standard fonts: inflate every content stream and decode the hex strings in
 * TJ/Tj operators as Windows-1252. Good enough to assert on; not a PDF parser.
 */
import { inflateSync } from "node:zlib";

const CP1252_HIGH: Record<number, string> = {
  0x80: "€",
  0x82: "‚",
  0x83: "ƒ",
  0x84: "„",
  0x85: "…",
  0x86: "†",
  0x87: "‡",
  0x88: "ˆ",
  0x89: "‰",
  0x8a: "Š",
  0x8b: "‹",
  0x8c: "Œ",
  0x8e: "Ž",
  0x91: "‘",
  0x92: "’",
  0x93: "“",
  0x94: "”",
  0x95: "•",
  0x96: "–",
  0x97: "—",
  0x98: "˜",
  0x99: "™",
  0x9a: "š",
  0x9b: "›",
  0x9c: "œ",
  0x9e: "ž",
  0x9f: "Ÿ",
};

function decodeHex(hex: string): string {
  const bytes = Buffer.from(hex, "hex");
  let s = "";
  for (const b of bytes) s += CP1252_HIGH[b] ?? String.fromCharCode(b);
  return s;
}

/** Decoded content streams (those that inflate). */
export function contentStreams(pdf: Buffer): string[] {
  const s = pdf.toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const raw = Buffer.from(m[1] ?? "", "latin1");
    try {
      out.push(inflateSync(raw).toString("latin1"));
    } catch {
      // not a deflated stream (fonts, images): skip
    }
  }
  return out;
}

/** Text runs in drawing order, one per TJ/Tj operator. */
export function pdfTextRuns(pdf: Buffer): string[] {
  const runs: string[] = [];
  for (const stream of contentStreams(pdf)) {
    const re = /\[((?:[^\]\\]|\\.)*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stream))) {
      if (m[1] !== undefined) {
        const parts = [...m[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => decodeHex(x[1] ?? ""));
        runs.push(parts.join(""));
      } else if (m[2] !== undefined) {
        runs.push(decodeHex(m[2]));
      }
    }
  }
  return runs;
}

/**
 * All text, runs joined by spaces and whitespace collapsed (wrapped lines read
 * as one). The layout engine draws an opening bracket or quote as its own run
 * ("[" then "Q3]"), so the space the join puts after one is removed again.
 */
export function pdfPlainText(pdf: Buffer): string {
  return pdfTextRuns(pdf)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/([[(“‘]) /g, "$1")
    .trim();
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}
