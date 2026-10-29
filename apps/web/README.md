# @walkup/web

The Walkup web app: Next.js 16 (App Router), React 19, Tailwind v4, MapLibre GL with OpenFreeMap tiles. It renders a
Street Sheet for one booked show and runs plans through `@walkup/orchestrator`, exports them with
`@walkup/exports` and sends them with `@walkup/send` after a person confirms.

## Modes

The mode is read per request (the image is built without secrets), never at build time.

| Mode | When | What runs |
|---|---|---|
| **Live** | `QLOO_API_KEY` and `TICKETMASTER_API_KEY` are set, `WALKUP_MODE` is not `fixture`, and Qloo has not rejected the key | Fresh runs call Qloo, Ticketmaster and Claude (narration, through OpenRouter when `OPENROUTER_API_KEY` is set, else Anthropic when `ANTHROPIC_API_KEY` is set). Presets are served from the latest stored live run made with the preset's own inputs (a run with someone's what-ifs, partner list, up-front picks or a proxy stand-in stays that caller's sheet); before one exists, the bundled fixture sheet is shown with a "Sample sheet" strip. |
| **Recorded** | `WALKUP_MODE=recorded`; or the time in `WALKUP_QLOO_UNTIL` (an ISO date or date and time, UTC) has passed; or Qloo rejected the configured key and the plan store holds a live sheet | Qloo is unavailable: nothing runs and no API is called. Each preset shows its latest stored live run made with the preset's own inputs that passes `usableRecording` (`lib/server/recorded.ts`: no key refused by Qloo on it, by the rule `qlooRefusedKey` in `lib/server/key-status.ts` applies to live runs; fewer than half its cards failed); a preset without one shows its bundled sheet with the "Sample sheet" strip. Stored live sheets open at their ids; their envelope (`/api/sheet/<id>`, `GET /api/plan/<id>`, MCP `get_sheet`) and the `start` event of their stream say `mode: "recorded"`. A strip on every page (`recordedDetail` in `lib/mode.ts`) says the day the sheets were recorded from live runs (and a later day for ready-made changes), that live runs are paused for judging, and that each recorded sheet comes from a live run, and any change since was made offline, with no API call; the landing page calls its sheets recorded, or sample sheets when nothing was recorded; a live sheet says "Recorded <date>" (page, print view and PDF). Every fresh path (`POST /api/plan`, rank-partners, resolve, show and title search, and the MCP tools that would start a run) answers with `mode: "recorded"` and `RECORDED_REASON` (`lib/api.ts`; 503 on the REST routes). A change note on a recorded live sheet that has ready-made changes is answered from them (`lib/server/recorded-revise.ts`): the stored revision made for the same change opens, or the answer says the change needs new Qloo requests; any other revise gets the 503. Reading, streaming finished plans, downloads and the confirm-gated send still work. |
| **Fixture** | Anything else | The four presets run end to end through the orchestrator on `@walkup/qloo-world`, a labelled synthetic stand-in for Qloo and Ticketmaster (no network, no keys, template narration). Free-form search stays disabled with its message; `POST /api/plan` with an event answers 503. Every page and sheet says "Sample data", exported files start with `fixture-` and carry the sample sentence, and emails say FIXTURE. |

`WALKUP_MODE=fixture` keeps fixture mode whatever the date or the stored sheets. `WALKUP_MODE` is read the same way here,
in `@walkup/qloo`'s config and in the orchestrator's `liveKeysPresent` (`walkupModeValue`: an inline `# comment` and case
don't matter).

A live run that sees Qloo answer 401, or 403 with no fresh Qloo call accepted in the same run (Qloo also answers 403 for
one request whose `filter.type` the key may not use), writes `${WALKUP_DATA_DIR}/qloo-key-status.json` (date, status
and a 12-hex hash of the key, never the key), also when the run stopped before a sheet. The server then stays in
recorded mode, or in fixture mode when no live sheet is stored, after restarts too, until a different key is set.

## Routes

| Route | What it is |
|---|---|
| `/` | Landing: a three-line pitch with one button to The Roots' sheet, "Same room, two crowds" (the Salt Shed pair's maps and one comparison sentence computed from the two sheets by `compareBills`; The Anthem pair follows as a second room), "With Qloo and without" for two areas, show search (live only; fresh runs left today are shown), the preset sheets as plain links, how it works. Fixture mode shows the sample strip at the top of every page instead of a watermark; recorded mode shows its own strip and lists the recorded sheets where the search would be. |
| `/plan/[id]` | A preset id (`g1-a`, `g1-b`, `g2`, `g3`; `g4-a`, `g4-b` are live-only: served from a stored live run, else 404) or a run's id. A finished sheet renders as a plain document (see "Plan page" below); a running plan lists its sections as they stream; a paused plan shows the candidates for the ambiguous name. `/plan/g2` in fixture mode opens on the Sidecar pick (the recorded sheet is at `/plan/g2?recorded=1`). |
| `/s/[id]` | The print view of the sheet, with the one-page server PDF (US Letter or A4) to download. It renders `buildSheetModel` from `@walkup/exports/sheet-model`, the same strings the PDF prints: black on white, thin rules, receipts as one quiet superscript group per line, a "Sample data" label and one light watermark on fixture sheets, the discovery line, and the partner table as a form (tick box, number, place and address, area, hours, why, and a Notes column left blank except "No time left on the route: call to arrange" (or "on the first pass", "on the final pass") when the street-team route had no time for the place, as on the PDF); under 640px each partner is a two-line block. The paper stays light in dark mode (`.paper` sets the colour tokens to their light values). In Chrome it prints on two pages (US Letter or A4) for every hosted sheet but the g3 sample, which fits on one, with every row whole and nothing cut; the downloaded PDF is the one-page version. |
| `/system-card`, `/eval` | Plain documents. The system card lists the Q9 house twin. The eval page reads its counts and case list from `evals/product/out/score.json` at build time (nothing typed by hand) and reports the Fan-Bar Test, run Oct 21 2026 under the plan sealed Oct 13, as a null result (25% vs 27% in the top 50, one-sided p = 0.89). |
| `POST /api/plan` | Start a run. Body: one of `{presetId}`, `{tmEventId}`, `{event}` (Ticketmaster URL, `"Artist @ Venue, Date"` or a preset id); optional `operator` what-ifs and `picks: [{input, entityId}]`. By default it answers with the envelope when the run completes or pauses (`status: "needs_input"`, candidates in `pending` and `resolution`); `{"wait": "none"}` answers 202 with `planId`, `streamUrl` and `planUrl` at once. `{presetId, rerecord: true}` with `Authorization: Bearer <WALKUP_OPERATOR_TOKEN>` plans a live preset again instead of serving its stored run (403 without the token); the new run becomes the preset. |
| `GET /api/plan/[id]` | Where a plan stands: `running`, `needs_input` (with candidates), `complete` or `error`. Every answer has `planId`, `planUrl`, `streamUrl`, `status` and `mode`; `complete` adds `sheetUrl` (the print sheet, `/s/<id>`, as in every other answer) and `envelopeUrl` (the JSON envelope, `/api/sheet/<id>`); `needs_input` adds `pending` and `resolveUrl`. |
| `GET /api/plan/[id]/stream` | Server-sent events: `start`, `card` (in the spec order: resolution, liftMap, partners, declared, prePost, media, demographics, whatsDifferent, copyHooks), `step` (`{index, step}`: one `TraceStep` of `sheet.steps` as the run reaches it), `needs_input`, `done`. A cached or stored sheet streams every card at once, then its steps. |
| `POST /api/plan/[id]/resolve` | `{picks: [{input, entityId}]}` resumes a pause (same id). A pick must be one of the candidates shown; `proxy: true` marks "None of these: use a proxy" with a film or TV title from `/api/proxy-search`. On a preset's recorded pause it starts a new run with the pick. |
| `POST /api/plan/[id]/revise` | `{instruction, wait?}`: change a finished sheet with a short note ("All ages: no bars", "skip Germantown", "only Saturday", "within 10 km"). The model reads it with strict tools when a model key (OpenRouter or Anthropic) is set, fixed rules otherwise. 202 `{status: "running", planId (new), parentPlanId, planUrl, streamUrl, sheetUrl, mode, revision}` (the revised run streams cards and steps; the revise step comes first); with `{"wait": "complete"}` 200 with the sheet envelope plus `parentPlanId` and `revision` (`changes` filled); 200 `{status: "needs_input", question, revision}` when the note is unclear (nothing ran). 400 bad note, 404, 409 when the plan is running, paused or from the other mode, 429 rate limit or quota guard. Browser helper: `revisePlan(planId, instruction, {wait?, signal?})` in `lib/api.ts`, which never throws. |
| `GET /api/sheet/[id]` | The JSON envelope (`status`, `summary`, `planId`, `sheetUrl`, `planUrl`, `mode`, `results: StreetSheet`, `resolution`, `cards`, `reason`, `provenance`, `limits`). The status rolls up `needs_input` > `error` > `degraded` > `partial` > `ok`. |
| `GET /api/sheet/[id]/{pdf,ics,partners.csv,zips.csv,pins.csv,offer-codes.csv,sheet.json}` | Downloads from `@walkup/exports` (`?size=a4`, `?inline=1` for the PDF). File names name the sheet: `walkup-<headliner>-<show date>-<first 8 of the plan id>-<file>` (`exportFilePrefix`), with `fixture-` in front on sample sheets; email attachments use the same names. |
| `POST /api/send/prepare` | `{planId, copyTo?, attachments?}`: the real preview (recipients, subject, attachments with sizes, body, footer, live or demo) and a confirm token. Nothing is sent or logged. 30 per network per hour. |
| `POST /api/send/confirm` | `{planId, confirmToken}`: `sent` (with the Resend message id), `demo_not_sent`, `refused` or `failed`, and one `A#` ledger entry. |
| `POST /api/rank-partners` | `{event or presetId, partners: [names]}`: runs the plan and returns the operator's list ranked (`DeclaredPartnerScore[]`). |
| `GET /api/limits` | Fresh runs left today for this network and in total (`freshRuns`), and `freshRunsEnabled`. Outside live mode `freshRunsEnabled` is false and `freshRuns` is null; in recorded mode `presets` names the routes that open a preset (`/plan/<presetId>`, `GET /api/plan/<presetId>`, MCP `plan_show`), since `POST /api/plan` runs nothing there. |
| `GET /api/events/search?q=` | Ticketmaster events for the search box (live only). |
| `GET /api/proxy-search?q=&type=` | Film and TV titles to stand in for an act. |
| `GET /healthz` | Always 200 with `ok: true`, fast, no API call on the request path: mode (`live`, `fixture` or `recorded`), key presence (never values), `qloo: {keyRejected: {httpStatus, at} or null, until}` (`WALKUP_QLOO_UNTIL` as an ISO time, or null), `recorded: {presets: {<id>: {planId, createdAt} or null}}` in live and recorded mode (what recorded mode serves for each preset; null in fixture mode), reachability (last real call per service, plus a keyless background probe at most every 10 minutes in live mode), Qloo month quota and the quota guard, `freshRunsEnabled` and the fresh runs left today (`freshRunsToday`, null when fresh runs are off: fixture and recorded mode), plan store. |
| `/mcp` | The MCP endpoint (`@walkup/mcp`): tools `plan_show`, `rank_partners`, `bill_vs_house`, `get_sheet`, `revise_plan` on the same engine, stores and caps as the REST routes. |

Every `/api` route and `/healthz` answers a method it does not take with 405, a JSON `reason` and an `Allow` header,
and OPTIONS with 204 and the same `Allow`.

Inputs (`lib/server/input.ts`): only known fields pass, with bounds. Operator inputs also take `allAges` (boolean),
`excludeCategories` and `excludeAreas` (at most 30 short strings each); revise notes are 1 to 300 characters. Event text, partner names and declared-partner
labels that contain an email address, or that name a political candidate or campaign (`looksPolitical` from
`@walkup/engine`, the same list MCP uses), are refused with 400 before anything runs.

## Caps (spec 6.8)

- Fresh runs: 3 per network per UTC day and 15 per day in total (`WALKUP_FRESH_RUNS_PER_IP`, `WALKUP_FRESH_RUNS_PER_DAY`).
  Counted when a live run starts; refunded when it fails before sending any Qloo call. IPs are kept only as a keyed hash.
  Counts live in `${WALKUP_DATA_DIR}/fresh-runs.json`.
- Presets are unlimited: stored live runs in live mode, recorded live runs (or the bundled sheets) in recorded mode, the
  bundled sheets in fixture mode. Nothing runs in recorded mode, so no run cap applies there; change notes (120 per
  network per hour), send previews and sends are still capped, as below. A fresh run of a preset on the
  fixture world ("Run it again", `POST /api/plan {presetId}`) is stored, so those are limited to 30 per network per hour.
  Resuming a paused plan does not count again.
- Fresh runs stop with 429 when Qloo's month quota is below the guard floor (1,500).
- Revisions: 12 per network per hour in live mode, 30 in fixture mode, 120 in recorded mode (`reviseAllowed` in
  `limits.ts`). In live mode a revision that runs also takes a fresh run (same caps as `POST /api/plan`), refunded when it
  made no new Qloo call; the Qloo cache answers every request whose inputs did not change. In recorded mode a note only
  opens a stored version (no API call). A note that comes back as a question still counts against the window.
- Send previews: 30 per network per hour in every mode (`PREPARE_PER_HOUR` in `send.ts`); sends: `@walkup/send`'s daily
  cap (10 per network per UTC day by default, `WALKUP_SEND_DAILY_CAP`), counted for demo sends too.
- Film/TV title searches for a proxy: in live mode (one Qloo `/search` each) 20 per network per hour and 100 per day in
  total; 120 per network per hour in fixture mode. Show search runs in live mode only: 60 per network per hour. Recorded
  mode runs neither search.

## Server modules (`lib/server`, server-only)

| Module | What it does |
|---|---|
| `engine.ts` | Orchestrator deps per mode (`depsFor`, `fixtureDeps`, `liveDeps`), plan and pick stores (`stores()`: SQLite at `${WALKUP_DATA_DIR}/plans.sqlite`, or memory with `WALKUP_PLAN_STORE=memory`), `sessionChoices` (picks scoped to one browser session), `publishLiveQuota`. Singletons on `globalThis`. |
| `service.ts` | `startPlan`, `resolvePlan`, `loadPlan`, `planSnapshot`, `envelopeOf`, `presetSheet`, `presetPause`. Each returns `{status, body}`. `loadPlan` drops the Google Places comparison list an older stored sheet may carry (`withoutControl`); the product no longer makes or shows one. |
| `revise.ts` | `revisePlanFor(id, body, ctx)` for `POST /api/plan/[id]/revise`: validation, the rate window, the parent request (stored, or the preset by its event), the orchestrator's `readInstruction`, then `startRun` with `runRevision` as the runner. |
| `runs.ts` | The in-process run registry the SSE route follows (`startRun`, `getRun`, `subscribe`). It records cards and steps (`onStep`); `run` swaps in another runner (revisions). Finished runs stay 15 minutes; complete and paused plans are stored. |
| `stream.ts` | SSE frames for one plan. |
| `twin.ts` | The partner usual-crowd rank for older sheets (below). |
| `proxy.ts` | Relabels an operator-chosen film/TV stand-in as a proxy seed. |
| `send.ts`, `exports.ts`, `lookups.ts` | Send wrappers, downloads, limits, search, `/healthz`. |
| `recorded.ts` | Recorded mode: `recordedPresetRun` (the stored live run a preset shows), `usableRecording` (the check it must pass), `liveSheetStored` (the rejected-key rule in `lib/mode.ts`). |
| `limits.ts`, `key-status.ts`, `health.ts`, `actions.ts`, `input.ts`, `http.ts`, `env.ts` | Caps and rate windows, the rejected-key record, reachability, where `A#` entries are kept, request validation, cookies and IPs, data paths. |

Every file the server writes goes under `WALKUP_DATA_DIR` (`./.cache` locally): `plans.sqlite`, `fresh-runs.json`,
`qloo-key-status.json`, and the packages' own Qloo cache and Claude spend file.

**Cookies:** one functional cookie, `hl_sid` (random, HttpOnly, SameSite=Lax, 30 days). It scopes the operator's
remembered picks (so one visitor's pick is never another visitor's default) and the `A#` entries recorded on shared
preset sheets. Sends on a run's own sheet are stored with that plan.

## The usual-crowd rank (partner rows)

The partner table says it in one sentence per row ("Ranks 8th here for this crowd, 20th for the room's usual crowd."),
built from `Partner.houseRank` (`components/plan/model.ts` `partnerWhy`); the chip labels stay in the data.

The orchestrator now runs the partner house twin itself: one "Q9 house twin, <where>" call per partner pool, counted in
`PlanResult.budget`, with a chip such as "ranks 3 places higher here than for the room's usual crowd", `Partner.houseRank` and the ubiquity penalty on the sheet.
An empty twin is not evidence that a place is missing for the usual crowd, so it sets no rank. `twin.ts` is kept only for sheets stored before that change: it skips any sheet whose ledger already has a house twin,
and otherwise replays each pool's Q9 request with the house signal swapped in (one Qloo call per pool, cached 7 days).

## Plan page (`components/plan`)

The sheet reads as a document: sections separated by a rule, a sentence-case heading with the
status in words beside it (`STATUS_WORD` in `lib/labels.ts`; "ok" says nothing), the card summary with its receipts as
superscript footnotes (`Refs` in `receipts.tsx`: each id links to its ledger row `#receipt-<id>` and opens the side
drawer), tables for places. Imports inside `components/plan` are relative, so `test/plan-page.test.ts` renders the
page with `react-dom/server` (the map pieces and `next/*` are mocked there).

| File | What it renders |
|---|---|
| `PlanView.tsx` | The finished sheet: header, actions (send, PDF, print view, Run it again), the "The other bill at {venue}" link, inputs, summary, then every section, limits, downloads and the ledger. |
| `PlanLive.tsx` | A running or paused plan: sections fill in from `card` events; decision steps fill in from `step` events (`{step: TraceStep}` or a bare `TraceStep`; ignored when malformed); the pause shows `ResolutionCard` with `CandidatePicker`. |
| `PlanCard.tsx` | One section (heading, status word, summary with footnotes, reason, body, limits). The yellow row is only for a pause the operator must answer. |
| `PartnersCard.tsx` | Partners as a table: name (address, phone or "Phone not listed", website), type (with "national chain" when `partner.chain`), area (with its map number), open on the first street-team day, why (chips as plain words with footnotes). `partner.explain` adds a "Why this place" row; `houseRank` and `ubiquityPenalty` are said in it. The card's summary carries the chain sentence ("2 of 16 partners are national chains, listed last in their area: no local place filled their slot.") and its notes the chain limit (`CHAIN_DETECT_LIMIT`, which names the four signals) when any eligible place is a chain. Under the table, `sheet.popularityCheck` becomes one sentence with its receipts ("8 of the 11 partners aren't among the most popular places in their areas, so a popularity list would miss them.", `popularityLine` in `lib/sheet-utils.ts`); a sheet without it (a twin failed or came back empty, or an older sheet) shows nothing there. |
| `SheetExtras.tsx` | Only when the sheet has the field: `discovery` (one callout near the top, linked to its row or tile), `steps` ("What Walkup decided"), `revision` (banner, the instruction, grouped changes, the question when one was asked, tool calls). |
| `ReviseBox.tsx` | "Change something". `app/plan/[id]/page.tsx` passes `revisable` (every finished sheet except a live sheet on a fixture server, and none in recorded mode), and `PlanView` then calls `revisePlan` from `lib/api.ts`; an `onRevise` prop (`(instruction) => Promise<{planId?, question?, reason?}>`) overrides it in tests. A new plan id opens the revised run, which streams its steps and then shows the revision banner; a question is shown under the box and nothing changes. In recorded mode `PlanView` passes `recordedPlanId` instead, on a recorded live sheet that is not itself a revision: the box lists that sheet's ready-made changes (`GET /api/plan/<id>/ready-made`), stays hidden when there are none, and opens the one the note asks for. |
| `LiftCard.tsx`, `ResolutionCard.tsx`, `MoreCards.tsx` | Map and areas (plus `liftDiagnostics` when present), acts and venue, your list, before and after, podcasts and a sponsor, copy lines, how this crowd differs. |
| `ReceiptDrawer.tsx`, `SendModal.tsx`, `useDialog.ts` | The receipt side panel (request line, parameters with keys as env var names, status, time, cache, curl) and the confirm-gated send dialog. |
| `model.ts` | Pure helpers: discovery targets, revision grouping, step parsing and merging, chip wording, instruction checks. |

## Fixtures

- **Source of truth:** `fixtures/synthetic/engine/<id>.sheet.json`, written by the orchestrator itself on the synthetic
  world: `npx tsx packages/orchestrator/scripts/generate-fixture-sheets.ts`. They render at least as much as the
  hand-built sheets (24 partners on G1 with every chip traced to a ledger entry, run-named tiles, the real fallbacks on G3)
  and are what the pages, exports and `/api/sheet/<preset>` serve.
- **Fallback:** the hand-built sheets in `fixtures/synthetic/*.sheet.json` (`npx tsx apps/web/scripts/build-fixtures.ts`).
  `lib/plans.ts` serves a hand-built sheet only when the generated one fails validation or is for another plan id, with a
  warning. Both sets are bundled (static imports), so a missing file fails the build.
- Tests check what the generated sheets must hold (validator, synthetic labelling, fictional contacts, no denied tags,
  golden beats), never their bytes, so regenerating them never fights a test.

## Build notes (`next.config.ts`)

- `output: "standalone"` (the Dockerfile runs `apps/web/.next/standalone/apps/web/server.js`).
- `transpilePackages` lists every workspace package the app imports, directly or through another.
- `serverExternalPackages: ["better-sqlite3", "@react-pdf/renderer"]`. Server-only packages are imported from route
  handlers, server components and `lib/server` only.
- No bundler aliases: workspace packages use extensionless relative imports. `lib/server/env.ts` points
  `WALKUP_GAZETTEER_DIR` at `data/gazetteer/out` when it is unset; the orchestrator finds `config/tags.json`
  from `WALKUP_TAGS_FILE` or by walking up from the working directory (the image sets both variables).
- The few computed filesystem paths (data dir, tags file, `findUp`) carry `/*turbopackIgnore: true*/`, so the build
  does not trace the whole repository. `outputFileTracingExcludes` still keeps raw API bodies, private tables, caches
  and SQLite files out of the standalone output.

## Run, build, test

From the repository root (dependencies are installed at the root):

```
cd apps/web && npx next dev          # http://localhost:3000
cd apps/web && npx next build        # standalone output
npx vitest run apps/web              # fixtures, envelope, service, stream, send, exports, caps, healthz
npx tsc -p apps/web/tsconfig.json --noEmit
```

## Known limits

- Live mode ran on Oct 21 2026: four real Ticketmaster bills, g1-a and g1-b at The Anthem, Washington DC, and g4-a and
  g4-b at The Salt Shed, Chicago. The hosted site serves those runs and their recorded revisions in recorded mode and calls
  no API. The tests cover the live paths (free-text search, caps, stored presets, the quota guard, recorded mode on stored
  live runs) with the fixture world standing in for the live transports. g1-a and g1-b (The Anthem, Washington DC) and
  g4-a and g4-b (The Salt Shed, Chicago) have a live show (`presetFor` in `@walkup/orchestrator`); g2 and g3 do not, and a live run of either
  stops with "This preset has no live show yet." before any call, and in live mode the preset pages show the
  bundled fixture until a stored run of the live show's event exists. A live sheet of a preset takes its line and
  real-show wording from the preset's live show only when it planned that show's event; a run recorded before the
  `live` block changed is no longer served as the preset, keeps no preset line or title, and is not re-run as the new
  show.
- Runs, SSE and the send store are in-process: one machine (as deployed). A restart loses a run in progress (its id then
  answers 404) and pending send tokens; complete and paused plans survive in SQLite.
- "None of these: use a proxy" resumes the run with the title as the act's pick and relabels the row as a proxy seed;
  the orchestrator has no native proxy path for a pending act (requested). The summary keeps the orchestrator's
  "(1 pick by the operator)" wording and adds a sentence.
- Fixture runs finish in about a second, so the card-by-card stream is only visible on live runs.
- Duplicate tile names (two geohash cells in one neighbourhood) are shown as the gazetteer names them.
