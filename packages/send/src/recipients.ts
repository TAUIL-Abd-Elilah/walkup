/**
 * Recipient rules.
 *
 * - The test inbox is the default, so nobody has to type anything.
 * - Every other address must be typed by the operator in this request and
 *   arrive flagged `typedByOperator: true`. Addresses from the sheet, from
 *   partner data or from an earlier request are refused.
 * - At most MAX_TYPED_RECIPIENTS typed addresses, syntax-checked, de-duplicated.
 * - Addresses are never stored or logged in full: the ledger gets `typed:<keyed hash>`.
 */
import { MAX_TYPED_RECIPIENTS, TEST_INBOX } from "./constants";
import { keyedId } from "./crypto";

/** One address the operator typed into this send request. */
export interface TypedRecipient {
  address: string;
  /** Must be literally `true`: the operator typed this address into this request. */
  typedByOperator: true;
}

export type RecipientSource = "test_inbox" | "typed";

export interface Recipient {
  address: string;
  source: RecipientSource;
}

export type RecipientCheck = { ok: true; recipients: Recipient[] } | { ok: false; reason: string };

const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Plain-address syntax check: `local@domain.tld`, no display name, no spaces,
 * no line breaks, no quoted local part, no IP-literal domain. Conservative on purpose.
 */
export function isValidEmail(address: string): boolean {
  if (address.length > 254) return false;
  const at = address.lastIndexOf("@");
  if (at <= 0 || at !== address.indexOf("@")) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL_RE.test(l))) return false;
  const tld = labels[labels.length - 1] ?? "";
  return /^[A-Za-z]{2,63}$/.test(tld);
}

/** Canonical form for comparison: trimmed, domain lower-cased. */
export function canonicalEmail(address: string): string {
  const t = address.trim();
  const at = t.lastIndexOf("@");
  if (at < 0) return t;
  return `${t.slice(0, at)}@${t.slice(at + 1).toLowerCase()}`;
}

function isTypedRecipient(v: unknown): v is TypedRecipient {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r["address"] === "string" && r["typedByOperator"] === true;
}

/**
 * Builds the final recipient list: the test inbox (unless `includeTestInbox`
 * is false) plus the typed addresses. Refuses the whole request on any bad entry,
 * so nothing is sent to a partial list.
 */
export function checkRecipients(typed: unknown, includeTestInbox = true): RecipientCheck {
  const list: unknown[] = typed === undefined || typed === null ? [] : Array.isArray(typed) ? typed : [typed];
  const out: Recipient[] = includeTestInbox ? [{ address: TEST_INBOX, source: "test_inbox" }] : [];
  const seen = new Set(out.map((r) => r.address.toLowerCase()));
  let typedCount = 0;
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (!isTypedRecipient(entry)) {
      return {
        ok: false,
        reason: `Recipient ${i + 1} was not typed by the operator in this request. Only typed addresses are accepted; nothing was prepared.`,
      };
    }
    const address = canonicalEmail(entry.address);
    if (!isValidEmail(address)) {
      return { ok: false, reason: `Recipient ${i + 1} does not look like a complete email address. Fix it or remove it.` };
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === TEST_INBOX) {
      out.push({ address: TEST_INBOX, source: "test_inbox" });
      continue;
    }
    typedCount += 1;
    if (typedCount > MAX_TYPED_RECIPIENTS) {
      return { ok: false, reason: `At most ${MAX_TYPED_RECIPIENTS} typed addresses per send.` };
    }
    out.push({ address, source: "typed" });
  }
  if (out.length === 0) return { ok: false, reason: "No recipients. Keep the test inbox or type at least one address." };
  return { ok: true, recipients: out };
}

/**
 * Ledger-safe form. The public test inbox is shown as is; a typed address
 * becomes `typed:<12 hex>` (HMAC with the server secret), so the same address
 * gives the same id on one server but cannot be read back or guessed offline.
 */
export function redactRecipient(r: Recipient, idKey: Buffer): string {
  if (r.source === "test_inbox") return TEST_INBOX;
  return `typed:${keyedId(idKey, r.address.toLowerCase())}`;
}
