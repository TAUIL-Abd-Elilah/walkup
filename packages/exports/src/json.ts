/**
 * sheet.json: the whole Street Sheet, ledger included, in a small envelope.
 *
 * Before writing, a defensive pass re-applies two rules the pipeline already
 * enforces, because this file is persisted and shared:
 * - tags: person entities carry no tags; denied tags (identity, religion,
 *   politics, sexuality, health and the commercial namespaces) are removed
 *   wherever a tag list appears;
 * - secrets: ledger params and copy-as-curl strings keep only "$ENV_VAR"
 *   references; any literal key-like value is replaced with "[redacted]".
 * An older stored sheet's Google Places list (`control`) is dropped first
 * (withoutControl): the product no longer shows it.
 */
import { withoutControl, type StreetSheet } from "@walkup/contracts";
import { isDeniedTag, isPersonEntity } from "@walkup/engine";
import { FIXTURE_NOTICE } from "./format";

export const SHEET_JSON_FORMAT = "walkup.street-sheet";
export const SHEET_JSON_VERSION = 1;

export interface SheetJsonOptions {
  /** Indent with two spaces. Default true. */
  pretty?: boolean;
  /** Run the tag and secret pass. Default true. */
  sanitize?: boolean;
}

export interface SheetJsonDocument {
  format: typeof SHEET_JSON_FORMAT;
  formatVersion: typeof SHEET_JSON_VERSION;
  planId: string;
  mode: StreetSheet["mode"];
  hypothetical: boolean;
  /** Present on fixture sheets: they are never presented as live runs. */
  notice?: string;
  /** Tag and secret pass counts (zero when the pipeline already did its job). */
  sanitized: { tagsRemoved: number; secretsRedacted: number } | null;
  sheet: StreetSheet;
}

/** Param names that hold a credential: the whole name or its last segment ("apikey", "x.api_key", "key"). */
const SECRET_KEY_RE = /(^|[._-])(api[_-]?key|apikey|key|access[_-]?token|token|secret|password|authorization)$/i;
const ENV_REF_RE = /^\$[A-Z][A-Z0-9_]*$/;
const CURL_HEADER_RE = /((?:x-api-key|x-goog-api-key|authorization|api-key)\s*:\s*(?:bearer\s+)?)(?!\$|bearer\b)([^'"\s\\]+)/gi;
const CURL_QUERY_RE = /(\b(?:apikey|api_key|key|access_token|token)=)(?!\$)([^&'"\s\\]+)/gi;

function isTagLike(x: unknown): boolean {
  return typeof x === "object" && x !== null && typeof (x as { id?: unknown }).id === "string" && (x as { id: string }).id.startsWith("urn:tag:");
}

function isTagIdLike(x: unknown): boolean {
  return typeof x === "string" && x.startsWith("urn:tag:");
}

interface Counts {
  tagsRemoved: number;
  secretsRedacted: number;
}

function scrubTags(node: unknown, counts: Counts): unknown {
  if (Array.isArray(node)) {
    const tagArray = node.length > 0 && node.every(isTagLike);
    const tagIdArray = node.length > 0 && node.every(isTagIdLike);
    if (tagArray || tagIdArray) {
      const kept = node.filter((t) => !isDeniedTag(t as Parameters<typeof isDeniedTag>[0]));
      counts.tagsRemoved += node.length - kept.length;
      return kept.map((t) => scrubTags(t, counts));
    }
    return node.map((x) => scrubTags(x, counts));
  }
  if (typeof node === "object" && node !== null) {
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = scrubTags(v, counts);
    if (typeof out.subtype === "string" && typeof out.entityId === "string" && Array.isArray(out.tags) && isPersonEntity({ subtype: out.subtype })) {
      counts.tagsRemoved += (out.tags as unknown[]).length;
      out.tags = [];
    }
    return out;
  }
  return node;
}

function scrubSecrets(sheet: StreetSheet, counts: Counts): StreetSheet {
  const ledger = sheet.ledger.map((e) => {
    const params: typeof e.params = {};
    for (const [k, v] of Object.entries(e.params ?? {})) {
      if (SECRET_KEY_RE.test(k) && typeof v === "string" && v !== "" && !ENV_REF_RE.test(v)) {
        params[k] = "[redacted]";
        counts.secretsRedacted += 1;
      } else {
        params[k] = v;
      }
    }
    const curl = (e.curl ?? "")
      .replace(CURL_HEADER_RE, (_m, head: string) => {
        counts.secretsRedacted += 1;
        return `${head}[redacted]`;
      })
      .replace(CURL_QUERY_RE, (_m, head: string) => {
        counts.secretsRedacted += 1;
        return `${head}[redacted]`;
      });
    return { ...e, params, curl };
  });
  return { ...sheet, ledger };
}

/** The sheet after the tag and secret pass, with counts. Never mutates its input. */
export function sanitizeSheet(sheet: StreetSheet): { sheet: StreetSheet; tagsRemoved: number; secretsRedacted: number } {
  const counts: Counts = { tagsRemoved: 0, secretsRedacted: 0 };
  const tagged = scrubTags(sheet, counts) as StreetSheet;
  const clean = scrubSecrets({ ...tagged, ledger: tagged.ledger ?? [] }, counts);
  return { sheet: clean, ...counts };
}

export function sheetJsonDocument(stored: StreetSheet, opts: SheetJsonOptions = {}): SheetJsonDocument {
  const sheet = withoutControl(stored);
  const doSanitize = opts.sanitize ?? true;
  const s = doSanitize ? sanitizeSheet(sheet) : null;
  const body: StreetSheet = s ? s.sheet : { ...sheet, ledger: sheet.ledger ?? [] };
  return {
    format: SHEET_JSON_FORMAT,
    formatVersion: SHEET_JSON_VERSION,
    planId: sheet.planId,
    mode: sheet.mode,
    hypothetical: sheet.hypothetical,
    ...(sheet.mode === "fixture" ? { notice: FIXTURE_NOTICE } : {}),
    sanitized: s ? { tagsRemoved: s.tagsRemoved, secretsRedacted: s.secretsRedacted } : null,
    sheet: body,
  };
}

/** sheet.json text: the sheet with its full ledger. Ends with a newline. */
export function toSheetJson(sheet: StreetSheet, opts: SheetJsonOptions = {}): string {
  return `${JSON.stringify(sheetJsonDocument(sheet, opts), null, (opts.pretty ?? true) ? 2 : undefined)}\n`;
}
