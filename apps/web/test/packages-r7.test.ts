/**
 * Round 7, web exports: the A4 PDF downloads under its own name, so saving both sizes never gives
 * "street-sheet (1).pdf". Synthetic fixture sheet; nothing reaches the network.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { exportResponse } from "../lib/server/exports";

const sheet = JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/synthetic/engine/g3.sheet.json", import.meta.url)), "utf8")).sheet as StreetSheet;

describe("PDF file names by page size", () => {
  it("ends the A4 file in -street-sheet-a4.pdf and leaves the letter file as it was", async () => {
    const name = (r: Response) => /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "";
    const letter = name(await exportResponse(sheet, "pdf"));
    const a4 = name(await exportResponse(sheet, "pdf", { pageSize: "A4" }));
    expect(letter).toMatch(/-g3-street-sheet\.pdf$/);
    expect(a4).toBe(letter.replace(/\.pdf$/, "-a4.pdf"));
    expect(name(await exportResponse(sheet, "partners"))).toMatch(/-g3-partners\.csv$/);
  }, 120_000);
});
