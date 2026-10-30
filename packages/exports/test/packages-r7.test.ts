/**
 * Round 7, exports: a "your list" row in partners.csv gives the type and that day's hours from the place's own Qloo
 * record and says why it has no area, as offer-codes.csv does; the PDF hours cell keeps each time with its am/pm.
 * Synthetic data.
 */
import { describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { DECLARED_AREA, DECLARED_NO_TYPE } from "../src/format";
import { keepTimesWhole } from "../src/pdf";
import { offerCodeRows, partnersCsv } from "../src/tables";
import { parseCsvObjects } from "./csv-parse";
import { makeSheet, qlooHours, tag } from "./helpers";

function withBarbershop(): StreetSheet {
  const s = makeSheet();
  s.cards.declared.results = s.cards.declared.results.map((d) =>
    d.entity && d.declared.label === "Hilltop Record Club"
      ? {
          ...d,
          entity: {
            ...d.entity,
            tags: [tag("urn:tag:category:place:barber_shop", "Barber shop")],
            properties: { address: "412 Example Rd", hours: qlooHours({ thursday: [["09:00", "19:00"]], saturday: [["09:00", "17:00"]] }) },
          },
        }
      : d,
  );
  return s;
}

describe("your list rows", () => {
  it("fill the type, the area words and the hours in partners.csv", () => {
    const rows = parseCsvObjects(partnersCsv(withBarbershop())).filter((r) => r.list === "your list");
    expect(rows).toHaveLength(3);
    const hilltop = rows.find((r) => r.name === "Hilltop Record Club")!;
    expect(hilltop.category).toBe("Barbershop");
    expect(hilltop.hours_on_day).toMatch(/^[A-Z][a-z]{2} 9 am to [57] pm$/);
    const unranked = rows.find((r) => r.name === "Alumni chapter (operator contact)")!;
    expect(unranked.category).toBe(DECLARED_NO_TYPE);
    expect(unranked.hours_on_day).toBe("Hours not listed: call first");
    for (const r of rows) {
      expect(r.tile).toBe(DECLARED_AREA);
      expect(r.category).not.toBe("");
      expect(r.hours_on_day).not.toBe("");
    }
  });

  it("say the same area words in offer-codes.csv", () => {
    const rows = offerCodeRows(withBarbershop()).filter((r) => r.channel === "your list");
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.tile).toBe(DECLARED_AREA);
  });
});

describe("PDF hours cell", () => {
  it("joins each time to its am/pm with a no-break space", () => {
    expect(keepTimesWhole("Thu 7:30 am to 2:30 pm")).toBe("Thu 7:30 am to 2:30 pm");
    expect(keepTimesWhole("Hours not listed: call first")).toBe("Hours not listed: call first");
  });
});
