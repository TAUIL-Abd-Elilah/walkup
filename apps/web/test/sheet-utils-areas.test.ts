import { describe, expect, it } from "vitest";
import { buildSheetModel } from "@walkup/exports/sheet-model";
import { areaName, compareBills, topTiles } from "../lib/sheet-utils";
import { makeMultiStateSheet } from "../../../packages/exports/test/helpers";

describe("area names on the plan page", () => {
  it("carry each area's own state, the same labels as the street sheet and the PDF (DC room, MD and VA areas)", () => {
    const sheet = makeMultiStateSheet();
    const top = topTiles(sheet);
    expect(top.map((t) => t.name)).toEqual(["Silver Spring, MD", "Arlington, VA", "Capitol Hill, DC"]);
    expect(top.map((t) => t.name)).toEqual(buildSheetModel(sheet).panel1.tiles.map((t) => t.name));
    expect(compareBills(sheet, sheet).a?.name).toBe("Silver Spring, MD");
  });

  it("add the state once, before a distance suffix, and leave a name without ZIPs alone", () => {
    expect(areaName({ name: "Arlington", zctas: ["22201"] })).toBe("Arlington, VA");
    expect(areaName({ name: "Arlington, VA", zctas: ["22201"] })).toBe("Arlington, VA");
    expect(areaName({ name: "Nashville-Davidson, 17 km west", zctas: ["37209"] })).toBe("Nashville-Davidson, TN, 17 km west");
    expect(areaName({ name: "Woodbine" })).toBe("Woodbine");
    expect(areaName(undefined, 2)).toBe("Area 2");
  });
});
