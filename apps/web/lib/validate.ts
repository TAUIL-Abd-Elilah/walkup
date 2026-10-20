/**
 * Runtime validation for sheets the web app renders (fixtures today, live
 * engine output later). TypeScript proves the generator's shape; this proves
 * the JSON on disk still matches it and that every claim traces to the ledger.
 */
import type { EnvelopeStatus, StreetSheet } from "@walkup/contracts";
import { WEEKDAYS } from "@walkup/contracts";
import type { SheetFixture } from "./fixture-types";
import { isGeohash } from "./geohash";
import { isDeniedTag } from "./policy";

const ENVELOPE_STATUSES: readonly EnvelopeStatus[] = ["ok", "empty", "needs_input", "partial", "degraded", "error"];
const LEDGER_KINDS = ["qloo", "tm", "places", "acs", "anthropic", "action"] as const;
const RESOLUTION_STATUSES = ["exact", "needs_input", "proxy", "unresolved"] as const;
const ROLES = ["headliner", "co", "support", "venue", "house", "partner"] as const;
const LEDGER_PREFIX: Record<(typeof LEDGER_KINDS)[number], string> = {
  qloo: "Q",
  tm: "T",
  places: "P",
  acs: "C",
  anthropic: "L",
  action: "A",
};

/**
 * A key in a copy-as-curl: header or query form, for every source we call
 * (X-Api-Key, X-Goog-Api-Key, x-api-key, apikey=, api_key=, Census key=).
 * The captured value must be an env-var reference such as $CENSUS_API_KEY.
 */
export const CURL_SECRET_RE = /(?:api[-_]?key|\bkey)\s*[:=]\s*([^\s"'&]+)/gi;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Checker {
  errors: string[] = [];
  check(cond: boolean, path: string, msg: string): boolean {
    if (!cond) this.errors.push(`${path}: ${msg}`);
    return cond;
  }
  str(o: Obj, key: string, path: string, optional = false): void {
    const v = o[key];
    if (optional && v === undefined) return;
    this.check(typeof v === "string" && v.length > 0, `${path}.${key}`, "expected non-empty string");
  }
  num(o: Obj, key: string, path: string, opts: { nullable?: boolean; optional?: boolean; min?: number; max?: number } = {}): void {
    const v = o[key];
    if (opts.optional && v === undefined) return;
    if (opts.nullable && v === null) return;
    if (!this.check(typeof v === "number" && Number.isFinite(v), `${path}.${key}`, "expected finite number")) return;
    const n = v as number;
    if (opts.min !== undefined) this.check(n >= opts.min, `${path}.${key}`, `expected >= ${opts.min}, got ${n}`);
    if (opts.max !== undefined) this.check(n <= opts.max, `${path}.${key}`, `expected <= ${opts.max}, got ${n}`);
  }
  bool(o: Obj, key: string, path: string, nullable = false): void {
    const v = o[key];
    if (nullable && v === null) return;
    this.check(typeof v === "boolean", `${path}.${key}`, "expected boolean");
  }
  arr(o: Obj, key: string, path: string): unknown[] {
    const v = o[key];
    this.check(Array.isArray(v), `${path}.${key}`, "expected array");
    return Array.isArray(v) ? v : [];
  }
  obj(o: Obj, key: string, path: string): Obj {
    const v = o[key];
    this.check(isObj(v), `${path}.${key}`, "expected object");
    return isObj(v) ? v : {};
  }
  oneOf(o: Obj, key: string, allowed: readonly string[], path: string): void {
    const v = o[key];
    this.check(typeof v === "string" && allowed.includes(v), `${path}.${key}`, `expected one of ${allowed.join("|")}, got ${String(v)}`);
  }
}

function checkEntity(c: Checker, e: unknown, path: string): void {
  if (!c.check(isObj(e), path, "expected entity object")) return;
  const o = e as Obj;
  c.str(o, "entityId", path);
  c.str(o, "name", path);
  c.str(o, "subtype", path);
  c.check(typeof o.subtype === "string" && o.subtype.startsWith("urn:entity:"), `${path}.subtype`, "expected urn:entity:*");
  c.num(o, "popularity", path, { nullable: true, min: 0, max: 1 });
  c.num(o, "affinity", path, { nullable: true, min: 0, max: 1 });
  c.obj(o, "properties", path);
  c.arr(o, "tags", path).forEach((t, i) => {
    const tp = `${path}.tags[${i}]`;
    if (!c.check(isObj(t), tp, "expected tag")) return;
    const to = t as Obj;
    c.str(to, "id", tp);
    c.str(to, "name", tp);
    c.check(typeof to.id === "string" && to.id.startsWith("urn:tag:"), `${tp}.id`, "expected urn:tag:*");
    c.check(!isDeniedTag({ id: String(to.id), name: String(to.name) }), tp, `denied tag present (${String(to.id)})`);
  });
  if (o.location !== undefined) {
    const l = c.obj(o, "location", path);
    c.num(l, "lat", `${path}.location`, { min: -90, max: 90 });
    c.num(l, "lon", `${path}.location`, { min: -180, max: 180 });
  }
  if (o.explainability !== undefined) {
    c.arr(o, "explainability", path).forEach((x, i) => {
      const xp = `${path}.explainability[${i}]`;
      if (!c.check(isObj(x), xp, "expected contribution")) return;
      c.str(x as Obj, "entityId", xp);
      c.num(x as Obj, "score", xp, { min: 0, max: 1 });
    });
  }
}

function checkChips(c: Checker, o: Obj, path: string, ledgerIds: Set<string>): void {
  c.arr(o, "chips", path).forEach((chip, i) => {
    const cp = `${path}.chips[${i}]`;
    if (!c.check(isObj(chip), cp, "expected chip")) return;
    c.str(chip as Obj, "label", cp);
    const ref = (chip as Obj).ledgerRef;
    c.check(typeof ref === "string" && ledgerIds.has(ref), `${cp}.ledgerRef`, `unknown ledger ref ${String(ref)}`);
  });
}

function checkEnvelope(c: Checker, env: unknown, path: string, ledgerIds: Set<string>): Obj | null {
  if (!c.check(isObj(env), path, "expected envelope")) return null;
  const o = env as Obj;
  c.oneOf(o, "status", ENVELOPE_STATUSES, path);
  c.str(o, "summary", path);
  if (o.status !== "ok") c.str(o, "reason", path);
  c.arr(o, "provenance", path).forEach((ref, i) => {
    c.check(typeof ref === "string" && ledgerIds.has(ref), `${path}.provenance[${i}]`, `unknown ledger ref ${String(ref)}`);
  });
  c.arr(o, "limits", path).forEach((l, i) => c.check(typeof l === "string", `${path}.limits[${i}]`, "expected string"));
  c.check("results" in o, `${path}.results`, "missing results");
  return o;
}

function checkLedger(c: Checker, ledger: unknown[]): Set<string> {
  const ids = new Set<string>();
  ledger.forEach((e, i) => {
    const p = `ledger[${i}]`;
    if (!c.check(isObj(e), p, "expected ledger entry")) return;
    const o = e as Obj;
    c.str(o, "id", p);
    c.oneOf(o, "kind", LEDGER_KINDS, p);
    c.oneOf(o, "method", ["GET", "POST", "ACTION"], p);
    c.str(o, "endpoint", p);
    c.obj(o, "params", p);
    c.num(o, "httpStatus", p, { nullable: true });
    c.oneOf(o, "envelopeStatus", ENVELOPE_STATUSES, p);
    c.num(o, "latencyMs", p, { min: 0 });
    c.num(o, "bytes", p, { min: 0 });
    c.bool(o, "cacheHit", p);
    c.num(o, "resultCount", p, { min: 0 });
    c.check(typeof o.curl === "string", `${p}.curl`, "expected string");
    c.check(typeof o.startedAt === "string" && !Number.isNaN(Date.parse(o.startedAt)), `${p}.startedAt`, "expected ISO date");
    const id = String(o.id);
    const kind = o.kind as (typeof LEDGER_KINDS)[number];
    if (LEDGER_KINDS.includes(kind)) {
      c.check(new RegExp(`^${LEDGER_PREFIX[kind]}\\d+$`).test(id), `${p}.id`, `id ${id} does not match kind ${kind}`);
    }
    c.check(!ids.has(id), `${p}.id`, `duplicate ledger id ${id}`);
    ids.add(id);
    // Secrets must be env-var references, never values.
    const curl = String(o.curl);
    if (o.kind !== "action") c.check(curl.length > 0, `${p}.curl`, "copy-as-curl missing");
    for (const m of curl.matchAll(CURL_SECRET_RE)) {
      c.check((m[1] ?? "").startsWith("$"), `${p}.curl`, "API key must be an env var reference");
    }
    for (const [k, v] of Object.entries(isObj(o.params) ? o.params : {})) {
      if (/^(api_?key|key)$/i.test(k) && typeof v === "string") c.check(v.startsWith("$"), `${p}.params.${k}`, "secret must be an env var reference");
    }
  });
  return ids;
}

/** Validate a StreetSheet. Returns a list of human-readable errors (empty = valid). */
export function validateSheet(sheet: unknown): string[] {
  const c = new Checker();
  if (!c.check(isObj(sheet), "sheet", "expected object")) return c.errors;
  const s = sheet as Obj;
  c.str(s, "planId", "sheet");
  c.check(typeof s.createdAt === "string" && !Number.isNaN(Date.parse(s.createdAt)), "sheet.createdAt", "expected ISO date");
  c.oneOf(s, "mode", ["live", "fixture"], "sheet");
  c.bool(s, "hypothetical", "sheet");
  const ledgerIds = checkLedger(c, c.arr(s, "ledger", "sheet"));

  const bill = c.obj(s, "bill", "sheet");
  const acts = c.arr(bill, "acts", "sheet.bill");
  c.check(acts.length > 0, "sheet.bill.acts", "at least one act");
  acts.forEach((a, i) => {
    if (!c.check(isObj(a), `sheet.bill.acts[${i}]`, "expected act")) return;
    c.str(a as Obj, "name", `sheet.bill.acts[${i}]`);
    c.oneOf(a as Obj, "role", ["headliner", "co", "support"], `sheet.bill.acts[${i}]`);
  });
  const venue = c.obj(bill, "venue", "sheet.bill");
  c.str(venue, "name", "sheet.bill.venue");
  c.str(venue, "city", "sheet.bill.venue");
  c.num(venue, "lat", "sheet.bill.venue", { min: -90, max: 90 });
  c.num(venue, "lon", "sheet.bill.venue", { min: -180, max: 180 });
  c.check(typeof bill.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(bill.date), "sheet.bill.date", "expected YYYY-MM-DD");
  c.oneOf(bill, "weekday", WEEKDAYS, "sheet.bill");
  if (typeof bill.date === "string" && typeof bill.weekday === "string") {
    const d = new Date(`${bill.date}T12:00:00Z`);
    const wd = WEEKDAYS[(d.getUTCDay() + 6) % 7];
    c.check(wd === bill.weekday, "sheet.bill.weekday", `date ${bill.date} is a ${String(wd)}, not ${bill.weekday}`);
  }
  c.bool(bill, "legalAgeEnforced", "sheet.bill", true);

  const op = c.obj(s, "operator", "sheet");
  c.num(op, "seatsLeft", "sheet.operator", { nullable: true, min: 0 });
  c.num(op, "capacity", "sheet.operator", { nullable: true, min: 0 });
  c.num(op, "mediaBudgetUsd", "sheet.operator", { nullable: true, min: 0 });
  c.num(op, "radiusKm", "sheet.operator", { min: 1 });
  c.arr(op, "streetTeamDays", "sheet.operator").forEach((d, i) =>
    c.check(typeof d === "string" && (WEEKDAYS as readonly string[]).includes(d), `sheet.operator.streetTeamDays[${i}]`, "expected weekday"),
  );
  c.arr(op, "declaredPartners", "sheet.operator").forEach((d, i) => {
    if (c.check(isObj(d), `sheet.operator.declaredPartners[${i}]`, "expected object")) c.str(d as Obj, "label", `sheet.operator.declaredPartners[${i}]`);
  });

  const cards = c.obj(s, "cards", "sheet");
  const P = "sheet.cards";

  const res = checkEnvelope(c, cards.resolution, `${P}.resolution`, ledgerIds);
  if (res) {
    c.arr(res, "results", `${P}.resolution`).forEach((r, i) => {
      const rp = `${P}.resolution.results[${i}]`;
      if (!c.check(isObj(r), rp, "expected resolution")) return;
      const ro = r as Obj;
      c.str(ro, "input", rp);
      c.oneOf(ro, "role", ROLES, rp);
      c.oneOf(ro, "status", RESOLUTION_STATUSES, rp);
      if (ro.entity !== undefined) checkEntity(c, ro.entity, `${rp}.entity`);
      if (ro.status === "needs_input") {
        c.check(Array.isArray(ro.candidates) && ro.candidates.length > 1, `${rp}.candidates`, "needs_input requires 2+ candidates");
      }
      if (ro.status === "proxy") {
        const px = c.obj(ro, "proxy", rp);
        checkEntity(c, px.entity, `${rp}.proxy.entity`);
        c.str(px, "reason", `${rp}.proxy`);
      }
      if (ro.ledgerRef !== undefined) c.check(ledgerIds.has(String(ro.ledgerRef)), `${rp}.ledgerRef`, `unknown ledger ref ${String(ro.ledgerRef)}`);
    });
  }

  const tileHashes = new Set<string>();
  const lift = checkEnvelope(c, cards.liftMap, `${P}.liftMap`, ledgerIds);
  if (lift) {
    const lr = c.obj(lift, "results", `${P}.liftMap`);
    c.arr(lr, "tiles", `${P}.liftMap.results`).forEach((t, i) => {
      const tp = `${P}.liftMap.results.tiles[${i}]`;
      if (!c.check(isObj(t), tp, "expected tile")) return;
      const to = t as Obj;
      c.check(typeof to.geohash === "string" && to.geohash.length === 6 && isGeohash(to.geohash), `${tp}.geohash`, "expected geohash-6");
      c.check(!tileHashes.has(String(to.geohash)), `${tp}.geohash`, "duplicate tile");
      tileHashes.add(String(to.geohash));
      c.num(to, "lat", tp, { min: -90, max: 90 });
      c.num(to, "lon", tp, { min: -180, max: 180 });
      c.num(to, "lift", tp, { min: 0 });
      c.num(to, "billPct", tp, { min: 0, max: 1 });
      c.num(to, "housePct", tp, { min: 0, max: 1 });
      c.num(to, "popularityPct", tp, { min: 0, max: 1 });
    });
    const diag = c.obj(lr, "diagnostics", `${P}.liftMap.results`);
    c.num(diag, "spearmanLiftVsHeat", `${P}.liftMap.results.diagnostics`, { nullable: true, min: -1, max: 1 });
    c.oneOf(diag, "baseline", ["house", "tag", "none"], `${P}.liftMap.results.diagnostics`);
  }

  const partners = checkEnvelope(c, cards.partners, `${P}.partners`, ledgerIds);
  if (partners) {
    c.arr(partners, "results", `${P}.partners`).forEach((p, i) => {
      const pp = `${P}.partners.results[${i}]`;
      if (!c.check(isObj(p), pp, "expected partner")) return;
      const po = p as Obj;
      checkEntity(c, po.entity, `${pp}.entity`);
      if (po.tileGeohash !== null) {
        c.check(tileHashes.has(String(po.tileGeohash)), `${pp}.tileGeohash`, `tile ${String(po.tileGeohash)} not on the lift map`);
      }
      c.str(po, "category", pp);
      c.num(po, "score", pp, { min: 0, max: 1 });
      c.num(po, "qlooRank", pp, { min: 1 });
      if (po.chain !== undefined) c.bool(po, "chain", pp);
      checkChips(c, po, pp, ledgerIds);
    });
  }

  const declared = checkEnvelope(c, cards.declared, `${P}.declared`, ledgerIds);
  if (declared) {
    c.arr(declared, "results", `${P}.declared`).forEach((d, i) => {
      const dp = `${P}.declared.results[${i}]`;
      if (!c.check(isObj(d), dp, "expected declared score")) return;
      const dobj = d as Obj;
      const dec = c.obj(dobj, "declared", dp);
      c.str(dec, "label", `${dp}.declared`);
      c.num(dobj, "rank", dp, { nullable: true, min: 1 });
      if (dobj.entity !== undefined) checkEntity(c, dobj.entity, `${dp}.entity`);
      checkChips(c, dobj, dp, ledgerIds);
    });
  }

  const prePost = checkEnvelope(c, cards.prePost, `${P}.prePost`, ledgerIds);
  if (prePost) {
    c.arr(prePost, "results", `${P}.prePost`).forEach((x, i) => {
      const xp = `${P}.prePost.results[${i}]`;
      if (!c.check(isObj(x), xp, "expected spot")) return;
      const xo = x as Obj;
      checkEntity(c, xo.entity, `${xp}.entity`);
      c.num(xo, "deltaRank", xp, { nullable: true });
      c.num(xo, "expectedShare", xp, { min: 0, max: 1 });
      c.num(xo, "assumedCapacity", xp, { min: 0 });
      c.bool(xo, "fanFacingAllowed", xp);
      if (xo.chain !== undefined) c.bool(xo, "chain", xp);
      checkChips(c, xo, xp, ledgerIds);
    });
  }

  const media = checkEnvelope(c, cards.media, `${P}.media`, ledgerIds);
  if (media) {
    c.arr(media, "results", `${P}.media`).forEach((m, i) => {
      const mp = `${P}.media.results[${i}]`;
      if (!c.check(isObj(m), mp, "expected media pick")) return;
      const mo = m as Obj;
      checkEntity(c, mo.entity, `${mp}.entity`);
      c.oneOf(mo, "kind", ["podcast", "sponsor"], mp);
      c.oneOf(mo, "scope", ["local", "national"], mp);
      checkChips(c, mo, mp, ledgerIds);
    });
  }

  const demo = checkEnvelope(c, cards.demographics, `${P}.demographics`, ledgerIds);
  if (demo) {
    const dr = c.obj(demo, "results", `${P}.demographics`);
    c.arr(dr, "bill", `${P}.demographics.results`);
    c.arr(dr, "house", `${P}.demographics.results`);
  }

  const diff = checkEnvelope(c, cards.whatsDifferent, `${P}.whatsDifferent`, ledgerIds);
  if (diff) {
    const dr = c.obj(diff, "results", `${P}.whatsDifferent`);
    for (const side of ["shared", "a", "b"] as const) {
      c.arr(dr, side, `${P}.whatsDifferent.results`).forEach((t, i) => {
        const tp = `${P}.whatsDifferent.results.${side}[${i}]`;
        if (!c.check(isObj(t), tp, "expected tag")) return;
        c.str(t as Obj, "id", tp);
        c.check(!isDeniedTag({ id: String((t as Obj).id), name: String((t as Obj).name) }), tp, "denied tag present");
      });
    }
    c.bool(dr, "fromTagDiff", `${P}.whatsDifferent.results`);
  }

  const hooks = checkEnvelope(c, cards.copyHooks, `${P}.copyHooks`, ledgerIds);
  if (hooks) {
    c.arr(hooks, "results", `${P}.copyHooks`).forEach((h, i) => {
      const hp = `${P}.copyHooks.results[${i}]`;
      if (!c.check(isObj(h), hp, "expected hook")) return;
      c.str(h as Obj, "text", hp);
      const ids = c.arr(h as Obj, "tagIds", hp);
      c.check(ids.length > 0, `${hp}.tagIds`, "a hook must cite at least one tag");
      ids.forEach((id, j) => c.check(typeof id === "string" && !isDeniedTag({ id }), `${hp}.tagIds[${j}]`, "denied tag id"));
    });
  }

  const guard = c.obj(s, "guard", "sheet");
  c.num(guard, "dropped", "sheet.guard", { min: 0 });
  c.num(guard, "deniedTagCount", "sheet.guard", { min: 0 });
  c.arr(guard, "reasons", "sheet.guard");
  if (guard.deniedByNamespace !== undefined) {
    const by = c.obj(guard, "deniedByNamespace", "sheet.guard");
    for (const k of Object.keys(by)) c.num(by, k, "sheet.guard.deniedByNamespace", { min: 0 });
  }

  if (s.budgetSplit !== undefined) {
    const split = c.arr(s, "budgetSplit", "sheet");
    let total = 0;
    split.forEach((b, i) => {
      const bp = `sheet.budgetSplit[${i}]`;
      if (!c.check(isObj(b), bp, "expected split")) return;
      const bo = b as Obj;
      c.check(tileHashes.has(String(bo.geohash)), `${bp}.geohash`, "tile not on the lift map");
      c.num(bo, "share", bp, { min: 0, max: 1 });
      c.check(bo.label === "heuristic, not a forecast", `${bp}.label`, "must be labelled heuristic");
      total += typeof bo.share === "number" ? bo.share : 0;
    });
    if (split.length > 0) c.check(Math.abs(total - 1) < 0.011, "sheet.budgetSplit", `shares sum to ${total.toFixed(3)}, expected 1`);
  }

  if (s.popularityCheck !== undefined) {
    const pc = c.obj(s, "popularityCheck", "sheet");
    c.num(pc, "partners", "sheet.popularityCheck", { min: 1 });
    c.num(pc, "notInPopularTop", "sheet.popularityCheck", { min: 0 });
    let sumPartners = 0;
    let sumNotIn = 0;
    c.arr(pc, "perArea", "sheet.popularityCheck").forEach((a, i) => {
      const ap = `sheet.popularityCheck.perArea[${i}]`;
      if (!c.check(isObj(a), ap, "expected area")) return;
      const ao = a as Obj;
      if (ao.tileGeohash !== null) c.check(tileHashes.has(String(ao.tileGeohash)), `${ap}.tileGeohash`, "tile not on the lift map");
      c.num(ao, "partners", ap, { min: 1 });
      c.num(ao, "notInPopularTop", ap, { min: 0 });
      const k = ao.partners;
      const n = ao.notInPopularTop;
      if (typeof k === "number" && typeof n === "number") c.check(n <= k, `${ap}.notInPopularTop`, "more than the area's partners");
      c.check(ledgerIds.has(String(ao.ledgerRef)), `${ap}.ledgerRef`, "not in the ledger");
      sumPartners += typeof k === "number" ? k : 0;
      sumNotIn += typeof n === "number" ? n : 0;
    });
    c.check(pc.partners === sumPartners && pc.notInPopularTop === sumNotIn, "sheet.popularityCheck", "totals do not add up over the areas");
    c.arr(pc, "ledgerRefs", "sheet.popularityCheck").forEach((r, i) => c.check(ledgerIds.has(String(r)), `sheet.popularityCheck.ledgerRefs[${i}]`, "not in the ledger"));
  }

  if (s.narration !== undefined) {
    const n = c.obj(s, "narration", "sheet");
    c.str(n, "summary", "sheet.narration");
    c.bool(n, "templated", "sheet.narration");
    c.arr(n, "tileWhy", "sheet.narration").forEach((t, i) =>
      c.check(isObj(t) && tileHashes.has(String(t.geohash)), `sheet.narration.tileWhy[${i}]`, "cites a tile not on the map"),
    );
  }
  c.arr(s, "limits", "sheet");
  return c.errors;
}

/** Validate a fixture wrapper (a sheet, and on older files the Google Places list, which is no longer produced). */
export function validateFixture(fx: unknown): string[] {
  const c = new Checker();
  if (!c.check(isObj(fx), "fixture", "expected object")) return c.errors;
  const f = fx as Obj;
  c.check(f.synthetic === true, "fixture.synthetic", "fixtures must declare synthetic: true");
  c.str(f, "fixtureId", "fixture");
  c.str(f, "title", "fixture");
  c.str(f, "note", "fixture");
  const sheetErrors = validateSheet(f.sheet);
  const sheet = isObj(f.sheet) ? (f.sheet as unknown as StreetSheet) : null;
  if (f.control === undefined) return [...c.errors, ...sheetErrors];
  const ledgerIds = new Set((Array.isArray(sheet?.ledger) ? sheet.ledger : []).map((e) => e.id));
  const control = c.obj(f, "control", "fixture");
  c.oneOf(control, "arm", ["F", "S", "P", "L"], "fixture.control");
  const places = c.arr(control, "places", "fixture.control");
  places.forEach((p, i) => {
    const pp = `fixture.control.places[${i}]`;
    if (!c.check(isObj(p), pp, "expected place")) return;
    c.str(p as Obj, "placeId", pp);
    c.str(p as Obj, "name", pp);
    c.str(p as Obj, "query", pp);
  });
  const names = new Set(places.map((p) => (isObj(p) ? String(p.name) : "")));
  c.arr(control, "overlapWithQloo", "fixture.control").forEach((n, i) =>
    c.check(names.has(String(n)), `fixture.control.overlapWithQloo[${i}]`, `overlap name ${String(n)} is not in the control list`),
  );
  c.arr(control, "ledgerRefs", "fixture.control").forEach((r, i) =>
    c.check(ledgerIds.has(String(r)), `fixture.control.ledgerRefs[${i}]`, `unknown ledger ref ${String(r)}`),
  );
  return [...c.errors, ...sheetErrors];
}

/** Validates and returns the typed fixture, or throws with every error listed. */
export function assertFixture(fx: unknown, label = "fixture"): SheetFixture {
  const errors = validateFixture(fx);
  if (errors.length > 0) throw new Error(`${label} failed validation:\n- ${errors.join("\n- ")}`);
  return fx as SheetFixture;
}
