// @ts-check
// Checks config/tags.json: shape (per tags.schema.json), status rules, and the
// denied namespaces mirrored from packages/contracts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** @param {string} rel */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const config = JSON.parse(read("../tags.json"));
const schema = JSON.parse(read("../tags.schema.json"));
const contracts = read("../../packages/contracts/src/index.ts");

const REQUIRED_CATEGORIES = [
  "bar",
  "pub",
  "sports_bar",
  "irish_pub",
  "restaurant",
  "cafe",
  "record_store",
  "book_store",
  "barber_shop",
  "beauty_salon",
  "clothing_store",
  "night_club",
  "place_of_worship",
  "soul_food",
];
const GROUPS = ["categories", "baselines", "sponsorExclusions", "personChecks"];

/** Config JSON is untyped input under test, so entries are loose records (`any`) on purpose. */
/** @typedef {Record<string, any>} Entry */

/**
 * Reads a `export const NAME = [ "...", ... ] as const;` string array from the contracts source.
 * @param {string} name
 * @returns {string[]}
 */
function contractArray(name) {
  const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(contracts);
  assert.ok(m, `${name} not found in packages/contracts/src/index.ts`);
  return [...String(m[1]).matchAll(/"([^"]*)"/g)].map((x) => String(x[1]));
}

/** @returns {Entry[]} */
const entries = () => GROUPS.flatMap((g) => config[g].map((/** @type {Entry} */ e) => ({ group: g, ...e })));

test("top-level shape matches the schema", () => {
  assert.equal(config.$schema, "./tags.schema.json");
  for (const key of schema.required) assert.ok(key in config, `missing ${key}`);
  for (const key of Object.keys(config)) assert.ok(key in schema.properties, `unexpected top-level key ${key}`);
  assert.equal(config.version, 1);
  for (const g of GROUPS) assert.ok(Array.isArray(config[g]), `${g} must be an array`);
});

test("every category to pin is present exactly once", () => {
  const keys = config.categories.map((/** @type {Entry} */ e) => e.key);
  assert.deepEqual([...keys].sort(), [...REQUIRED_CATEGORIES].sort());
  const all = entries().map((e) => e.key);
  assert.equal(new Set(all).size, all.length, "keys must be unique across groups");
});

test("entries have exactly the schema's fields with valid values", () => {
  const def = schema.$defs.pinnedTag;
  const allowed = new Set(Object.keys(def.properties));
  for (const e of entries()) {
    const { group, ...entry } = e;
    for (const key of def.required) assert.ok(key in entry, `${group}.${e.key}: missing ${key}`);
    for (const key of Object.keys(entry)) assert.ok(allowed.has(key), `${group}.${e.key}: unexpected field ${key}`);
    assert.match(entry.key, /^[a-z][a-z0-9_]*$/);
    assert.ok(entry.label.length > 0 && entry.query.length > 0);
    assert.ok(entry.usedBy.length > 0);
    for (const u of entry.usedBy) assert.match(u, /^(Q[0-9]+|P[0-9]+)$/);
    assert.ok(def.properties.status.enum.includes(entry.status), `${e.key}: bad status ${entry.status}`);
    for (const c of entry.candidates ?? []) assert.match(c, /^urn:tag:/);
  }
});

test("status rules: unpinned is all null, pinned is complete and validated", () => {
  const minRows = config.validation.minRows;
  for (const e of entries()) {
    if (e.status === "unpinned") {
      assert.equal(e.urn, null, `${e.key}`);
      assert.equal(e.pinnedAt, null, `${e.key}`);
      assert.equal(e.validatedRows, null, `${e.key}`);
    }
    if (e.status === "pinned") {
      // Baselines are validated by heatmap cells near a hero room, the other groups by rows.
      const floor = e.group === "baselines" ? config.validation.baselineMinCells : minRows;
      assert.match(e.urn, /^urn:tag:/, `${e.key}: pinned needs a urn`);
      assert.ok(!Number.isNaN(Date.parse(e.pinnedAt)), `${e.key}: pinnedAt must be an ISO time`);
      assert.ok(Number.isInteger(e.validatedRows) && e.validatedRows >= floor, `${e.key}: needs >= ${floor} validated rows`);
    }
    if (e.status === "dropped") {
      assert.ok(!Number.isNaN(Date.parse(e.pinnedAt)), `${e.key}: dropped needs the date it was checked`);
      assert.ok(Number.isInteger(e.validatedRows), `${e.key}: dropped needs the row count it got`);
    }
  }
});

test("denied namespaces and keywords mirror packages/contracts exactly", () => {
  assert.deepEqual(config.denied.prefixes, contractArray("DENIED_TAG_PREFIXES"));
  assert.deepEqual(config.denied.keywords, contractArray("DENIED_TAG_KEYWORDS"));
});

test("no pinned or candidate URN falls in a denied namespace", () => {
  const prefixes = contractArray("DENIED_TAG_PREFIXES");
  const keywords = contractArray("DENIED_TAG_KEYWORDS");
  for (const e of entries()) {
    for (const urn of [e.urn, ...(e.candidates ?? [])].filter(Boolean)) {
      for (const p of prefixes) assert.ok(!urn.startsWith(p), `${e.key}: ${urn} is in denied namespace ${p}`);
      for (const k of keywords) assert.ok(!urn.toLowerCase().includes(k), `${e.key}: ${urn} contains denied keyword ${k}`);
    }
  }
});

test("baselines: comedy never gets a genre baseline, and each is read by Q5", () => {
  assert.ok(Array.isArray(config.baselines), "baselines must be an array");
  assert.ok(Number.isInteger(config.validation.baselineMinCells) && config.validation.baselineMinCells >= 1);
  for (const e of config.baselines) {
    // Probe 19 (Oct 15): the stand-up comedy tag heatmap came back with 0 cells near a club.
    assert.ok(!/comed|stand.?up/i.test(`${e.key} ${e.query} ${e.urn ?? ""}`), `${e.key}: comedy gets no genre baseline`);
    assert.ok(e.usedBy.includes("Q5"), `${e.key}: a baseline is read by Q5`);
  }
});

test("Oct 15 pins: categories that passed validation are pinned, the ones that failed are dropped", () => {
  const status = Object.fromEntries(config.categories.map((/** @type {Entry} */ e) => [e.key, e.status]));
  const pinned = ["bar", "pub", "sports_bar", "restaurant", "cafe", "book_store", "barber_shop", "beauty_salon", "clothing_store", "night_club", "soul_food"];
  for (const k of pinned) assert.equal(status[k], "pinned", k);
  for (const k of ["irish_pub", "record_store", "place_of_worship"]) assert.equal(status[k], "dropped", k);
});
