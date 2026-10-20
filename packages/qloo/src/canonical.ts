/**
 * Canonical request keys: method + path + params sorted by name, arrays joined
 * with "," in the order given. The key never contains the API key (that is a
 * header), so it is safe to log, cache on, and hash into a fixture name.
 */
import { createHash } from "node:crypto";
import type { Params, QlooRequest } from "./types";

export type CleanValue = string | number | boolean | string[];

/** Drops null, undefined, "", NaN and empty arrays; trims strings and array items. */
export function cleanParams(params: Params): Record<string, CleanValue> {
  const out: Record<string, CleanValue> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      const t = v.trim();
      if (t !== "") out[k] = t;
    } else if (typeof v === "number") {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === "boolean") {
      out[k] = v;
    } else if (Array.isArray(v)) {
      const items = v.map((x) => String(x).trim()).filter((x) => x !== "");
      if (items.length > 0) out[k] = items;
    }
  }
  return out;
}

export function serializeValue(v: CleanValue): string {
  if (Array.isArray(v)) return v.join(",");
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortedEntries(params: Params): [string, CleanValue][] {
  return Object.entries(cleanParams(params)).sort(([a], [b]) => byCodeUnit(a, b));
}

/** JSON with object keys sorted recursively (arrays keep their order). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort(byCodeUnit);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
}

export function canonicalKey(req: Pick<QlooRequest, "method" | "path" | "params">): string {
  const qs = sortedEntries(req.params)
    .map(([k, v]) => `${k}=${serializeValue(v)}`)
    .join("&");
  return `GET ${req.path}?${qs}`;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** encodeURIComponent, but keeps "," and ":" readable (URNs, lists) and escapes "!" (shell-safe in curl). */
export function encodeComponent(s: string): string {
  return encodeURIComponent(s).replace(/%2C/gi, ",").replace(/%3A/gi, ":").replace(/!/g, "%21");
}

/** Query string in canonical (sorted) order. */
export function encodeQuery(params: Params): string {
  return sortedEntries(params)
    .map(([k, v]) => `${encodeComponent(k)}=${encodeComponent(serializeValue(v))}`)
    .join("&");
}
