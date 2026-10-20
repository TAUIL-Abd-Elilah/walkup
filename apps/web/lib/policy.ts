import { DENIED_TAG_KEYWORDS, DENIED_TAG_PREFIXES } from "@walkup/contracts";

/** Mirrors the engine's denylist so the UI can refuse to render a denied tag even if one slips through. */
export function isDeniedTag(tag: { id: string; name?: string }): boolean {
  const id = tag.id.toLowerCase();
  const name = (tag.name ?? "").toLowerCase();
  if (DENIED_TAG_PREFIXES.some((p) => id.startsWith(p))) return true;
  return DENIED_TAG_KEYWORDS.some((k) => id.includes(k) || name.includes(k));
}
