// @ts-check
// Checks config/chains.json: shape (per chains.schema.json), one entry per brand, no name or alias
// claimed twice, and no bare common word that would mark local places as chains.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** @param {string} rel */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const config = JSON.parse(read("../chains.json"));
const schema = JSON.parse(read("../chains.schema.json"));

/** Config JSON is untyped input under test, so entries are loose records (`any`) on purpose. */
/** @typedef {Record<string, any>} Entry */

/** The matcher's normalization (packages/engine/src/chains.ts), repeated here so the file can be checked alone. */
/** @param {string} s */
const norm = (s) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’‘`´.]/g, "")
    .replace(/[&+]/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the (?=\S)/, "");

test("top-level shape matches the schema", () => {
  assert.equal(config.$schema, "./chains.schema.json");
  for (const key of schema.required) assert.ok(key in config, `missing ${key}`);
  for (const key of Object.keys(config)) assert.ok(key in schema.properties, `unexpected top-level key ${key}`);
  assert.equal(config.version, 1);
  assert.match(config.about, /hand-kept/i, "about must say the list is kept by hand");
  assert.ok(!Number.isNaN(Date.parse(config.reviewedAt)), "reviewedAt must be a date");
  assert.ok(Array.isArray(config.chains));
});

test("about 100 to 200 brands, each with exactly the schema's fields", () => {
  const def = schema.$defs.chain;
  const allowed = new Set(Object.keys(def.properties));
  assert.ok(config.chains.length >= 100 && config.chains.length <= 200, `${config.chains.length} brands`);
  for (const /** @type {Entry} */ e of config.chains) {
    for (const key of def.required) assert.ok(key in e, `${e.name}: missing ${key}`);
    for (const key of Object.keys(e)) assert.ok(allowed.has(key), `${e.name}: unexpected field ${key}`);
    assert.ok(typeof e.name === "string" && e.name.trim() === e.name && e.name.length > 0, `bad name ${JSON.stringify(e.name)}`);
    assert.ok(def.properties.kind.enum.includes(e.kind), `${e.name}: bad kind ${e.kind}`);
    if ("aliases" in e) {
      assert.ok(Array.isArray(e.aliases) && e.aliases.length > 0, `${e.name}: aliases must be a non-empty array`);
      for (const a of e.aliases) assert.ok(typeof a === "string" && a.trim() === a && a.length > 0, `${e.name}: bad alias`);
    }
    if ("exact" in e) assert.equal(e.exact, true, `${e.name}: exact is true or absent`);
  }
});

test("no name or alias is claimed twice, and every one normalizes to something", () => {
  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const /** @type {Entry} */ e of config.chains) {
    for (const raw of [e.name, ...(e.aliases ?? [])]) {
      const k = norm(raw);
      assert.ok(k.length > 0, `${e.name}: ${raw} normalizes to nothing`);
      const prev = owner.get(k);
      assert.ok(prev === undefined || prev === e.name, `${raw} (${e.name}) is already ${prev}`);
      owner.set(k, e.name);
    }
  }
});

test("a one-word brand that is also a common word or a place name matches only as a whole name", () => {
  // Bare words a local business name often starts with. A one-word key like this must be `exact`.
  const common = new Set(["target", "gap", "burlington", "express", "ross", "sonic", "pret", "paul", "uno", "pandora", "journeys", "hollister", "cosi", "loft", "champs", "seasons", "jerrys"]);
  for (const /** @type {Entry} */ e of config.chains) {
    for (const raw of [e.name, ...(e.aliases ?? [])]) {
      const words = norm(raw).split(" ");
      if (common.has(words[0] ?? "") && words.length === 1) assert.equal(e.exact, true, `${raw}: a common first word needs exact: true or a longer name`);
    }
  }
});
