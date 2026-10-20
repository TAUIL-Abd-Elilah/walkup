/**
 * Server-side state for the two-step send. The default is in memory (one
 * process); inject another implementation for a shared store. Methods may be
 * sync or async. The store never sees an email address or a raw IP: pending
 * entries hold the rendered message and attachments, keys are hashed.
 */
import type { AttachmentFile } from "./attachments";

export type MaybePromise<T> = T | Promise<T>;

/** What prepareSend rendered, waiting for confirm. Contains no recipient address. */
export interface PendingSend {
  planId: string;
  subject: string;
  text: string;
  html: string;
  attachments: AttachmentFile[];
  /** Epoch ms; the store may drop the entry after this. */
  expiresAtMs: number;
}

export interface SendStore {
  putPending(tokenId: string, pending: PendingSend): MaybePromise<void>;
  /** Returns and deletes the pending entry (single read). */
  takePending(tokenId: string): MaybePromise<PendingSend | undefined>;
  /** Marks a token as used. Returns false when it was already used (a replay). */
  markUsed(tokenId: string, expiresAtMs: number): MaybePromise<boolean>;
  /** Sends already counted for this requester key on this UTC day ("YYYY-MM-DD"). */
  sendsToday(requesterKey: string, day: string): MaybePromise<number>;
  /** Counts one send if the requester is under `cap`. Check and increment must be atomic. */
  reserveSend(requesterKey: string, day: string, cap: number): MaybePromise<{ allowed: boolean; count: number }>;
}

export interface MemorySendStoreOptions {
  /** Clock for pruning (tests). Default Date.now. */
  now?: () => number;
  /**
   * Most prepared sends held at once (each holds the rendered PDF and files).
   * Past it the oldest pending send is dropped, and its confirm is refused as
   * "no longer on this server". Default DEFAULT_MAX_PENDING.
   */
  maxPending?: number;
}

/** Default bound on pending sends in the in-memory store, so repeated prepares cannot grow memory without limit. */
export const DEFAULT_MAX_PENDING = 256;

/** In-memory store. Expired pending entries and used-token marks are pruned on each write. */
export function createMemorySendStore(opts: MemorySendStoreOptions = {}): SendStore {
  const now = opts.now ?? Date.now;
  const maxPending = Math.max(1, Math.floor(opts.maxPending ?? DEFAULT_MAX_PENDING));
  const pending = new Map<string, PendingSend>();
  const used = new Map<string, number>();
  const counts = new Map<string, number>();
  let countsDay = "";

  const prune = () => {
    const t = now();
    for (const [k, p] of pending) if (p.expiresAtMs < t) pending.delete(k);
    for (const [k, exp] of used) if (exp < t) used.delete(k);
  };
  const rollDay = (day: string) => {
    if (day !== countsDay) {
      counts.clear();
      countsDay = day;
    }
  };

  return {
    putPending(tokenId, p) {
      prune();
      // Map keeps insertion order: the first key is the oldest pending send.
      while (pending.size >= maxPending) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      pending.set(tokenId, p);
    },
    takePending(tokenId) {
      const p = pending.get(tokenId);
      pending.delete(tokenId);
      return p;
    },
    markUsed(tokenId, expiresAtMs) {
      prune();
      if (used.has(tokenId)) return false;
      used.set(tokenId, expiresAtMs);
      return true;
    },
    sendsToday(requesterKey, day) {
      rollDay(day);
      return counts.get(requesterKey) ?? 0;
    },
    reserveSend(requesterKey, day, cap) {
      rollDay(day);
      const n = counts.get(requesterKey) ?? 0;
      if (n >= cap) return { allowed: false, count: n };
      counts.set(requesterKey, n + 1);
      return { allowed: true, count: n + 1 };
    },
  };
}

/** UTC calendar day for the per-requester cap. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
