/**
 * Send configuration, read from env. Nothing here is logged; the ledger only
 * ever says whether a key was present.
 */
import { randomBytes } from "node:crypto";
import { DEFAULT_DAILY_CAP, MIN_SECRET_LENGTH } from "./constants";

export interface SendConfig {
  /** HMAC secret for confirm tokens (WALKUP_SIGNING_SECRET). */
  signingSecret: string;
  /** "ephemeral" when the env var is unset: a random per-process secret (tokens die on restart). */
  secretSource: "env" | "ephemeral";
  /** RESEND_API_KEY. A real send needs both this and `resendFrom`. */
  resendApiKey: string | null;
  /** RESEND_FROM, e.g. "Walkup <sheets@your-verified-domain>". */
  resendFrom: string | null;
  /** WALKUP_POSTAL_ADDRESS: the physical postal address in every footer. A real send needs it. */
  postalAddress: string | null;
  /** Sends per requester (hashed IP) per UTC day. WALKUP_SEND_DAILY_CAP, default 10. */
  dailyCap: number;
}

export class SendConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendConfigError";
  }
}

let ephemeralSecret: string | null = null;
function processSecret(): string {
  ephemeralSecret ??= randomBytes(32).toString("base64url");
  return ephemeralSecret;
}

function clean(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
}

/**
 * Reads the send settings. Throws `SendConfigError` when a value is set but
 * unusable (a short secret, a non-numeric cap, a from address with a line break).
 */
export function resolveSendConfig(env: Record<string, string | undefined> = process.env): SendConfig {
  const secret = clean(env["WALKUP_SIGNING_SECRET"]);
  if (secret !== null && secret.length < MIN_SECRET_LENGTH) {
    throw new SendConfigError(`WALKUP_SIGNING_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const capRaw = clean(env["WALKUP_SEND_DAILY_CAP"]);
  let dailyCap = DEFAULT_DAILY_CAP;
  if (capRaw !== null) {
    const n = Number(capRaw);
    if (!Number.isInteger(n) || n < 0) throw new SendConfigError("WALKUP_SEND_DAILY_CAP must be a whole number >= 0.");
    dailyCap = n;
  }
  const from = clean(env["RESEND_FROM"]);
  if (from !== null && /[\r\n]/.test(from)) throw new SendConfigError("RESEND_FROM must be one line.");
  const postal = clean(env["WALKUP_POSTAL_ADDRESS"]);
  return {
    signingSecret: secret ?? processSecret(),
    secretSource: secret !== null ? "env" : "ephemeral",
    resendApiKey: clean(env["RESEND_API_KEY"]),
    resendFrom: from,
    // Allow "\n" written literally in a one-line env file to mean a line break.
    postalAddress: postal === null ? null : postal.replace(/\\n/g, "\n"),
    dailyCap,
  };
}

/** True when a real send can be attempted (both Resend values present). */
export function hasMailKeys(config: SendConfig): boolean {
  return config.resendApiKey !== null && config.resendFrom !== null;
}

/** The bare address inside RESEND_FROM ("Name <a@b.c>" or "a@b.c"). */
export function fromAddress(from: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  return (m?.[1] ?? from).trim();
}
