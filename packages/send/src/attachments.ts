/**
 * Attachments come from @walkup/exports: the file bytes, the file names
 * and the content types are all theirs, so a mailed file matches the download.
 * This module only picks the kinds, hashes the bytes and records failures.
 * Exporters are injectable for tests.
 */
import type { StreetSheet } from "@walkup/contracts";
import { EXPORT_CONTENT_TYPES, EXPORT_FILE_NAMES } from "@walkup/exports";
import { ATTACHMENT_KINDS, type AttachmentKind } from "./constants";
import { sha256Hex } from "./crypto";

/** The three exports a send can attach. Defaults call @walkup/exports (see default-exporters.ts). */
export interface SheetExporters {
  pdf(sheet: StreetSheet): Promise<Uint8Array> | Uint8Array;
  ics(sheet: StreetSheet): Promise<string> | string;
  partners(sheet: StreetSheet): Promise<string> | string;
}

export interface AttachmentFile {
  kind: AttachmentKind;
  filename: string;
  contentType: string;
  content: Uint8Array;
  bytes: number;
  sha256: string;
}

export interface AttachmentFailure {
  kind: AttachmentKind;
  filename: string;
  reason: string;
}

export const ATTACHMENT_LABELS: Readonly<Record<AttachmentKind, string>> = {
  pdf: "Street Sheet (PDF)",
  ics: "Street-team timeline (.ics)",
  partners: "Partner call list (CSV)",
};

/** Same names as the downloads: "street-sheet.pdf", "street-team.ics", "partners.csv", with "fixture-" in front on fixture sheets. */
export function attachmentFilename(kind: AttachmentKind, sheet: Pick<StreetSheet, "mode">): string {
  return `${sheet.mode === "fixture" ? "fixture-" : ""}${EXPORT_FILE_NAMES[kind]}`;
}

export type AttachmentKindsCheck = { ok: true; kinds: AttachmentKind[] } | { ok: false; reason: string };

/** Validates the requested kinds. Undefined means all three. Duplicates collapse; order follows ATTACHMENT_KINDS. */
export function checkAttachmentKinds(requested: unknown): AttachmentKindsCheck {
  if (requested === undefined || requested === null) return { ok: true, kinds: [...ATTACHMENT_KINDS] };
  if (!Array.isArray(requested)) return { ok: false, reason: "Attachments must be a list of: pdf, ics, partners." };
  const wanted = new Set<AttachmentKind>();
  for (const k of requested) {
    if (typeof k !== "string" || !(ATTACHMENT_KINDS as readonly string[]).includes(k)) {
      return { ok: false, reason: `Unknown attachment "${String(k).slice(0, 40)}". Use pdf, ics or partners.` };
    }
    wanted.add(k as AttachmentKind);
  }
  return { ok: true, kinds: ATTACHMENT_KINDS.filter((k) => wanted.has(k)) };
}

function toBytes(v: Uint8Array | string): Uint8Array {
  return typeof v === "string" ? new Uint8Array(Buffer.from(v, "utf8")) : v;
}

/**
 * Runs each requested exporter. A failing exporter does not stop the others;
 * it is reported in `failures` and left out, so the preview shows exactly
 * what would be attached.
 */
export async function renderAttachments(
  sheet: StreetSheet,
  kinds: AttachmentKind[],
  exporters: SheetExporters,
): Promise<{ files: AttachmentFile[]; failures: AttachmentFailure[] }> {
  const files: AttachmentFile[] = [];
  const failures: AttachmentFailure[] = [];
  for (const kind of kinds) {
    const filename = attachmentFilename(kind, sheet);
    try {
      const raw = kind === "pdf" ? await exporters.pdf(sheet) : kind === "ics" ? await exporters.ics(sheet) : await exporters.partners(sheet);
      const content = toBytes(raw);
      if (content.byteLength === 0) throw new Error("empty file");
      files.push({ kind, filename, contentType: EXPORT_CONTENT_TYPES[kind], content, bytes: content.byteLength, sha256: sha256Hex(content) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ kind, filename, reason: `could not build ${filename}: ${reason.slice(0, 200)}` });
    }
  }
  return { files, failures };
}
