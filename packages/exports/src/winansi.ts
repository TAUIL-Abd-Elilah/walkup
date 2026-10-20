/**
 * The PDF uses the built-in Helvetica faces (no font files to ship), which can
 * only draw the WinAnsi (Windows-1252) character set. Anything else would print
 * as a wrong glyph, so every string goes through `pdfText` first: common
 * symbols get an ASCII stand-in, accented letters outside the set lose their
 * accent, and anything left becomes "?".
 */

/** The Windows-1252 characters in 0x80-0x9F (the rest of the set is ASCII plus Latin-1 0xA0-0xFF). */
const CP1252_EXTRA = new Set(
  "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ",
);

const REPLACEMENTS: Readonly<Record<string, string>> = {
  "→": "->",
  "←": "<-",
  "↔": "<->",
  "⇒": "=>",
  "≥": ">=",
  "≤": "<=",
  "≠": "!=",
  "≈": "~",
  "−": "-", // minus sign
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "―": "-",
  "′": "'",
  "″": '"',
  "‛": "'",
  "‟": '"',
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  " ": " ",
  "​": "",
  "‌": "",
  "‍": "",
  "﻿": "",
  "✓": "v",
  "✔": "v",
  "✕": "x",
  "✗": "x",
  "●": "•",
  "○": "o",
  "□": "[ ]",
  "☐": "[ ]",
  "★": "*",
  "☆": "*",
};

function isWinAnsi(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  if (c === 0x0a) return true;
  if (c >= 0x20 && c <= 0x7e) return true;
  if (c >= 0xa0 && c <= 0xff) return true;
  return CP1252_EXTRA.has(ch);
}

/** True when every character of `s` can be drawn by the standard PDF fonts. */
export function isPdfSafe(s: string): boolean {
  for (const ch of s) if (!isWinAnsi(ch)) return false;
  return true;
}

/** A copy of `s` that the standard PDF fonts can draw. Control characters become spaces. */
export function pdfText(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  let out = "";
  for (const ch of String(s).normalize("NFC")) {
    if (isWinAnsi(ch)) {
      out += ch;
      continue;
    }
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) {
      out += c === 0x0d ? "" : " ";
      continue;
    }
    const rep = REPLACEMENTS[ch];
    if (rep !== undefined) {
      out += rep;
      continue;
    }
    const stripped = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    if (stripped !== "" && [...stripped].every(isWinAnsi)) {
      out += stripped;
      continue;
    }
    out += "?";
  }
  return out;
}
