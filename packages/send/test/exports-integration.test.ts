/**
 * The default exporters call @walkup/exports. Runs on a synthetic fixture
 * sheet (fixtures/synthetic, "synthetic": true) with a mocked Resend client.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryLedger, type StreetSheet } from "@walkup/contracts";
import { confirmSend, defaultExporters, prepareSend } from "../src/index";
import { clock, freshStore, liveConfig, mockResend } from "./helpers";

function loadFixtureSheet(): StreetSheet {
  const url = new URL("../../../fixtures/synthetic/g1-a.sheet.json", import.meta.url);
  const doc = JSON.parse(readFileSync(url, "utf8")) as { synthetic: boolean; sheet: StreetSheet };
  expect(doc.synthetic).toBe(true);
  return doc.sheet;
}

describe("default exporters (@walkup/exports)", () => {
  it("builds the PDF, the .ics and partners.csv and sends them", async () => {
    const sheet = loadFixtureSheet();
    const c = clock();
    const store = freshStore(c.now);
    const config = liveConfig();
    const r = await prepareSend({ sheet, requesterIp: "203.0.113.50" }, { config, store, now: c.now });
    expect(r.status).toBe("ready");
    if (r.status !== "ready") return;
    expect(r.preview.attachmentFailures).toEqual([]);
    expect(r.preview.attachments.map((a) => a.filename)).toEqual(["fixture-street-sheet.pdf", "fixture-street-team.ics", "fixture-partners.csv"]);

    const client = mockResend();
    const out = await confirmSend(r.confirmToken, { config, store, now: c.now, ledger: createMemoryLedger(), mailClient: client });
    expect(out.status).toBe("sent");
    const atts = (client.calls[0]!.payload as unknown as { attachments: { filename: string; content: Buffer }[] }).attachments;
    const [pdf, ics, csv] = atts.map((a) => Buffer.from(a.content));
    expect(pdf!.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(ics!.toString("utf8")).toContain("BEGIN:VCALENDAR");
    expect(csv!.toString("utf8")).toContain("call_order");
  }, 60_000);

  it("are plain functions over a sheet", async () => {
    const sheet = loadFixtureSheet();
    expect(typeof (await defaultExporters.ics(sheet))).toBe("string");
    expect(typeof (await defaultExporters.partners(sheet))).toBe("string");
  });
});
