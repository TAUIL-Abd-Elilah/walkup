# @walkup/narrator

Every place Walkup calls Claude (`claude-haiku-5-5` through OpenRouter, `claude-opus-5-5` through the Anthropic API), and nothing else. `runControlArm` and `runLlmOnlyArm` are called by nothing since the product's arm F was removed on Oct 20 2026 (the P1 research harness has its own model arms in `evals/p1/arms/model-arms.ts`); they stay, with their tests, until the owner decides.

| Function | What it does | Effort |
|---|---|---|
| `narrate(input, opts)` | Summary, one line per lift tile, one line per partner, three copy hooks. Schema-bound to this run's ids, then re-checked by a deterministic guard. | low |
| `templateNarrate(input)` | The same fields built only from run facts. Runs when the LLM is off, over budget, refused, unparseable, or in tests. | none |
| `runControlArm(input, tools, opts)` | Arm F, the fair control: same model with Places text search and ACS lookups instead of Qloo. Returns a ranked `ControlArmResult` (arm `"F"`). | medium |
| `runLlmOnlyArm(input, opts)` | Arm L: same model and system prompt, no tools. For the eval page only. | medium |
| `parseShowQuery(text, opts)` | Free text to `{artist, venue?, city?, date?}` for a ticketing lookup, with a deterministic fallback. | low |
| `readRevision(summary, note, opts)` | An operator's change note about a finished sheet to tool calls (six strict tools), or a question. Falls back to `readRevisionByRules`. | medium |
| `readRevisionByRules(summary, note)` | The same tool calls from fixed rules for common phrasings, or a plain question. No model. | none |
| `findOverlapPairs` / `overlapNames` | Qloo partner vs control place: token-set name similarity >= 0.85 and <= 150 m, one-to-one. | none |
| `vetNarration(sheet, narration?)` | The claim guard (`@walkup/narrator/vet`, no SDK or network imports, so the web app runs it on stored sheets too). A summary, tile or partner line is replaced by the template's line for that slot when it gives an area a compass direction the map does not show (8 points from the venue, the neighbouring point allowed), forecasts ("expected"), says "concentrated" or "most common", uses a superlative that is not the sheet's maximum (lift, bill percentile, adults, budget split), or, for a partner, names a genre or tag that is not among its "Tags it shares" (`explain.tags`) or a weekday other than the street-team day. narrate() runs it on the model's lines and records each replacement in `guard.reasons`. | none |
| `vetCopyHooks(sheet, hooks?)` / `vetWhatsDifferent(tags)` / `isAudienceTag(tag)` | Fan copy: drops lines with audience or identity tags or words (diverse, supportive, civic minded, male, English, ...) and puts the headliner in front of a line that names no act; with nothing left, "<Act> at <Venue>, <Weekday, Mon D>.". "What's different": each tag once, no audience or identity tags. Copy hooks from the model and the template name the act and never use audience tags. | none |

Qloo decides; this package narrates. Scores, ranks and tiles come from `@walkup/engine` and arrive here as data.

## Providers

`createNarratorClient(env)` picks the route; every function above takes the result as `client`:

| Keys set | Route | Client |
|---|---|---|
| `OPENROUTER_API_KEY` | OpenRouter, `https://openrouter.ai/api/v1/chat/completions`, model `anthropic/claude-haiku-5.5` (`OPENROUTER_MODEL` overrides) | `createOpenRouterClient` (`src/openrouter.ts`) |
| `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` (and no OpenRouter key, or `WALKUP_LLM_PROVIDER=anthropic`) | Anthropic Messages API through `@anthropic-ai/sdk` | `createAnthropicClient` |
| neither | none: narration uses the labelled template, change notes the fixed rules | `null` |

The OpenRouter client takes the same Messages API request and returns the same message shape, so the callers do not know which route ran. What carries over and what does not:

| Feature | Anthropic route | OpenRouter route |
|---|---|---|
| Tools, `strict: true`, `tool_choice: auto`, parallel calls | yes | yes: sent as Chat Completions functions with `strict` |
| `is_error` on a tool result | yes | no flag in Chat Completions: the result text starts with `Error: ` |
| Structured output (`output_config.format`, per-run enums) | yes | `response_format: {type: "json_schema", strict: true}`; the answer is parsed and guarded the same way either way |
| Effort (`low` / `medium`) | `output_config.effort` | OpenRouter's `verbosity` (`xhigh`/`max` become `high`) |
| Thinking echoed in a tool loop | the assistant turn is sent back unchanged | `reasoning_details` from a tool-calling turn are sent back with that turn |
| Prompt caching | `cache_control` on the system block | the same `cache_control` on the system text part; cached and written tokens are read from `prompt_tokens_details` |
| Server-side refusal fallback (`server-side-fallback-2026-07-01`) | yes | **no**: `betas` and `fallbacks` are dropped; a refusal (`content_filter`, or Anthropic's own `refusal` when OpenRouter passes it through) goes to the template or the rules |
| `stop_details` (refusal category) | yes | no (null) |
| Provider routing | n/a | `provider.require_parameters: true`, so OpenRouter only routes to a host that supports every parameter sent (tools, response format) |
| Retries | the SDK's (2, on 408/409/429/5xx) | the same policy in the client: 2 retries on 408/409/429/5xx and network errors, 1 s then 2 s |
| Ledger | `/v1/messages`, curl with `$ANTHROPIC_API_KEY` | `/api/v1/chat/completions`, curl with `$OPENROUTER_API_KEY`, `provider: "openrouter"` in params |
| Spend guard | Anthropic list rates | the same rates (the slug is mapped to the Anthropic model id by `canonicalModel`; Opus, Sonnet and Haiku 5.5 are listed); OpenRouter's own invoice can differ slightly |

`npm run llm:check` sends three small synthetic requests through whichever route `.env` selects (a two-tool revision, a note naming an area that is not on the sheet, and a schema-bound narration) and prints PASS/FAIL with the ledger. Run it after changing keys or the model slug. Behind an HTTPS proxy, Node's `fetch` needs `NODE_USE_ENV_PROXY=1`.

Checked live on Oct 20 2026 through OpenRouter (`anthropic/claude-opus-5.5`): "All ages, no bars" came back as two tool calls in one turn (`set_all_ages`, `exclude_partner_categories` with every bar key), the unknown area came back as `ask_operator`, and the narration parsed against the per-run schema with no guard drops; `verbosity` was accepted. The `is_error` correction turn is covered by tests only: the model made no invalid call live. The same three checks passed on `anthropic/claude-haiku-5.5` on Oct 20 2026, which became the default.

## Request shape (all calls)

As built by this package (the Anthropic route sends it as is; the OpenRouter route translates it as above):

- `client.beta.messages.create` with `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"` (server-side refusal fallback, scalar form).
- `output_config.effort` set explicitly. No `thinking` param (thinking is always on for this model; sending `disabled` or a budget is a 400). No forced `tool_choice`, no prefill, no sampling params.
- Frozen system prompt in one text block with `cache_control: {type: "ephemeral"}`. Run data goes in the user message inside `<run_facts>` / `<show>` / `<query>` and is treated as data.
- `stop_reason` is checked before content is read. Text is read after the last `fallback` block, so a declined partial answer is never parsed.

### Why not `messages.parse` + `zodOutputFormat`

Checked against `@anthropic-ai/sdk` 0.133:

1. The non-beta `messages.parse` has no `betas` / `fallbacks` params.
2. `beta.messages.parse` does accept them, but parses inside the promise and throws on a validation failure, which loses `stop_reason` and `usage`. The spend guard needs usage from every billed call, refused or not.
3. `zodOutputFormat()` runs the SDK's `transformJSONSchema`, which keeps only `format` on string nodes and moves `enum` into the description. The per-run id enums would become a hint instead of a decoding constraint.

So each call uses `beta.messages.create` with `output_config.format` built by `jsonOutputFormat()` (`src/json-schema.ts`, zod's own `z.toJSONSchema` with `enum`, `anyOf` and `additionalProperties: false` kept, unsupported keywords dropped) and parses the text block with the same zod schema. A parse failure returns null, never throws.

## Narration

```ts
import { narrate, SpendGuard, createFileSpendStore, createAnthropicClient } from "@walkup/narrator";

const result = await narrate(
  { bill, tiles, partners, prePost, media, compareTags, allowlistTags, numbers: [{ label: "seats left (what-if)", value: 340 }], hypothetical: true },
  { client: createAnthropicClient(), spend: new SpendGuard({ store: createFileSpendStore(".cache/anthropic-spend.json") }), ledger },
);
// result: { summary, tileWhy[], partnerLines[], copyHooks[], templated, templateReason, usage, guard, ledgerRefs }
```

- **Per-run schema.** `geohash`, `entityId` and `tagIds` are `z.enum` over the ids in this run (tiles; partners + pre/post + media; allowlisted tags). A field whose id set is empty is left out and comes back as `[]`.
- **Allowlist.** `allowlistTags` is filtered again through the contracts tag denylist (which includes `urn:tag:customer_identity:`) and the engine's wider term list (`isDeniedTag` from `@walkup/engine`: identity, religion and health words on tags outside the denied namespaces); on a show that is not 21+ per the ticketing age policy (`legalAgeEnforced !== true`, never inferred from Qloo) alcohol tags are removed too. Only the remainder is shown to the model, enumerated or used by the template. `guard.deniedTagCount` reports how many were removed.
- **Guard** (`guardNarration`), after parsing: ids re-checked; every number in a line must be a run number (rounding to fewer decimals and x100 percent forms allowed; digits inside names, addresses, hours, ZCTAs and the date allowed); no show-status words ("soft", "tracking", ...), no exclamation marks, no denied keywords (contracts list plus the engine's `findDeniedTerm`), no product hype words, no alcohol words ("beer", "happy hour", "21+", ...) unless the show is 21+; copy hooks must use at least one cited tag name and no act name; at most 3 hooks. Failing lines are dropped and counted in `guard.dropped` / `guard.reasons` (a denied keyword or term is never repeated in the stored reason). A failing summary is replaced by the template summary.
- **Template copy lines.** Only genre and audience tags fill the copy slots (never adjectives or themes such as "Cozy" or "Friendship"); tag names read in lower case inside a sentence (acronyms kept) and lose a trailing " fans" before "crowd" (`tagInProse`, `isSlotTag`). With fewer usable tags the template writes fewer lines instead of filling a slot. The guard accepts a cited tag name with its " fans" dropped.
- **Rules interpreter edges.** "family show", "under 21s welcome" and "kids welcome" mean all ages; "no under 21s", "not for under 18s" and "not family friendly" mean not all ages. A note that both sets and clears all ages ("all ages, not 21+", "No 21+ venues") gets a question; `mergeReviseCalls` lets a true all-ages value win over a later false from the same note. `readRevision` never throws: a rules error becomes a question.
- **Fallback to template** on: no client (`llm_off`), cap reached (`over_budget`), `refusal`, `max_tokens`, unparseable or off-schema output (`parse_failed`), thrown API error (`api_error`). `usage` is still reported when a call was billed.

## Spend guard

`estimateCostUsd(usage, model)`: $4 / MTok input, $20 / MTok output (thinking is billed as output), $0.20 / MTok cache reads, $5 / MTok cache writes (5-minute TTL). When `usage.iterations` is present (a fallback ran), each iteration is priced at its own model's rate; a model not in the table is priced at a conservative top-tier rate.

`new SpendGuard({ store, dailyCapUsd = 5, now })` keys spend by UTC day. Stores: `createMemorySpendStore()`, `createFileSpendStore(path)` (fails closed on a corrupt or unreadable file: `get` reports the cap as reached and `add` throws instead of overwriting the day's total), or any `{get(day), add(day, usd)}`. Each call checks `canSpend(reserveUsd)` first and records its estimate after. If recording fails, the billed answer is still used and the ledger note says `spend not recorded: ...`.

## Arm F (fair control)

```ts
const run = await runControlArm(
  { bill, operator, center: { lat, lon }, radiusM: 5000, categories: ["record_store", "cafe"] },
  { placesSearch: (query, center, radiusM) => places.textSearch(...), acsLookup: (q) => acs.lookup(q) },
  { client, spend, ledger, qlooPartners: partnersToCandidates(partners) },
);
```

- Tools: `places_search {query}`, `acs_lookup {zcta|null, lat|null, lon|null}`, `submit_ranking {places: [{place_id, reason}]}`. All `strict: true` with `additionalProperties: false`; `tool_choice: {type: "auto"}`.
- `categories` (optional) are the partner categories the Qloo arm searched; they go into `<show>` so both arms get the same inputs.
- Manual loop, at most 8 model turns. Parallel `tool_use` blocks run concurrently (results merged in `tool_use` order, so the output does not depend on which search returns first) and all `tool_result`s of a turn go back in one user message; failures go back with `is_error: true`. The assistant turn is echoed unchanged. No tool call at all: one re-prompt, then `no_ranking`. Before the last turn a text block asks for `submit_ranking`; searches requested on the last turn are not run (`iteration_limit`).
- Ranking validation: only place ids that `places_search` returned before the submission survive; others are dropped and counted (`droppedUnseen`, `droppedIds`); duplicates removed; max 20.
- The same system prompt and tool list on every run (and arm L shares the system prompt). Operator contact emails are never sent; declared partners go by label only.
- Result: `ControlArmRun` = contracts `ControlArmResult` + `status`, `iterations`, `queries`, `toolErrors`, `reasons`, `usage`, `notes`.

Arm L returns names the model produced without tools, with synthetic ids `unverified:N` and no coordinates, so overlap with Qloo is empty unless a caller geocodes them.

## Revisions

```ts
import { readRevision, type ReviseSummary } from "@walkup/narrator";

const read = await readRevision(summary, "All ages: no bars", { client, spend, ledger });
// read: { interpreter: "model" | "rules", calls, made, question, fallback, notes, usage, ledgerRefs }
```

- **Input.** `ReviseSummary` (built by the orchestrator's `reviseSummary(sheet)`): show facts, the settings the tools change (all ages, street-team days, radius, excluded place types and areas), the areas on the sheet (name, geohash, partner count) and the place-type keys with counts. No partner names, no contacts. The note goes in `<note>`, the summary in `<sheet>`, both as data.
- **Tools** (`buildReviseTools(summary)`, all `strict: true`, closed objects, every property required): `set_all_ages {allAges}`, `exclude_partner_categories {categories}` (enum: the sheet's place-type keys), `exclude_areas {areas}` (enum: the sheet's area names and geohashes), `set_street_team_days {days}` (enum: weekdays), `set_radius {km}` (5 to 60, checked after the call), `ask_operator {question}`.
- **Request.** `beta.messages.create`, `tool_choice: {type: "auto"}`, `effort: "medium"`, the scalar fallback beta, frozen system prompt with `cache_control`, no `thinking` param, no prefill. `stop_reason` is checked first: a refusal is never read.
- **Loop.** At most 3 model turns. Every call is checked again by `checkReviseCall` (case-insensitive, returned in the sheet's spelling). When every call of a turn is valid, the loop stops there (one model call in the common case; the model's closing text is not needed). An invalid call goes back with `is_error: true`, all results of the turn in one user message, and the model may fix it. No tool call: one re-prompt, then a question. Repeated calls are merged (`mergeReviseCalls`: the last `set_*` wins, exclusions add up).
- **Question.** `ask_operator`, or a note nothing could be read from, gives `question` and empty `calls`: the caller changes nothing.
- **Fallback.** No client (`llm_off`), the spend cap (`over_budget`), `refusal` or an API error: `readRevisionByRules` reads the note, `interpreter: "rules"` and `fallback` say why, and any billed usage is still reported.
- **Rules.** Clauses split on punctuation and on "and"/"but"/"then" when a new instruction follows. Understood: all ages (or clearing it: "21+", "adults only"), "no/skip/without/drop/exclude/not in X" where X is a place type (bars means every bar key on the sheet), an area name or geohash, or a weekday; weekdays ("only Saturday", "Fri and Sat"); a radius in km or miles with "within", "radius", "under" and the like. An area word that fits several names, a value out of range, or any clause it cannot read gives a question and no calls.
- **Labels.** `describeReviseCall` gives the one-line summary for each call ("Left out bars and other drinking places", "Street team works Saturday only"); `categoriesInWords` and `categoryWord` are shared with the orchestrator's change list.

## Testing

```bash
npx vitest run packages/narrator
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "packages/narrator"
```

Tests inject a mock client (`test/helpers.ts`) or, for the OpenRouter route, a fake `fetch` (`test/openrouter.test.ts`); nothing calls an API. Synthetic names and ids only. Covered: enums reject foreign ids and keep `enum` in the wire schema, refusal / parse failure / `max_tokens` / API error / spend cap fall back to the template, text after a fallback block, guard drops, the age-policy alcohol rule and identity-tag filter, parallel `tool_use` with `is_error` and order-independent merging, unseen place ids dropped, the 8-turn cap, re-prompt, overlap thresholds, cost math, file store (including no overwrite of a corrupt file), a failing spend store, show-query parsing, and revisions (`test/revise.test.ts`: tool schemas and enums from the sheet, the call checker, every rules phrasing and its questions, the model request shape, one turn when every call is valid, `is_error` and the fix, `ask_operator`, the re-prompt, and the rules fallback on refusal, API error and the spend cap).

## Known limits

- On the OpenRouter route there is no server-side refusal fallback and no refusal category; an `is_error` tool result is marked by its text only.

- The per-run schema changes every run, so the structured-output grammar is compiled per request (some first-request latency) and the cached prefix covers the system prompt only when it reaches the model's minimum cacheable length.
- The number guard is lexical: it catches digits, not spelled-out numbers ("three"), and it allows a run number used in the wrong context.
- The alcohol and keyword checks are word lists: they can miss a brand name and can drop a harmless line ("racetrack" trips the "race" keyword). Names from the run are blanked before checking.
- The daily cap is checked before each call, so one call can overshoot it by that call's cost. The file store is single-process.
- Arm F's quality depends on the injected `placesSearch`; this package does no rate limiting of its own.
- `parseShowQuery`'s fallback parser handles "Act at Venue, City on date" shapes only and never guesses a year.
- The revise tools' enums change with every sheet, so the tool list is not part of a stable cached prefix. The rules interpreter knows a fixed list of phrasings and English place-type words; everything else needs the model or gets a question.
