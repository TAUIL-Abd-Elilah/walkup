# @walkup/mcp

The Walkup MCP server. A promoter's own agent can plan a show's street team without opening the web app. There are five tools, and each returns the same envelope as the web app's JSON API, as `structuredContent` plus a short text digest. The server holds every key; a client sends only what the user typed.

Server-side only: it runs `@walkup/orchestrator`, which loads `better-sqlite3`.

## Tools

| Tool | Input (strict: unknown keys are rejected) | `results` |
|---|---|---|
| `plan_show` | exactly one of `event` (a Ticketmaster event link, or `"Artist @ Venue, Date"`), `presetId` (`g1-a`, `g1-b`, `g2`, `g3`, `g4-a`, `g4-b`; a sample-mode server, with no live Qloo key and no recorded sheets, serves the first four only) or `planId` (resume a paused plan); optional `operator` what-ifs (`seatsLeft`, `capacity`, `mediaBudgetUsd`, `radiusKm`, `streetTeamDays`) and `picks` (`[{input, entityId}]`) | the Street Sheet, ledger included |
| `rank_partners` | exactly one of `planId`, `event` or `presetId`, plus `partnerNames` (1 to 20 names); optional `operator`, `picks` | the user's own list in call order (`DeclaredPartnerScore[]`; `rank: null` means not in Qloo's catalog, kept in your order) |
| `bill_vs_house` | `planId` (a plan or preset id) | lift tiles, the baseline used (`house`, `tag` when a genre tag is pinned, or `none` when there is no lift map), what is distinctive to each side, age and gender skew, and the three card statuses |
| `get_sheet` | `planId` | the Street Sheet, or the pending picks when the plan is waiting |
| `revise_plan` | `planId` (a finished plan or preset id) and `instruction` (1 to 300 characters, the user's own words) | the revised Street Sheet under a new plan id, with `results.revision` (and the envelope's `revision` and `parentPlanId`); or `needs_input` with `question` and nothing changed |

The envelope (`ToolEnvelope`, the same keys as `GET /api/sheet/<planId>`) has these fields:

- `status`: one of `ok`, `empty`, `needs_input`, `partial`, `degraded`, `error`.
- `summary`, `planId`, `mode` (`live` or `fixture`; `recorded` from a server that serves sheets recorded from live Qloo and Ticketmaster runs while live runs are paused, on its refusals and on a live sheet it returns), `results` (a sheet stored before Oct 20 2026 is sent without its Google Places comparison list, which the product no longer shows), `resolution`, `reason`, `provenance` (ledger ids), `limits` ("What this does not establish").
- `sheetUrl` (`/s/<planId>`) and `planUrl` (`/plan/<planId>`).
- `cards`: each card's status.
- Paused plans add `pending` (`[{input, candidates}]`).
- Any call that considered a fresh run adds `freshRuns` (`{leftForCaller, leftToday}`).
- `revise_plan`, and `get_sheet` or `plan_show` on a revision, add `revision` (`{parentPlanId, instruction, interpreter, toolCalls, changes, question?}`), `parentPlanId`, and `question` when it asks back.

Refusals and failures use the same envelope with `status: "error"` and `isError: true`. Input that fails the schema (a wrong type, an unknown key, more than 20 names) is rejected by the SDK before anything runs.

The text block is a digest for agents that read only text. It holds the status and summary, the plan id and share link, the sheet's numbered areas (the same five the Street Sheet page numbers, never two squares of one area) and the top partners with their receipts (`[Q9]`), each card's status and reason, pending candidates with the exact call to resume, and the limits. It adds no places or numbers of its own.

### Ambiguity: resolve, confirm, then ask

A one-word act name with several exact matches (G2: "Sidecar") pauses the run with `needs_input`. Show the candidates to the user, then resume with `plan_show({planId, picks: [{input, entityId}]})`. A pick must be one of the candidates shown for that input; anything else is refused. When several Ticketmaster events match the event text, the pause lists the events instead. Call again with the same `event` and `picks: [{input: <event text>, entityId: <event id>}]`, or pass the event's link.

Picks sent up front follow the same rule. With a preset (what-ifs, or `rank_partners`) they must answer that preset's own pause with one of its candidates. With event text only the event pick is taken. Act picks for a fresh run answer the pause it returns, by its `planId`.

### Preset runs with your changes

A preset with what-ifs, or `rank_partners` on a preset, runs the preset's event, date, what-ifs and seeds as a new plan under its own id. It is never stored as the preset itself, so one caller's partner names or seat counts never become the sheet a preset shows to everyone, and the quota guard's "serve the stored preset" fallback never answers such a run with a sheet that ignores the changes. If the guard does serve a stored sheet for a fresh run, the tool says the guard is on and gives the fresh run back.

A live server runs a preset's live show: the real Ticketmaster bill in its `live` block (`presetFor` in `@walkup/orchestrator`; g1-a, g1-b, g4-a and g4-b have one, g2 and g3 do not; g4-a and g4-b have no sample show of their own). A sample-mode server (no live Qloo key and no recorded sheets) refuses g4-a and g4-b with 503 "g4-a plans a real show only, and this copy of Walkup runs without keys.", as the web app's `POST /api/plan` does, and its instructions and tool descriptions leave them out. For a preset without a live show, preset what-ifs and `rank_partners` on it answer 404 "This preset has no live show yet." before any Ticketmaster or Qloo call and take no fresh run; a run of the preset itself stops with the same reason (a host's own preset loader still answers first). A stored run of the preset is served only while it is a run of the event the preset's show names now.

### Revising a sheet

`revise_plan({planId, instruction})` changes a finished plan with the user's note, e.g. "All ages: no bars", "skip H Street NE", "only Saturday", "within 10 km". The orchestrator reads the note (`readInstruction`): the model with six strict tools when the server has a model key (OpenRouter or Anthropic), the fixed rules otherwise (`revision.interpreter` says which). If the note is unclear, the answer is `needs_input` with `question` and `reason`, and nothing runs or is stored: ask the user and call again. Otherwise the plan re-runs with the new operator inputs (`runRevision`) under a new plan id, stored like any plan, so it can be read with `get_sheet` and revised again. A preset is re-run by its event, never in the preset's slot. `revision.changes` lists settings, areas, partners and pre/post spots added or removed, each with receipts in the new sheet's ledger, and the text digest lists the tool calls and the first 12 changes. A plan that is waiting for a pick answers with its pause; a sheet made in the other mode answers 409. On a recorded server the note is not run (live runs are paused for judging); the refusal says so and names any recorded revision of the plan with its plan id and note. An id with no plan behind it answers 404 "No plan with id <id>.", as `get_sheet` does. A revision is named as the caller's when its note is the same words (case, spacing and punctuation aside), or when the host's reader (`recordedMatch`; the web app passes the reader its revise box uses) reads the note as the change that revision made. Without that reading, a revision for other words is listed with its note to read, not called a different change.

### Caps (docs/spec.md)

Fresh runs are capped at 3 per caller per day and 15 per day in total. A fresh run is an event, preset what-ifs, `rank_partners`, or a `revise_plan` that runs (a question costs nothing; the Qloo cache answers every request whose inputs did not change).

The following are unlimited: presets, picks among a preset's own candidates (each distinct answer is stored once as `<presetId>-<hash>`), resuming a paused run, and reads.

- A run that fails before sending any Qloo request is given back.
- A lookup that finds no event costs nothing.
- Callers are keyed by their address. Limiters keep only a keyed hash.
- The HTTP transport also caps bursts at 120 requests per minute per caller.

At `/mcp` the web app plugs in its own persistent per-IP limiter, so REST and MCP draw on one allowance. Elsewhere `sharedFreshRunLimiter()` (in memory, per process) is the default. Any `FreshRunLimiter` can be injected.

### Policy

- Tools refuse inputs that contain an email address, and political campaign events.
- Partners are "suggested, not affiliated", and every rank result says so.
- Seat counts are what-ifs.
- Every result is scrubbed for the values of `QLOO_API_KEY`, `TICKETMASTER_API_KEY`, `GOOGLE_PLACES_API_KEY`, `CENSUS_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENROUTER_API_KEY`, `RESEND_API_KEY` and `WALKUP_SIGNING_SECRET`. These are replaced by `$NAME`, as in the ledger's copy-as-curl, so no key leaves the server even if a dependency echoes one. Nothing reads `GOOGLE_PLACES_API_KEY` any more; it stays on the list in case an older deploy still sets it.

## Transports

**Streamable HTTP**, mounted by the web app at `/mcp` (`apps/web/app/mcp/route.ts`), runs in stateless mode.

- Each POST gets its own server bound to the caller, and JSON responses (no SSE).
- GET and DELETE answer 405, as the transport spec allows when there is no session. PUT and PATCH get the same JSON-RPC 405 with `Allow: POST, OPTIONS`. OPTIONS answers 204 with the same `Allow`.
- Browser requests from another origin get 403. Bodies over 64 KB get 413.

The route runs on the web app's engine:

- the same deps and plan store, so plans made over MCP open at `/s/<planId>`;
- the same preset sheets;
- the same per-IP limiter;
- the same fixture-mode rule: without live keys only presets run (not g4-a or g4-b, which plan real shows only), and preset what-ifs are free;
- the same recorded-mode rule: the hosted site serves sheets recorded from live Qloo and Ticketmaster runs (Oct 21 2026; most ready-made changes Oct 28 2026) and live runs are paused for judging, so `get_sheet`, `bill_vs_house` and `plan_show` for a preset or plan id read those sheets (envelope `mode: "recorded"`, the sheet's own mode stays `live`, and the text digest says the day each was recorded), and anything that would run answers 503 with `mode: "recorded"`;
- the same quota and rejected-key bookkeeping after live runs.

`handleMcpHttpRequest(request, services, {origin?, clientIp?})` works with any fetch-style server.

**stdio**: `src/stdio.ts`, run with tsx.

- Without keys it runs in fixture mode on the synthetic world. Free-form events resolve against the fixture world's calendar. g4-a and g4-b are refused, as on the web app.
- Fixture runs are free. Live runs keep the caps unless you pass `--unlimited` (only for a server on your own keys).
- Plans go to `WALKUP_DATA_DIR`, default `<repo>/apps/web/.cache/plans.sqlite`.
- `WALKUP_URL` sets the share-link origin. The links open only when that web server uses the same data directory. `npm run dev` runs in `apps/web`, so it keeps its plans in `<repo>/apps/web/.cache` (the root `.env`'s `WALKUP_DATA_DIR=./.cache` resolves there too), which is the stdio default and the folder the examples below use.

## Install

Replace `<url>` with the server's origin (for example `http://localhost:3000` for `npm run dev`) and `/abs/path/walkup` with your clone.

**Claude Code** (remote, hosted or local web server):

```sh
claude mcp add --transport http walkup <url>/mcp
```

Or local over stdio (keys, if any, come from your environment):

```sh
claude mcp add walkup -e WALKUP_DATA_DIR=/abs/path/walkup/apps/web/.cache -- \
  node /abs/path/walkup/node_modules/tsx/dist/cli.mjs /abs/path/walkup/packages/mcp/src/stdio.ts
```

**Claude Desktop**: add a custom connector with the URL `<url>/mcp` (Settings, Connectors). Or run it locally over stdio from `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "walkup": {
      "command": "node",
      "args": [
        "/abs/path/walkup/node_modules/tsx/dist/cli.mjs",
        "/abs/path/walkup/packages/mcp/src/stdio.ts"
      ],
      "env": {
        "WALKUP_DATA_DIR": "/abs/path/walkup/apps/web/.cache",
        "WALKUP_URL": "http://localhost:3000"
      }
    }
  }
}
```

Add `QLOO_API_KEY` and `TICKETMASTER_API_KEY` (and optionally `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`, `CENSUS_API_KEY`) to `env` only for a server on your own keys; they never leave that process. On Windows, use paths such as `C:/path/walkup/...`.

**OpenClaw**:

- The bundled skill [`skills/walkup`](../../skills/walkup/SKILL.md) uses the same server over REST. Set `WALKUP_URL`.
- To use the MCP tools instead, register a server named `walkup` in your OpenClaw MCP bridge (for example mcporter). Give it either the Streamable HTTP URL or the stdio command above, in the same `mcpServers` form:

```json
{ "mcpServers": { "walkup": { "url": "<url>/mcp" } } }
```

Then call `walkup.plan_show` with `{"presetId": "g1-a"}`. Field names for a URL server differ between bridges (`url` or `baseUrl`), so check your bridge's docs.

Try it in fixture mode:

- `plan_show {"presetId": "g2"}` pauses on "Sidecar". Resume it with `{"planId": "g2", "picks": [{"input": "Sidecar", "entityId": "<the person candidate>"}]}`.
- `bill_vs_house {"planId": "g3"}` shows a bill with no baseline (`none`): too few of the comedy room's acts matched and comedy has no genre-wide map, so there is no lift map.
- Over stdio: `plan_show {"event": "Hollis Creek String Band @ The Truth, Nov 20 2026"}`.

## Public API

```ts
import { createFixtureServices, createWalkupMcpServer, handleMcpHttpRequest } from "@walkup/mcp";

const services = createFixtureServices();                 // or createServicesFromEnv(process.env) / createMcpServices({deps, store, limiter, ...})
const server = createWalkupMcpServer(services, { ip, origin, transport: "http" });
const res = await handleMcpHttpRequest(request, services, { origin, clientIp });
```

**Server and transport**

- `createWalkupMcpServer`
- `handleMcpHttpRequest`
- `toCallResult`
- `SERVER_INSTRUCTIONS` (a live or recorded server's), `serverInstructions(sample)`

**Tool functions (REST twins)**

- `planShowTool`, `rankPartnersTool`, `billVsHouseTool`, `getSheetTool` and `revisePlanTool`, each `(services, caller, args) -> {envelope, httpStatus}`. `httpStatus` is 200, 400, 404, 409, 422, 429, 500 or 503.
- `billVsHouseOf(sheet)`

**Services**

- `createMcpServices`, `createFixtureServices`, `createServicesFromEnv`, `getEnvServices`
- `McpServices`, which has these hooks:
  - `presetView(presetId, "page" | "api")`: the host's own preset sheets.
  - `afterRun(result, deps)`
  - `policy`: `{fixtureEventRuns, capFixtureRuns, fixtureRefusal, recorded}` (`recorded`: the reason anything that would run is refused with while live runs are paused, or null)
  - `recordedMatch(parentPlanId, instruction, ip)`: recorded state only; reads a revise note the host's way and answers `{planId}` (the recorded revision that makes that change, or null when none does), or null when the note was not read
- `PLANS_DB_FILE` (`plans.sqlite`)

**Envelopes**

- `sheetEnvelope`, `pausedEnvelope`, `errorEnvelope`
- `sheetStatus`, `worstStatus`, `cardStatuses`
- `sheetUrlFor`, `planUrlFor`
- `scrubSecrets`, `scrubText`, `secretsFromEnv`
- `viewOfStored`, `viewOfResult`, `envelopeOfView`
- `PlanView`

**Schemas**: `PlanShowInput`, `RankPartnersInput`, `PlanRefInput`, `RevisePlanInput` (a live or recorded server's), `toolInputs(sample)` (the same fields, with a sample-mode server's preset lists), `presetIdsFor(sample)`, `EnvelopeOutput`. `sampleOnly(services)` says whether a server is in sample mode (fixture deps, no recorded sheets).

**Limits**

- `FreshRunLimiter`, `createMemoryFreshRunLimiter`, `createUnlimitedFreshRunLimiter`, `sharedFreshRunLimiter`
- `createRequestRateLimiter`
- `callerKey`, `clientIpFrom`

**Events and policy**

- `lookupEvent`, `tmEventIdFromUrl`, `slugHints`
- `containsEmail`, `looksPolitical`, `inputProblem`
- `envelopeText`

## Test

```sh
npx vitest run packages/mcp
npx tsc -p packages/mcp/tsconfig.json --noEmit
```

The tests run on the fixture world with nothing on the network:

- An in-memory MCP client calls every tool, and the client validates each `structuredContent` against the output schema.
- The envelopes match the web app's `sheetEnvelope` (keys, status, reason and links), and the web validator accepts the sheets.
- needs_input and resume, including refused picks (also when sent up front); event text and links, with the several-events pause.
- Preset runs with the caller's changes stay out of the preset's own slot, also while the quota guard is on.
- Refusals: unknown presets, unknown plans, emails, campaigns, and strict-schema rejections.
- Caps: per caller, daily, refunds, the injected limiter and the UTC reset. Secret scrubbing.
- Host hooks and policy.
- The Streamable HTTP transport through the SDK's own HTTP client: per-IP keys from proxy headers, 405, 403, 413, 406 and 429.
- The stdio entry spawned with tsx.
- `test/mcp-fixes.test.ts`: a sample-mode server refuses g4-a and g4-b and never lists them, a recorded one lists all six; the digest lists the sheet's numbered areas; `revise_plan` on a recorded server says an unknown id is unknown; PUT and PATCH get the JSON-RPC 405.
- `revise_plan` (`test/revise.test.ts`): a revised preset with its change list and receipts, re-read and revised again, a question that runs and stores nothing, refusals, and caps taken only when it runs.

## Known limits

- **Live runs paused on the hosted server.** The hosted `/mcp` runs in recorded mode while live runs are paused for judging: it serves the four sheets run live on Oct 21 2026 (live mode, `createDepsFromEnv`) and their ready-made changes, and calls no API. `get_sheet`, `bill_vs_house` and `plan_show` for a preset or a recorded plan id read those sheets; `revise_plan` names any recorded revision of the plan; anything that would start a new run answers 503 with `mode: "recorded"`. Fresh runs need a server with your own Qloo and Ticketmaster keys.
- **Ticketmaster links.**
  - A link is read only for its id (it is never fetched).
  - When Discovery does not serve a link's page id, the server searches by the slug's words and date. It matches the event whose own link carries that id.
  - Not checked against live links yet.
- **Response size.** A recorded live sheet on the hosted server is about 350 to 530 KB of `structuredContent` (the four live presets 430 to 480 KB; the ledger is 7 to 10 percent of it). A sample sheet is up to about 160 KB (G3, with no lift map, about 45 KB); its ledger is a quarter to a third of it. If a client passes structured content to the model and limits tool output, raise its limit (Claude Code: `MAX_MCP_OUTPUT_TOKENS`). Or use `bill_vs_house`, which returns about 20 to 27 KB for a recorded live sheet and about 12 KB for a sample bill with a lift map (G3, with none, about 3 KB). `rank_partners` returns about 5 to 15 KB on the sample world (about 13 KB for the 8 partners G1-A declares); it runs the plan again, so the hosted server refuses it.
- **Stateless HTTP.** There is no progress streaming: a live fresh run (15-25 s) answers when it is done. Clients must allow that long a request.
- **Default limiter.** It counts in memory per process. The web route's limiter persists under `WALKUP_DATA_DIR`.
- **Proxy picks.** There is no "None of these: use a proxy" pick over MCP (the web app's `proxyPicks`). Use the web app for that.
