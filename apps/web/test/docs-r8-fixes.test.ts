/**
 * Round 8, docs: .env.example lists WALKUP_RECORDED_REVISE and deploy.md no longer says it is missing there; the MCP
 * README quotes the Allow value the server sends on OPTIONS and every 405; the web README says /api/sheet/<id> carries
 * revision and parentPlanId at the top, as the code builds it; the fifth pass says the Checks step on the two Anthem
 * revisions counts the dropped "cozy" or "intimate" copy line as a claim the run didn't back.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SystemCardPage from "../app/system-card/page";

const ROOT = new URL("../../../", import.meta.url);
const raw = (path: string) => readFileSync(new URL(path, ROOT), "utf8");
const doc = (path: string) => raw(path).replace(/\s+/g, " ");
const pageText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");

describe("WALKUP_RECORDED_REVISE", () => {
  it("is in .env.example, commented out, and deploy.md's row no longer says it isn't", () => {
    expect(raw(".env.example")).toMatch(/^# WALKUP_RECORDED_REVISE=off +recorded mode: /m);
    const row = raw("docs/deploy.md").split("\n").find((l) => l.startsWith("| `WALKUP_RECORDED_REVISE` |")) ?? "";
    expect(row).toContain("plain env, optional");
    expect(row).not.toContain("not in `.env.example`");
    // The value the docs give is one the server reads as off.
    expect(raw("apps/web/lib/server/recorded.ts")).toContain('["off", "0", "false", "no"]');
  });
});

describe("the MCP README's Allow value", () => {
  it("is the one the handler and the /mcp route send", () => {
    const http = raw("packages/mcp/src/http.ts");
    const allow = /export const MCP_ALLOW = "([^"]+)";/.exec(http)?.[1];
    expect(allow).toBe("POST, OPTIONS");
    // The /mcp route's OPTIONS sends the package's constant.
    expect(raw("apps/web/app/mcp/route.ts")).toContain("allow: MCP_ALLOW");
    const readme = doc("packages/mcp/README.md");
    expect(readme).toContain(`PUT and PATCH get the same JSON-RPC 405 with \`Allow: ${allow}\`. OPTIONS answers 204 with the same \`Allow\`.`);
    expect(readme).not.toMatch(/`Allow: POST`/);
  });
});

describe("the sheet envelope of a revision", () => {
  it("is documented with top-level revision and parentPlanId, as both envelopes build it", () => {
    const row = raw("apps/web/README.md").split("\n").find((l) => l.startsWith("| `GET /api/sheet/[id]` |")) ?? "";
    expect(row).toContain("a revision adds `revision` and `parentPlanId` at the top, as MCP `get_sheet` does");
    expect(raw("apps/web/lib/api.ts")).toContain("...(sheet.revision ? { revision: sheet.revision, parentPlanId: sheet.revision.parentPlanId } : {})");
    expect(doc("packages/mcp/README.md")).not.toContain("keeps the revision in results.revision only");
  });
});

describe("the fifth pass and the Checks step", () => {
  it("says the dropped room-size copy line now counts as a claim the run didn't back", () => {
    const card = pageText(renderToStaticMarkup(createElement(SystemCardPage)));
    for (const text of [doc("README.md"), doc("docs/system-card.md"), card]) {
      expect(text).toMatch(/\(it wrote 3, and the checks kept 2\), and their Checks step counts the dropped "cozy" or "intimate" line as a claim the run didn't back/);
    }
    expect(doc("docs/deploy-vercel.md")).toContain('the Checks step counts a dropped "cozy" or "intimate" copy line as a claim the run didn\'t back');
    // The engine counts that drop the same way (packages/engine/src/steps.ts).
    expect(raw("packages/engine/src/steps.ts")).toContain('[c.unbacked, "that made a claim the run didn\'t back"]');
  });
});
