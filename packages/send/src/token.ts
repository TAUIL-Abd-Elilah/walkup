/**
 * Confirm tokens: `hl1.<payload>.<mac>`.
 *
 * The payload binds one prepared send: token id, plan id, issue and expiry
 * times, the hashed requester, the send mode shown in the preview, a digest
 * of the exact message and of every attachment, and the exact recipient list.
 * Recipients travel encrypted (AES-256-GCM) so the token can sit in a request
 * log without exposing an address. The MAC is HMAC-SHA256 over the version
 * and payload with a key derived from WALKUP_SIGNING_SECRET. Single use
 * is enforced by the store.
 */
import { b64url, fromB64url, hmacB64, open, safeEqual, seal, type SendKeys } from "./crypto";
import type { Recipient } from "./recipients";

const VERSION = "hl1";

export interface AttachmentDigest {
  filename: string;
  sha256: string;
  bytes: number;
}

export interface TokenPayload {
  /** Token id (random). Also the pending-store key and the provider idempotency key. */
  id: string;
  planId: string;
  /** Epoch ms. */
  iat: number;
  exp: number;
  /** Keyed hash of the requester IP. */
  rq: string;
  /** Send mode the preview showed ("live" sends, "demo" does not). Confirm refuses if the server's mode changed. */
  md: "live" | "demo";
  /** sha256 of subject, text and html. */
  msg: string;
  att: AttachmentDigest[];
  /** HMAC of the canonical recipient list. */
  rh: string;
  /** Sealed recipient list (AES-256-GCM, aad = token id). */
  rc: string;
}

export function recipientsDigest(keys: SendKeys, recipients: Recipient[]): string {
  const canon = recipients.map((r) => `${r.source}:${r.address.toLowerCase()}`).join("\n");
  return hmacB64(keys.mac, `recipients\n${canon}`);
}

export function signToken(
  keys: SendKeys,
  fields: Omit<TokenPayload, "rh" | "rc">,
  recipients: Recipient[],
): string {
  const payload: TokenPayload = {
    ...fields,
    rh: recipientsDigest(keys, recipients),
    rc: seal(keys.enc, JSON.stringify(recipients), fields.id),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${VERSION}.${body}.${hmacB64(keys.mac, `${VERSION}.${body}`)}`;
}

export type TokenCheck =
  | { ok: true; payload: TokenPayload; recipients: Recipient[] }
  | { ok: false; reason: string; code: "malformed" | "bad_signature" | "bad_recipients" };

function isRecipientList(v: unknown): v is Recipient[] {
  return (
    Array.isArray(v) &&
    v.every(
      (r) =>
        r !== null &&
        typeof r === "object" &&
        typeof (r as Record<string, unknown>)["address"] === "string" &&
        ((r as Record<string, unknown>)["source"] === "typed" || (r as Record<string, unknown>)["source"] === "test_inbox"),
    )
  );
}

function isPayload(v: unknown): v is TokenPayload {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p["id"] === "string" &&
    typeof p["planId"] === "string" &&
    typeof p["iat"] === "number" &&
    typeof p["exp"] === "number" &&
    typeof p["rq"] === "string" &&
    (p["md"] === "live" || p["md"] === "demo") &&
    typeof p["msg"] === "string" &&
    typeof p["rh"] === "string" &&
    typeof p["rc"] === "string" &&
    Array.isArray(p["att"])
  );
}

/** Verifies the MAC first, then decodes. Expiry and single use are checked by the caller. */
export function verifyToken(keys: SendKeys, token: unknown): TokenCheck {
  if (typeof token !== "string" || token.length > 16_384) {
    return { ok: false, code: "malformed", reason: "The confirm token is missing or malformed. Prepare the send again." };
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) {
    return { ok: false, code: "malformed", reason: "The confirm token is missing or malformed. Prepare the send again." };
  }
  const [, body = "", mac = ""] = parts;
  if (!safeEqual(mac, hmacB64(keys.mac, `${VERSION}.${body}`))) {
    return {
      ok: false,
      code: "bad_signature",
      reason: "The confirm token does not match what this server prepared (changed, or signed elsewhere). Nothing was sent.",
    };
  }
  const raw = fromB64url(body);
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw.toString("utf8")) : null;
  } catch {
    parsed = null;
  }
  if (!isPayload(parsed)) {
    return { ok: false, code: "malformed", reason: "The confirm token is missing or malformed. Prepare the send again." };
  }
  const plain = open(keys.enc, parsed.rc, parsed.id);
  let recipients: unknown = null;
  try {
    recipients = plain === null ? null : JSON.parse(plain);
  } catch {
    recipients = null;
  }
  if (!isRecipientList(recipients) || !safeEqual(recipientsDigest(keys, recipients), parsed.rh)) {
    return { ok: false, code: "bad_recipients", reason: "The recipient list in the confirm token does not check out. Nothing was sent." };
  }
  return { ok: true, payload: parsed, recipients };
}
