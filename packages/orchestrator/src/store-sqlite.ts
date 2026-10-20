/**
 * SQLite plan store (better-sqlite3, a native module): import from server code
 * only, via "@walkup/orchestrator/sqlite". Table plans(planId, createdAt,
 * mode, json) holds one row per plan; choices holds the operator's cached picks.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { CHOICE_TTL_MS, choiceKey, type ChoiceStore, type PlanStore, type StoredPlan } from "./store";

export interface SqliteStores {
  plans: PlanStore;
  choices: ChoiceStore;
  close(): void;
}

/** `file` may be ":memory:". Parent directories are created. */
export function createSqliteStores(file: string): SqliteStores {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      planId TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL,
      mode TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS choices (
      key TEXT PRIMARY KEY,
      entityId TEXT NOT NULL,
      chosenAt INTEGER NOT NULL
    );
  `);
  const put = db.prepare<[string, string, string, string]>("INSERT OR REPLACE INTO plans (planId, createdAt, mode, json) VALUES (?, ?, ?, ?)");
  const get = db.prepare<[string], { json: string }>("SELECT json FROM plans WHERE planId = ?");
  const latest = db.prepare<[string], { json: string }>(
    "SELECT json FROM plans WHERE json_extract(json, '$.presetId') = ? AND json_extract(json, '$.status') = 'complete' ORDER BY createdAt DESC LIMIT 1",
  );
  const list = db.prepare<[number], { json: string }>("SELECT json FROM plans ORDER BY createdAt DESC LIMIT ?");
  const getChoice = db.prepare<[string], { entityId: string; chosenAt: number }>("SELECT entityId, chosenAt FROM choices WHERE key = ?");
  const setChoice = db.prepare<[string, string, number]>("INSERT OR REPLACE INTO choices (key, entityId, chosenAt) VALUES (?, ?, ?)");
  const deleteChoice = db.prepare<[string]>("DELETE FROM choices WHERE key = ?");
  const parse = (row: { json: string } | undefined): StoredPlan | null => (row ? (JSON.parse(row.json) as StoredPlan) : null);

  return {
    plans: {
      put(plan) {
        put.run(plan.planId, plan.createdAt, plan.mode, JSON.stringify(plan));
      },
      get(planId) {
        return parse(get.get(planId));
      },
      latestForPreset(presetId) {
        return parse(latest.get(presetId));
      },
      list(limit = 50) {
        return list.all(limit).map((r) => JSON.parse(r.json) as StoredPlan);
      },
    },
    choices: {
      get(query, types, now) {
        const r = getChoice.get(choiceKey(query, types));
        return r && now - r.chosenAt < CHOICE_TTL_MS ? r.entityId : null;
      },
      set(query, types, entityId, now) {
        setChoice.run(choiceKey(query, types), entityId, now);
      },
      delete(query, types) {
        deleteChoice.run(choiceKey(query, types));
      },
    },
    close() {
      db.close();
    },
  };
}

/** Just the plan store (table plans). */
export function createSqlitePlanStore(file: string): PlanStore & { close(): void } {
  const s = createSqliteStores(file);
  return { ...s.plans, close: () => s.close() };
}
