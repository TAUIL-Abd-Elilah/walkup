// @ts-check
// Checks skills/walkup against the Agent Skills format and our own safety rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";

const SKILLS_DIR = fileURLToPath(new URL("..", import.meta.url));
const ALLOWED_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);

function skillDirs() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SKILLS_DIR, d.name, "SKILL.md")))
    .map((d) => join(SKILLS_DIR, d.name));
}

/**
 * Minimal frontmatter reader: one `key: value` per line; `metadata` must be single-line JSON.
 * @param {string} dir
 */
function readSkill(dir) {
  const text = readFileSync(join(dir, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, "SKILL.md must start with a --- frontmatter block");
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of match[1].split("\n")) {
    if (!line.trim()) continue;
    const m = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line);
    assert.ok(m, `frontmatter line is not "key: value": ${line}`);
    fields[String(m[1])] = String(m[2]);
  }
  return { text, fields, body: String(match[2]) };
}

test("there is at least one skill", () => {
  assert.ok(skillDirs().length >= 1);
});

for (const dir of skillDirs()) {
  const dirName = basename(dir);

  test(`${dirName}: frontmatter follows the Agent Skills spec`, () => {
    const { fields } = readSkill(dir);
    for (const key of Object.keys(fields)) assert.ok(ALLOWED_KEYS.has(key), `unexpected frontmatter key: ${key}`);
    assert.equal(fields.name, dirName, "name must equal the directory name");
    assert.match(fields.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(fields.name.length <= 64);
    assert.ok(fields.description && fields.description.length >= 1, "description is required");
    assert.ok(fields.description.length <= 1024, `description is ${fields.description.length} chars (max 1024)`);
    assert.doesNotMatch(fields.description, /[<>]/, "no angle brackets in the description");
    if (fields.compatibility) assert.ok(fields.compatibility.length <= 500);
  });

  test(`${dirName}: metadata.openclaw declares env and binaries`, () => {
    const { fields } = readSkill(dir);
    const metadata = JSON.parse(fields.metadata);
    const requires = metadata?.openclaw?.requires;
    assert.ok(requires, "metadata.openclaw.requires is required");
    assert.ok(Array.isArray(requires.env) && requires.env.includes("WALKUP_URL"));
    assert.ok(Array.isArray(requires.bins) && requires.bins.includes("curl"));
    assert.equal(metadata.clawdbot, undefined, "use the openclaw key, not the legacy one");
  });

  test(`${dirName}: body has the required sections and stays short`, () => {
    const { text, body } = readSkill(dir);
    for (const heading of ["## Subcommands", "## What this sends", "## NEVER do", "## Common errors", "## Coverage map"]) {
      assert.ok(body.includes(heading), `missing section: ${heading}`);
    }
    assert.ok(text.split("\n").length < 500, "SKILL.md should stay under 500 lines");
  });

  test(`${dirName}: promises no partner count and never says the product or Qloo is gone`, () => {
    const { text, body } = readSkill(dir);
    assert.doesNotMatch(text, /15\s*(-|–|to)\s*25/, "no partner-count promise");
    const sources = [text, ...[...body.matchAll(/\{baseDir\}\/(scripts\/[\w./-]+)/g)].map((m) => readFileSync(join(dir, m[1]), "utf8"))];
    for (const src of sources) assert.doesNotMatch(src, /no longer available|Qloo (is )?unavailable|new plans are off/i);
  });

  test(`${dirName}: referenced scripts exist and are safe`, () => {
    const { body } = readSkill(dir);
    const refs = [...body.matchAll(/\{baseDir\}\/(scripts\/[\w./-]+)/g)].map((m) => m[1]);
    assert.ok(refs.length > 0, "the body should show how to call the bundled script");
    for (const ref of new Set(refs)) {
      const path = join(dir, ref);
      assert.ok(existsSync(path), `missing script: ${ref}`);
      const src = readFileSync(path, "utf8");
      assert.doesNotMatch(src, /child_process/, `${ref} must not spawn processes`);
      assert.doesNotMatch(src, /\beval\s*\(/, `${ref} must not eval`);
      assert.doesNotMatch(src, /new\s+Function\s*\(/, `${ref} must not build functions from strings`);
      assert.doesNotMatch(src, /\bimport\s*\(/, `${ref} must not import code at runtime`);
      const envReads = [...src.matchAll(/process\.env(?:\.([A-Za-z_]\w*)|\[\s*["']([^"']+)["']\s*\])/g)].map((m) => m[1] ?? m[2]);
      assert.deepEqual([...new Set(envReads)], ["WALKUP_URL"], `${ref} may read only WALKUP_URL`);
      // Every mention of process.env must be one of those named reads: no aliasing
      // (`const env = process.env`), destructuring or spreading the environment.
      const mentions = [...src.matchAll(/process\s*\.\s*env\b/g)].length;
      assert.equal(mentions, envReads.length, `${ref} must not alias, destructure or spread process.env`);
      assert.doesNotMatch(src, /\bprocess\s*\[/, `${ref} must not reach process properties dynamically`);
    }
  });
}
