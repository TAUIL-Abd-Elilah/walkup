/**
 * Private response cache (better-sqlite3). Keyed by the canonical request.
 * Lives in WALKUP_DATA_DIR (default ./.cache, git-ignored); never under
 * fixtures/. Qloo allows private server-side caching; bodies are never committed.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { RequestClass } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Per request class TTL: lookups 30 d, heatmaps/insights/compare 7 d. */
export const DEFAULT_TTL_MS: Record<RequestClass, number> = {
  search: 30 * DAY_MS,
  entities: 30 * DAY_MS,
  tags: 30 * DAY_MS,
  audiences: 30 * DAY_MS,
  insights: 7 * DAY_MS,
  heatmap: 7 * DAY_MS,
  compare: 7 * DAY_MS,
};

export interface CacheEntry {
  body: string;
  status: number;
  storedAt: number;
  expiresAt: number;
}

export interface QlooCache {
  /** Returns null when missing or expired at `now`. */
  get(key: string, now: number): CacheEntry | null;
  set(key: string, cls: RequestClass, entry: { body: string; status: number }, now: number): void;
  getMeta(name: string): string | null;
  setMeta(name: string, value: string): void;
  /** Deletes expired rows; returns how many. */
  prune(now: number): number;
  close(): void;
}

export interface SqliteCacheOptions {
  ttlMs?: Partial<Record<RequestClass, number>>;
}

interface Row {
  body: string;
  status: number;
  stored_at: number;
  expires_at: number;
}

/** `file` may be ":memory:" (tests). Parent directories are created. */
export function createSqliteCache(file: string, opts: SqliteCacheOptions = {}): QlooCache {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS responses (
      key TEXT PRIMARY KEY,
      cls TEXT NOT NULL,
      body TEXT NOT NULL,
      status INTEGER NOT NULL,
      stored_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const ttl: Record<RequestClass, number> = { ...DEFAULT_TTL_MS, ...opts.ttlMs };
  const getStmt = db.prepare<[string], Row>("SELECT body, status, stored_at, expires_at FROM responses WHERE key = ?");
  const setStmt = db.prepare<[string, string, string, number, number, number]>(
    "INSERT OR REPLACE INTO responses (key, cls, body, status, stored_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const pruneStmt = db.prepare<[number]>("DELETE FROM responses WHERE expires_at <= ?");
  const getMetaStmt = db.prepare<[string], { value: string }>("SELECT value FROM meta WHERE name = ?");
  const setMetaStmt = db.prepare<[string, string]>("INSERT OR REPLACE INTO meta (name, value) VALUES (?, ?)");

  return {
    get(key, now) {
      const row = getStmt.get(key);
      if (!row || row.expires_at <= now) return null;
      return { body: row.body, status: row.status, storedAt: row.stored_at, expiresAt: row.expires_at };
    },
    set(key, cls, entry, now) {
      setStmt.run(key, cls, entry.body, entry.status, now, now + ttl[cls]);
    },
    getMeta(name) {
      return getMetaStmt.get(name)?.value ?? null;
    },
    setMeta(name, value) {
      setMetaStmt.run(name, value);
    },
    prune(now) {
      return pruneStmt.run(now).changes;
    },
    close() {
      db.close();
    },
  };
}
