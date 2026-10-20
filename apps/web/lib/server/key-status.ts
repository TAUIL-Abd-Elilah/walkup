/**
 * A Qloo key that Qloo has deactivated still "looks live" from env alone. When
 * a live run sees Qloo answer 401 or 403, the server records it here
 * (${WALKUP_DATA_DIR}/qloo-key-status.json) and runs in fixture mode for
 * the rest of the process and after restarts, until a different key is set.
 * Only a short hash of the key is stored, never the key.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEntry } from "@walkup/contracts";
import { dataDir, type Env } from "./env";

export interface KeyStatus {
  status: "rejected";
  httpStatus: number;
  at: string;
  /** First 12 hex of sha256(key): a new key clears the status. */
  keyHash: string;
}

const FILE = "qloo-key-status.json";
let memo: { file: string; value: KeyStatus | null } | null = null;

export function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function statusFile(env: Env): string {
  return join(dataDir(env), FILE);
}

/** The recorded rejection for the current key, or null. */
export function qlooKeyRejection(env: Env = process.env): KeyStatus | null {
  const key = (env.QLOO_API_KEY ?? "").trim();
  if (!key) return null;
  const file = statusFile(env);
  if (!memo || memo.file !== file) {
    let value: KeyStatus | null = null;
    try {
      if (existsSync(file)) value = JSON.parse(readFileSync(file, "utf8")) as KeyStatus;
    } catch {
      value = null;
    }
    memo = { file, value };
  }
  const v = memo.value;
  return v && v.status === "rejected" && v.keyHash === keyHash(key) ? v : null;
}

/** A fresh (not cached) Qloo answer that shows the key was accepted. */
function keyAccepted(e: LedgerEntry): boolean {
  if (e.kind !== "qloo" || e.cacheHit || e.httpStatus === null) return false;
  return (e.httpStatus >= 200 && e.httpStatus < 300) || e.httpStatus === 404;
}

/**
 * Records a rejection if this run's ledger shows Qloo rejecting the key. Returns true when it did.
 *
 * 401 always counts. 403 counts only when no fresh Qloo call in the same run was accepted:
 * Qloo also answers 403 for a single request whose filter.type the key may not use ("You do
 * not have permission to access urn:entity:..."), and that must not switch the whole server
 * to fixture mode for good.
 */
export function noteQlooRejection(entries: readonly LedgerEntry[], env: Env = process.env, now: () => number = Date.now): boolean {
  const key = (env.QLOO_API_KEY ?? "").trim();
  if (!key) return false;
  const qloo = entries.filter((e) => e.kind === "qloo");
  const hit =
    qloo.find((e) => e.httpStatus === 401) ??
    (qloo.some(keyAccepted) ? undefined : qloo.find((e) => e.httpStatus === 403));
  if (!hit || hit.httpStatus === null) return false;
  const value: KeyStatus = { status: "rejected", httpStatus: hit.httpStatus, at: new Date(now()).toISOString(), keyHash: keyHash(key) };
  const file = statusFile(env);
  try {
    mkdirSync(dataDir(env), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(`${file}.tmp`, file);
  } catch {
    // Read-only disk: the in-memory memo still switches this process to fixture mode.
  }
  memo = { file, value };
  return true;
}

/** Tests only. */
export function resetKeyStatusMemo(): void {
  memo = null;
}
