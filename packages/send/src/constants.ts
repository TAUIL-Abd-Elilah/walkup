/** Fixed values for the confirm-gated send. */

/**
 * Resend's test inbox. It accepts mail and reports delivery without reaching a
 * person, so a visitor can confirm a real send without typing anything.
 */
export const TEST_INBOX = "delivered@resend.dev";

/** At most this many operator-typed addresses per send (the test inbox does not count). */
export const MAX_TYPED_RECIPIENTS = 5;

/** A confirm token is good for one confirm within this window. */
export const TOKEN_TTL_MS = 10 * 60 * 1000;

/** Default per-requester (hashed IP) sends per UTC day. Override with WALKUP_SEND_DAILY_CAP. */
export const DEFAULT_DAILY_CAP = 10;

/** Minimum length of WALKUP_SIGNING_SECRET when it is set. */
export const MIN_SECRET_LENGTH = 32;

/** Ledger endpoint for every send action, sent or not. */
export const LEDGER_ENDPOINT = "resend.emails.send";

/** Required wording: partners have not agreed to anything. */
export const NOT_AFFILIATED_LINE = "Suggested, not affiliated: no partner has agreed to anything.";

/** Shown when the sheet's counts are assumed, not ticketing data (the counts themselves are named in the line). */
export const WHAT_IF_NOTE = "Counts on this sheet are assumed numbers, not ticket sales.";

/** Shown on a sample (fixture) sheet, in the web sheet's own words. */
export const FIXTURE_NOTE = "Sample sheet: made-up places and numbers, not a live run.";

/** What can be attached. Same kind names as @walkup/exports (ExportKind). */
export const ATTACHMENT_KINDS = ["pdf", "ics", "partners"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Partners listed in the message body; the full list is in partners.csv. */
export const BODY_PARTNER_LIMIT = 10;

/** Lift tiles listed in the message body. */
export const BODY_TILE_LIMIT = 5;
