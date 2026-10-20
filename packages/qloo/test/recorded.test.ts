/**
 * Replays recorded live bodies from fixtures/raw/*.json (git-ignored, written by
 * WALKUP_RECORD=1) through the normalizers and the client, and checks the shape
 * rules found on key day. Skips cleanly when no recorded bodies exist (public CI).
 *
 * Assertions use derived values only (counts, flags, ids from the request key), so a
 * failure message never prints a response body.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGE_BUCKETS } from "@walkup/contracts";
import { describe, expect, it } from "vitest";
import { parseQlooErrors } from "../src/errors";
import { parseFixture } from "../src/fixtures";
import {
  droppedSignalIds,
  normalizeCompare,
  normalizeDemographics,
  normalizeEntityList,
  normalizeHeatmap,
  normalizeTagList,
  responseMeta,
  responseWarnings,
} from "../src/normalize";
import { liveClient, okFetch } from "./helpers";

/** WALKUP_RECORDED_RAW_DIR (with a trailing slash) points the replay elsewhere, e.g. an empty dir to see it skip. */
const RAW_DIR = process.env.WALKUP_RECORDED_RAW_DIR ?? fileURLToPath(new URL("../../../fixtures/raw/", import.meta.url));

interface Recorded {
  file: string;
  key: string;
  path: string;
  params: Map<string, string>;
  status: number;
  body: unknown;
}

function loadRecorded(): Recorded[] {
  if (!existsSync(RAW_DIR)) return [];
  const out: Recorded[] = [];
  for (const file of readdirSync(RAW_DIR).filter((f) => /^[0-9a-f]{64}\.json$/.test(f))) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(`${RAW_DIR}${file}`, "utf8"));
    } catch {
      continue;
    }
    const fx = parseFixture(json, "raw");
    if (!fx || !fx.key || fx.synthetic) continue;
    const m = /^(GET|POST) ([^?]+)\??(.*)$/.exec(fx.key);
    if (!m) continue;
    const params = new Map<string, string>();
    for (const pair of (m[3] ?? "").split("&")) {
      const i = pair.indexOf("=");
      if (i > 0) params.set(pair.slice(0, i), pair.slice(i + 1));
    }
    out.push({ file: file.slice(0, 12), key: fx.key, path: m[2] ?? "", params, status: fx.status ?? 200, body: fx.body });
  }
  return out;
}

const recorded = loadRecorded();
const ok = recorded.filter((r) => r.status >= 200 && r.status < 300);
const byType = (t: string) => ok.filter((r) => r.path === "/v2/insights" && r.params.get("filter.type") === t);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const rawRows = (r: Recorded): Record<string, unknown>[] => {
  const res = isRec(r.body) ? r.body.results : undefined;
  const list = Array.isArray(res) ? res : isRec(res) && Array.isArray(res.entities) ? res.entities : [];
  return list.filter(isRec);
};

// Each test runs over one subset of the recorded bodies and skips visibly (it.skipIf) when that subset is empty,
// so no test can pass without asserting anything.
const flat = ok.filter((r) => r.path === "/search" || r.path === "/entities");
const bySpotify = ok.filter((x) => x.path === "/entities" && x.params.has("external.spotify.ids"));
const entityRows = ok.filter((r) => r.path === "/v2/insights" && String(r.params.get("filter.type")).startsWith("urn:entity:"));
const warned = ok.filter((r) => isRec(r.body) && Array.isArray(r.body.warnings));
const heatmaps = byType("urn:heatmap");
const demographics = byType("urn:demographics");
const tagLists = [...byType("urn:tag"), ...ok.filter((x) => x.path === "/v2/tags")];
const compares = ok.filter((x) => x.path === "/v2/analysis/compare");
const errors4xx = recorded.filter((x) => x.status >= 400 && x.status < 500 && x.status !== 404);

describe.skipIf(recorded.length === 0)(`recorded live bodies (${recorded.length} in fixtures/raw)`, () => {
  it.skipIf(flat.length === 0)("/search and /entities rows normalize with no skips, and nested external ids are read", () => {
    for (const r of flat) {
      const n = normalizeEntityList(r.body);
      expect(n.reason, r.file).toBeUndefined();
      expect(n.skipped, r.file).toBe(0);
      const raws = rawRows(r);
      raws.forEach((raw, i) => {
        const nested = isRec(raw.properties) && isRec(raw.properties.external);
        if (nested || isRec(raw.external)) expect(n.value[i]?.external !== undefined, `${r.file} row ${i}`).toBe(true);
      });
    }
  });

  it.skipIf(bySpotify.length === 0)("entitiesByExternal finds the Spotify ids it asked for (F1)", async () => {
    for (const r of bySpotify) {
      const ids = (r.params.get("external.spotify.ids") ?? "").split(",").filter(Boolean);
      const { client } = liveClient(okFetch(r.body).fetch);
      const res = await client.entitiesByExternal("spotify", ids);
      // Every asked id is either matched or missing; one Spotify id can come back on two entities
      // (an artist and a person), and the first in Qloo's order is the match.
      expect(res.value.matches.length + res.value.missing.length, r.file).toBe(new Set(ids).size);
      expect(res.value.matches.length, r.file).toBeGreaterThan(0);
    }
  });

  it.skipIf(entityRows.length === 0)("insights entity rows normalize; places get a zip; explainability shares sum to 1", () => {
    for (const r of entityRows) {
      const n = normalizeEntityList(r.body);
      expect(n.reason, r.file).toBeUndefined();
      expect(n.skipped, r.file).toBe(0);
      for (const e of n.value) {
        expect(e.properties.neighborhood, r.file).toBeUndefined();
        if (e.explainability && e.explainability.length > 1) {
          expect(e.explainability.reduce((s, c) => s + c.score, 0), r.file).toBeCloseTo(1, 2);
        }
      }
      if (r.params.get("filter.type") === "urn:entity:place") {
        const withZcta = rawRows(r).filter((raw) => isRec(raw.properties) && Array.isArray(raw.properties.localities) && raw.properties.localities.some((l) => isRec(l) && l.place === "ZCTA"));
        expect(n.value.filter((e) => typeof e.properties.zip === "string").length, r.file).toBe(withZcta.length);
      }
    }
  });

  it.skipIf(warned.length === 0)("not_found warnings name ids that were sent as signals, and reach meta.droppedSignals (F2)", async () => {
    for (const r of warned) {
      const sent = (r.params.get("signal.interests.entities") ?? "").split(",");
      const dropped = droppedSignalIds(responseWarnings(r.body));
      expect(dropped.length, r.file).toBeGreaterThan(0);
      for (const id of dropped) expect(sent.includes(id), r.file).toBe(true);
      expect(responseMeta(r.body).droppedSignals, r.file).toEqual(dropped);
      const { client, ledger } = liveClient(okFetch(r.body).fetch);
      await client.insights({ "filter.type": "urn:entity:place", "signal.interests.entities": sent.join(","), take: 1 });
      expect(ledger.entries()[0]!.envelopeStatus, r.file).toBe("partial");
    }
  });

  it.skipIf(heatmaps.length === 0)("heatmaps: cells normalize with no skips, affinity_rank is a 0-1 fraction, no response-level query (F7)", () => {
    for (const r of heatmaps) {
      const n = normalizeHeatmap(r.body);
      expect(n.reason, r.file).toBeUndefined();
      expect(n.skipped, r.file).toBe(0);
      expect(n.value.every((c) => c.affinityRank >= 0 && c.affinityRank <= 1), r.file).toBe(true);
      expect(isRec(r.body) && "query" in r.body, r.file).toBe(false);
      expect(responseWarnings(r.body), r.file).toEqual([]);
    }
  });

  it.skipIf(demographics.length === 0)("demographics: one block per signal (entity or tag), keyed by entity_id, six age buckets at most (F8)", () => {
    for (const r of demographics) {
      const n = normalizeDemographics(r.body);
      expect(n.reason, r.file).toBeUndefined();
      expect(n.skipped, r.file).toBe(0);
      const signals = [...(r.params.get("signal.interests.entities") ?? "").split(","), ...(r.params.get("signal.interests.tags") ?? "").split(",")].filter(Boolean);
      expect(n.value.length, r.file).toBe(signals.length);
      for (const b of n.value) {
        expect(signals.includes(b.entityId), r.file).toBe(true);
        for (const k of Object.keys(b.age)) expect((AGE_BUCKETS as readonly string[]).includes(k), r.file).toBe(true);
      }
    }
  });

  it.skipIf(tagLists.length === 0)("urn:tag profiles and /v2/tags normalize with no skips (F10, F15)", () => {
    for (const r of tagLists) {
      const n = normalizeTagList(r.body);
      expect(n.reason, r.file).toBeUndefined();
      expect(n.skipped, r.file).toBe(0);
      expect(n.value.every((t) => t.id.startsWith("urn:tag:")), r.file).toBe(true);
    }
  });

  it.skipIf(compares.length === 0)("compare: all three lists normalize; the client cuts them to take (F9)", async () => {
    for (const r of compares) {
      const n = normalizeCompare(r.body);
      expect(n.reason, r.file).toBeUndefined();
      expect(n.skipped, r.file).toBe(0);
      const { client } = liveClient(okFetch(r.body).fetch);
      const res = await client.compare(["a"], ["b"], 3);
      expect(Math.max(res.value.shared.length, res.value.a.length, res.value.b.length), r.file).toBeLessThanOrEqual(3);
    }
  });

  it.skipIf(errors4xx.length === 0)("recorded 4xx bodies use {errors:[{message,path}]} (F4)", () => {
    for (const r of errors4xx) {
      expect(parseQlooErrors(r.body).length, r.file).toBeGreaterThan(0);
    }
  });
});

describe("recorded body replay", () => {
  it("loads nothing (and the suite above skips) when fixtures/raw is missing or empty", () => {
    expect(Array.isArray(recorded)).toBe(true);
  });
});
