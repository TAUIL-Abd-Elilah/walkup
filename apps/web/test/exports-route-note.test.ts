/**
 * The plan page's partner table on a hosted one-day sheet (deploy/vercel/plans.json, git-ignored: skipped when
 * absent): a partner the Saturday route has no time for says so after its hours, as partners.csv and
 * street-team.ics do.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StreetSheet } from "@walkup/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
vi.mock("../components/LiftMap", () => ({
  LiftMap: () => createElement("figure", { "data-testid": "map" }),
  squareSizeLine: () => "Each square is about 1.0 km by 0.6 km.",
}));
vi.mock("../components/LiftLegend", () => ({ LiftLegend: () => null }));
vi.mock("../components/TileList", () => ({ TileList: () => null }));

const { PlanView } = await import("../components/plan/PlanView");

const PLANS = fileURLToPath(new URL("../../../deploy/vercel/plans.json", import.meta.url));
const sheet = existsSync(PLANS) ? (JSON.parse(readFileSync(PLANS, "utf8")) as { planId: string; sheet: StreetSheet }[]).find((p) => p.planId.startsWith("1e0da01d"))?.sheet : undefined;

describe("plan page partner hours", () => {
  it.skipIf(!existsSync(PLANS) || !sheet)("1e0da01d: says which partners the Saturday route has no time for, after their hours", () => {
    const html = renderToStaticMarkup(
      createElement(PlanView, {
        payload: { sheet: sheet!, note: null, source: "preset", presetId: sheet!.planId },
        line: null,
        realShow: true,
        paired: null,
        runtimeLive: false,
        recorded: true,
        canRerun: false,
      }),
    );
    // The table cell and the phone-width line under the name.
    expect(html).toContain(">10 am to 2 pm; no time left on the route: call to arrange<");
    expect(html).toContain("Sat 10 am to 2 pm; no time left on the route: call to arrange");
    expect(html).toContain("11:30 am to 11 pm; no time left on the first pass: call to arrange");
    expect(html.match(/no time left on the (route|first pass): call to arrange/g)).toHaveLength(4);
  });
});
