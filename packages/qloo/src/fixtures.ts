/**
 * Fixture recorder and replayer.
 *  - Live mode with WALKUP_RECORD=1 writes bodies to fixtures/raw/<sha256>.json
 *    (git-ignored: real Qloo bodies are never committed).
 *  - Fixture mode reads fixtures/raw/<sha256>.json, then fixtures/synthetic/<sha256>.json.
 *    Synthetic files must carry "synthetic": true at the top level; files without it are ignored.
 * <sha256> is sha256(canonicalKey(request)); see fixtureFileName().
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalKey, sha256Hex } from "./canonical";
import type { QlooRequest } from "./types";

export type FixtureOrigin = "raw" | "synthetic";

export interface FixtureRecord {
  key: string | null;
  status: number | null;
  body: unknown;
  synthetic: boolean;
  origin: FixtureOrigin;
  recordedAt?: string;
}

export interface FixtureWrite {
  key: string;
  status: number;
  body: unknown;
  recordedAt: string;
}

export interface FixtureStore {
  read(hash: string): FixtureRecord | null;
  /** Writes to raw/ only. Never writes synthetic fixtures. */
  write(hash: string, rec: FixtureWrite): void;
  has(hash: string): boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Accepts either a wrapper {key?, status?, body, synthetic?} or a bare response body.
 * Synthetic-origin files must say synthetic: true.
 */
export function parseFixture(json: unknown, origin: FixtureOrigin): FixtureRecord | null {
  if (!isRecord(json)) return null;
  const synthetic = json.synthetic === true;
  if (origin === "synthetic" && !synthetic) return null;
  if ("body" in json) {
    return {
      key: typeof json.key === "string" ? json.key : null,
      status: typeof json.status === "number" ? json.status : null,
      body: json.body,
      synthetic,
      origin,
      ...(typeof json.recordedAt === "string" ? { recordedAt: json.recordedAt } : {}),
    };
  }
  return { key: null, status: null, body: json, synthetic, origin };
}

export function fixtureHash(req: Pick<QlooRequest, "method" | "path" | "params">): string {
  return sha256Hex(canonicalKey(req));
}

export function fixtureFileName(req: Pick<QlooRequest, "method" | "path" | "params">): string {
  return `${fixtureHash(req)}.json`;
}

/** The file content to place in fixtures/synthetic/ for a request (for fixture authors). */
export function syntheticFixtureFor(
  req: Pick<QlooRequest, "method" | "path" | "params">,
  body: unknown,
  note = "Synthetic body shaped like a Qloo response; not Qloo data.",
): { fileName: string; content: string } {
  const doc = { synthetic: true, note, key: canonicalKey(req), status: 200, body };
  return { fileName: fixtureFileName(req), content: `${JSON.stringify(doc, null, 2)}\n` };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Files under <dir>/raw and <dir>/synthetic. */
export function createFileFixtureStore(dir: string): FixtureStore {
  const rawDir = join(dir, "raw");
  const synDir = join(dir, "synthetic");
  return {
    read(hash) {
      for (const [d, origin] of [
        [rawDir, "raw"],
        [synDir, "synthetic"],
      ] as const) {
        const file = join(d, `${hash}.json`);
        if (!existsSync(file)) continue;
        const rec = parseFixture(readJson(file), origin);
        if (rec) return rec;
      }
      return null;
    },
    write(hash, rec) {
      mkdirSync(rawDir, { recursive: true });
      writeFileSync(join(rawDir, `${hash}.json`), `${JSON.stringify(rec)}\n`, "utf8");
    },
    has(hash) {
      return existsSync(join(rawDir, `${hash}.json`)) || existsSync(join(synDir, `${hash}.json`));
    },
  };
}

/** In-memory store for tests. `written` exposes what the recorder wrote. */
export function createMemoryFixtureStore(
  initial: { raw?: Record<string, unknown>; synthetic?: Record<string, unknown> } = {},
): FixtureStore & { written: Map<string, FixtureWrite> } {
  const raw = new Map(Object.entries(initial.raw ?? {}));
  const syn = new Map(Object.entries(initial.synthetic ?? {}));
  const written = new Map<string, FixtureWrite>();
  return {
    written,
    read(hash) {
      if (raw.has(hash)) {
        const rec = parseFixture(raw.get(hash), "raw");
        if (rec) return rec;
      }
      if (syn.has(hash)) return parseFixture(syn.get(hash), "synthetic");
      return null;
    },
    write(hash, rec) {
      written.set(hash, rec);
      raw.set(hash, rec);
    },
    has(hash) {
      return raw.has(hash) || syn.has(hash);
    },
  };
}
