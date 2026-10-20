/**
 * Small crypto helpers on node:crypto. Three keys are derived from the one
 * server secret so that a token MAC, the recipient encryption and the
 * address/IP hashes never share a key.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface SendKeys {
  /** Signs confirm tokens and the recipient binding. */
  mac: Buffer;
  /** AES-256-GCM key for the recipient list inside the token. */
  enc: Buffer;
  /** Keyed hash for ledger-safe address and requester ids. */
  id: Buffer;
}

export function deriveKeys(secret: string): SendKeys {
  const derive = (label: string) => createHmac("sha256", secret).update(`walkup/send/${label}/v1`).digest();
  return { mac: derive("mac"), enc: derive("enc"), id: derive("id") };
}

export function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

export function fromB64url(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  return Buffer.from(s, "base64url");
}

export function hmacB64(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}

/** Short hex keyed hash (first `hexChars` of HMAC-SHA256). Not reversible without the server secret. */
export function keyedId(key: Buffer, value: string, hexChars = 12): string {
  return createHmac("sha256", key).update(value).digest("hex").slice(0, hexChars);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Constant-time string compare (false on length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function randomId(bytes = 16): string {
  return b64url(randomBytes(bytes));
}

/** AES-256-GCM. Output: base64url(iv[12] | ciphertext | tag[16]). `aad` binds the ciphertext to a context. */
export function seal(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return b64url(Buffer.concat([iv, ct, cipher.getAuthTag()]));
}

/** Inverse of `seal`. Returns null on any failure (wrong key, wrong aad, tampered bytes). */
export function open(key: Buffer, sealed: string, aad: string): string | null {
  const raw = fromB64url(sealed);
  if (!raw || raw.length < 12 + 16) return null;
  try {
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
