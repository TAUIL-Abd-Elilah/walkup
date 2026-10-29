# @walkup/send

The "Send to street team" action. It emails the Street Sheet PDF (`street-sheet.pdf`), the street-team timeline (`street-team.ics`) and the partner call list (`partners.csv`), all built by `@walkup/exports` with the same names as the downloads (the sheet's prefix of show, date and plan id, as in `walkup-the-roots-2027-01-15-fe1ff2bc-street-sheet.pdf`, with `fixture-` in front on fixture sheets), after a person confirms, and writes one `A#` entry to the sheet's ledger for every confirm, whether or not anything was sent.

Two steps, with a human in between:

1. `prepareSend` checks the recipients and attachments, builds the exports and the message, and returns a preview plus a confirm token. Nothing is sent and nothing is written to the ledger.
2. `confirmSend` checks the token and the daily cap, then sends through Resend. Without Resend keys it records `demo: not sent` instead.

## Rules this package enforces

- **Default recipient: `delivered@resend.dev`**, Resend's test inbox. A visitor can confirm a real send without typing anything.
- **Typed addresses only.** Any other address must arrive as `{ address, typedByOperator: true }`, typed by the operator into this request. Anything else (a plain string, a missing or non-`true` flag) refuses the whole request. Nothing is ever taken from the sheet: declared partners' `contactEmail`, partner websites and Qloo properties are never read for recipients. No partner is emailed unless the operator typed the address.
- At most **5 typed addresses** per send, plain `local@domain.tld` syntax only (no display names, no line breaks, no commas), de-duplicated.
- **Typed addresses are used once and never stored or logged in full.** They travel inside the confirm token encrypted (AES-256-GCM), the server-side store never sees them, and the ledger records `typed:<12 hex>`, an HMAC of the address under the server secret. The public test inbox is recorded as is. With more than one recipient, typed addresses go in `bcc`, so recipients never see each other's addresses.
- **Confirm tokens** (`hl1.<payload>.<mac>`) are HMAC-SHA256 signed with a key derived from `WALKUP_SIGNING_SECRET`. A token binds the plan id, the exact recipient list, the send mode the preview showed (`live` or `demo`), a SHA-256 of the exact subject and body, and a SHA-256 of every attachment. If the server's mode changed in between, the confirm is refused, so a preview that said "nothing is sent" never turns into a real send. It expires 10 minutes after prepare and works for one confirm only (a replay is refused).
- **Daily cap:** 10 confirmed sends per requester per UTC day by default (`WALKUP_SEND_DAILY_CAP`). The requester is a keyed hash of the IP; the raw IP is never stored. Checked at prepare and enforced atomically at confirm. Demo confirms count too, and a provider error still counts.
- **CAN-SPAM footer:** why the recipient got it, that no mailing list is kept, an opt-out line (reply "unsubscribe" or write to the `RESEND_FROM` address, plus a `List-Unsubscribe` mailto header), and the physical postal address from `WALKUP_POSTAL_ADDRESS`. A real send is refused without a postal address.
- **Plain, specific message.** Subject: `Street sheet for {headliner}, {venue}, {Fri Nov 20 2026}`, with ` (sample)` on a fixture sheet (what-if counts are said in the body). The body lists the street-team days, the top lift tiles (at most 5, lift 1.3 or more, highest first: the same `topTiles` selection from `@walkup/exports` as the PDF, whatever order the sheet stores them in), the first 10 partners, "Suggested, not affiliated: no partner has agreed to anything.", the attachments and "What this sheet doesn't show". When `sheet.hypothetical` is true the body carries the HYPOTHETICAL COUNT note with the what-if numbers; a fixture sheet says it is synthetic. Only facts already on the sheet are used; no generated copy.

## Public API

```ts
import { prepareSend, confirmSend, createSheetLedger } from "@walkup/send";

// Step 1 (e.g. POST /api/send/prepare)
const prep = await prepareSend({
  sheet,                                   // StreetSheet
  recipients: [{ address: addressTheOperatorTyped, typedByOperator: true }], // optional, max 5
  attachments: ["pdf", "ics", "partners"],                           // optional, default all (kind names as in @walkup/exports)
  requesterIp,                              // hashed, for the daily cap
});
if (prep.status === "refused") show(prep.reason);
else showConfirmDialog(prep.preview);       // keep prep.confirmToken for step 2

// Step 2 (e.g. POST /api/send/confirm), after the person clicks Confirm
const ledger = createSheetLedger(sheet.ledger); // continues A1, A2, ...
const res = await confirmSend(prep.confirmToken, { ledger, requesterIp });
// res.status: "sent" | "demo_not_sent" | "refused" | "failed"
// res.messageId (sent only), res.ledgerEntryId ("A3"), res.ledgerEntry, res.planId, res.reason
```

Pass `prepareSend` a sheet the server loaded itself (by plan id from its own store), never a sheet taken from the request body: the email goes out from your verified domain carrying the sheet's text, so a client-supplied sheet would let anyone mail arbitrary content to the addresses they type.

`prepareSend(input, deps?)` returns `{ status: "ready", confirmToken, preview }` or `{ status: "refused", reason }`. The preview has `recipients` (`{ address, source: "test_inbox" | "typed" }`), `subject`, `attachments` (kind, label, filename, content type, bytes), `attachmentFailures` (an export that failed to build is left out and listed here), `footer`, `text`, `mode` (`"live"` or `"demo"`), `modeReason`, `expiresAt` and `sendsLeftToday`.

`confirmSend(token, deps)` always writes exactly one ledger entry:

| status | when | ledger entry |
|---|---|---|
| `sent` | Resend accepted it | `envelopeStatus: "ok"`, `httpStatus: 200`, note `sent: message id re_...` |
| `demo_not_sent` | `RESEND_API_KEY` or `RESEND_FROM` missing | `envelopeStatus: "degraded"`, note `demo: not sent. <which key is missing>` |
| `refused` | bad or tampered token, expired, replayed, other requester, cap reached, pending send gone, send mode changed since the preview, config blocks it | `envelopeStatus: "error"`, note `refused: <reason> Nothing was sent.` |
| `failed` | Resend was called and gave no message id | `envelopeStatus: "error"`, provider status code, note `failed: ...` (any address in the provider message is masked). A 4xx ends with `Nothing was sent.`; a network error, a timeout or a 5xx says the outcome is unknown and to check the Resend dashboard |

Every entry has `kind: "action"`, `method: "ACTION"`, `endpoint: "resend.emails.send"`, `curl: ""` and params `planId`, `recipients` (redacted), `recipientCount`, `attachments` (filenames), `subject`, `token` (a keyed hash of the token id) and `provider` (`"resend"` or `"none (demo)"`).

Dependencies are injectable (`deps`): `config` (default `resolveSendConfig(process.env)`), `store` (default one in-memory store per process), `now`, `exporters` (prepare; default `toPdf`, `toIcs` and `partnersCsv` (with a byte order mark) from `@walkup/exports`), `mailClient` (confirm; default a Resend client), `requesterIp` (confirm; when given it must match the requester who prepared).

Also exported: `checkRecipients`, `isValidEmail`, `redactRecipient`, `resolveSendConfig`, `createMemorySendStore` (option `maxPending`, default `DEFAULT_MAX_PENDING` = 256) and the `SendStore` interface (implement it over SQLite or Redis for more than one process; methods may be async), `createSheetLedger`, `buildMessage`, `renderAttachments`, `defaultExporters`, `createResendClient` and the constants (`TEST_INBOX`, `TOKEN_TTL_MS`, `DEFAULT_DAILY_CAP`, `MAX_TYPED_RECIPIENTS`, `LEDGER_ENDPOINT`, ...).

## Configuration

| Env var | Needed for | Default / behaviour |
|---|---|---|
| `WALKUP_SIGNING_SECRET` | Confirm tokens and the address/IP hashes | At least 32 characters. Unset: a random per-process secret (tokens stop working on restart, hashes differ per process). |
| `RESEND_API_KEY`, `RESEND_FROM` | A real send | Either missing: demo mode, `demo_not_sent`. `RESEND_FROM` must be on a domain verified in Resend, e.g. `Walkup <sheets@your-domain>`. |
| `WALKUP_POSTAL_ADDRESS` | A real send | Physical postal address for the footer. `\n` in the value becomes a line break. Without it a real send is refused. |
| `WALKUP_SEND_DAILY_CAP` | Optional | 10 sends per requester per UTC day. |

## Tests

```bash
npx vitest run packages/send
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "packages/send"
```

All tests run offline with a mocked Resend client and fake exporters (plus one check of the real `@walkup/exports` functions on a synthetic sheet). They cover token tampering, a foreign secret, changed attachments, expiry, replay, the daily cap at prepare and at confirm, refusal of untyped recipients, address syntax and the 5-address cap, address hashing and bcc, the demo path, a demo preview confirmed after the server went live (refused) and the reverse, provider errors (a 4xx says nothing was sent; a network error or a 5xx says the outcome is unknown), the message id in the ledger, the tile selection on unsorted tiles, and the pending-store bound.

## Known limits

- The default store is in process memory: pending sends, used tokens and daily counts are lost on restart and are not shared between processes. A prepared send must be confirmed on the same process. Inject a shared `SendStore` for more than one machine.
- The in-memory store holds at most 256 prepared sends (each holds the rendered files); past that the oldest is dropped and its confirm is refused. Prepare itself is not rate-limited here (it renders a PDF each time): the route that calls it should limit requests per IP.
- The daily cap is per hashed IP; people behind one NAT share it. There is no global cap; Resend's own quota (100 a day on the free tier) answers with `daily_quota_exceeded`, which is recorded as `failed`.
- Walkup does not store typed addresses, but Resend keeps each email's recipients in its own logs and dashboard for its retention period. The Resend SDK also prints provider error messages (which can quote an address) with `console.error` when `NODE_ENV` is not `production`.
- With two or more typed addresses and the test inbox turned off, `to` is the `RESEND_FROM` address itself and the typed addresses go in `bcc`, so the sending mailbox also gets a copy. It is not listed in the preview's recipients.
- The opt-out line asks recipients to reply. Walkup keeps no list, so honouring an opt-out means adding the address to the Resend suppression list for the sending domain; that is a manual step for whoever runs the deployment.
- Resend may only deliver to the test inbox until `RESEND_FROM` is on a verified domain.
- `partners.csv` is the download as is, so it includes the `contact_email` column for the operator's own declared partners (addresses the operator typed into their list). Leave `partners` out of `attachments` when sending to someone who should not see them.
- The message body is in English and lists at most 10 partners and 5 tiles; the attachments carry the rest.
- Not live-verified: no Resend key exists yet. Message ids, error shapes and the attachment size limit (40 MB per email) are from the SDK's types.
