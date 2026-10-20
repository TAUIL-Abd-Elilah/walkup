/**
 * A static copy of the hero sheets, for when the main host is down. Loads each page in Chromium, waits for it to
 * draw, and saves the rendered HTML with the scripts taken out: the drawn map stays, the street map, dialogs,
 * sending and new plans are off, and a note at the top says so. Downloads (PDF, ics, CSVs, sheet.json) are fetched
 * separately (see docs/deploy.md, "Static mirror").
 *
 * Usage: node deploy/mirror/mirror.mjs <base> <outDir> <planIdA> <planIdB> [<planId>...]
 * The first two plan ids are what the g1-a and g1-b preset links point at. Needs playwright-core and a Chromium
 * (CHROMIUM_PATH, default the Playwright one).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const [base, out, ...ids] = process.argv.slice(2);
const saved = new Date().toISOString().slice(0, 10);
const pages = ["/", "/system-card", "/eval", ...ids.flatMap((id) => [`/plan/${id}`, `/s/${id}`])];
const keep = new Set(pages);
const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ["--no-sandbox"], proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true })).newPage();
const report = [];
for (const path of pages) {
  const res = await page.goto(base + path, { waitUntil: "networkidle", timeout: 90000 });
  if (!res || res.status() !== 200) { report.push(`${path} ${res?.status()} SKIPPED`); keep.delete(path); continue; }
  await page.waitForFunction(() => !document.body.innerText.includes("while the street map loads"), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  report.push(`${path} ok`);
}
const external = new Map();
for (const path of [...keep]) {
  await page.goto(base + path, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForTimeout(800);
  const html = await page.evaluate(([base, keepList, ids, saved]) => {
    const keep = new Set(keepList);
    // Scripts, script preloads and the live map canvas go; the drawn map underneath stays.
    document.querySelectorAll("script, link[rel=modulepreload], link[as=script], next-route-announcer").forEach((e) => e.remove());
    document.querySelectorAll(".maplibregl-map").forEach((m) => m.closest("div.absolute.inset-0")?.remove());
    document.querySelectorAll("input, textarea, button, select").forEach((e) => e.setAttribute("disabled", ""));
    // The header's mode line: this copy is not live.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const modeNodes = [];
    while (walker.nextNode()) if (/^\s*Live data/.test(walker.currentNode.textContent ?? "")) modeNodes.push(walker.currentNode);
    for (const n of modeNodes) n.textContent = `Recorded live data · static copy, ${saved}`;
    const rewritten = [];
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (!href || !href.startsWith("/")) continue;
      let [p, hash] = href.split("#");
      // Preset links open the stored hero runs (the first two plan ids).
      if (/^\/plan\/g1-a(\?|$)/.test(p)) p = `/plan/${ids[0]}`;
      if (/^\/plan\/g1-b(\?|$)/.test(p)) p = `/plan/${ids[1]}`;
      const pathOnly = p.split("?")[0];
      const exportFile = /^\/api\/sheet\/([^/]+)\/(pdf|ics|partners\.csv|zips\.csv|pins\.csv|offer-codes\.csv|sheet\.json)$/.exec(pathOnly);
      if (keep.has(pathOnly) || (exportFile && ids.includes(exportFile[1]))) { a.setAttribute("href", pathOnly + (hash ? `#${hash}` : "")); continue; }
      a.setAttribute("href", base + href);
      rewritten.push(pathOnly);
    }
    const bar = document.createElement("div");
    bar.setAttribute("role", "note");
    bar.style.cssText = "border-bottom:1px solid #d0d0d0;background:#fff;color:#111;font:14px/1.45 system-ui,sans-serif;padding:10px 16px;";
    bar.innerHTML = `<strong>Static copy</strong> of <a href="${base}" style="color:#b42318">walkup-agent.fly.dev</a>, saved ${saved}. The sheets, numbers and downloads are as recorded there. Here the street map, receipt dialogs, sending and new plans are off; use the live site for those.`;
    document.body.prepend(bar);
    return { html: "<!doctype html>\n" + document.documentElement.outerHTML, rewritten };
  }, [base, [...keep], ids, saved]);
  for (const r of html.rewritten) external.set(r, (external.get(r) ?? 0) + 1);
  const file = path === "/" ? join(out, "index.html") : join(out, path, "index.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html.html);
}
await browser.close();
console.log(report.join("\n"));
console.log("links sent to the live site:", JSON.stringify([...external.entries()]));
