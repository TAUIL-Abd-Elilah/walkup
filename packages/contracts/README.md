# @walkup/contracts

The shared shapes every package codes against: the status envelope, the provenance ledger, normalized Qloo entities, heatmap cells and lift tiles, the bill and operator inputs, resolution, the Street Sheet cards and their extras (discovery callout, step stream, revisions), the old fair-control arm shapes (kept so older stored sheets load), and the policy constants.

Types and small constants only, no runtime dependencies. Field names are camelCase; raw Qloo field names are normalized inside `@walkup/qloo`.

## Public API

- Types: `Envelope<T>`, `EnvelopeStatus`, `LedgerEntry`, `LedgerSink`, `QlooEntity`, `QlooTag`, `HeatCell`, `LiftTile`, `SheetLiftDiagnostics`, `DemographicsBlock`, `CompareResult`, `Bill`, `Act`, `Venue`, `OperatorInputs`, `DeclaredPartner`, `Resolution`, `Candidate`, `Partner`, `PartnerExplain`, `PartnerConfidence`, `DeclaredPartnerScore`, `PrePostSpot`, `MediaPick`, `CopyHook`, `StreetSheet`, `StreetSheetCards`, `GuardReport`, `SheetDiscovery`, `TraceStep`, `TraceStepKind`, `SheetRevision`, `RevisionToolCall`, `RevisionChange`, `RevisionChangeKind`, `ControlPlace`, `ControlArmResult`.
- Constants: `AGE_BUCKETS`, `WEEKDAYS`, `TRACE_STEP_KINDS`, `REVISION_CHANGE_KINDS`, `DENIED_TAG_PREFIXES`, `DENIED_TAG_KEYWORDS`, `LIMITS_EVERY_SHEET`.
- `withoutControl(sheet)`: the sheet without `control` (the Google Places comparison list older runs stored), its "Without Qloo" step and the limits lines about it. The product no longer produces or shows the list, so pages, exports and MCP drop it on output.
- `createMemoryLedger()`: an in-memory `LedgerSink` that assigns ids per kind (`Q1`, `T1`, `P1`, `C1`, `L1`, `A1`).

## Fields added on Oct 14

All optional, so sheets written before them still load.

| Where | Field | What it holds |
|---|---|---|
| `OperatorInputs` | `allAges?` | The operator says the show is all ages: no bar partners, no alcohol-led pre/post spots. Only adds restrictions; Ticketmaster's age rule still wins when it is stricter. |
| `OperatorInputs` | `excludeCategories?` | Partner category keys to leave out (keys from `resolveCategory` in `packages/engine/src/category.ts`). |
| `OperatorInputs` | `excludeAreas?` | Tile geohashes or gazetteer area names to skip. |
| `StreetSheetCards.liftMap.results` | `liftDiagnostics?` (`SheetLiftDiagnostics`) | Split-half Spearman, lift-vs-heat Spearman, bill floor, method, note. Lives on the lift card, next to the older `diagnostics`; the card's provenance covers it. |
| `Partner` | `explain?` (`PartnerExplain`) | Tags, area, distance, one activation line, confidence and why, limits, ledger refs. |
| `Partner` | `ubiquityPenalty?` | 0..1 penalty for places that turn up for many bills at the room; already applied to `score`. |
| `Partner` | `houseRank?` | Rank in the house-signal twin; `null` when the twin ran without it. |
| `StreetSheet` | `discovery?` (`SheetDiscovery`) | The one area or partner called out at the top, the rule that picked it, and its receipts. |
| `StreetSheet` | `steps?` (`TraceStep[]`) | The step stream: one decision per step, with cause, status and ledger refs. |
| `StreetSheet` | `revision?` (`SheetRevision`) | On a revised sheet: parent plan, the instruction, who read it (`model` or `rules`), tool calls, the list of `RevisionChange`s, or a question back. |

Every new shape that makes a claim carries `ledgerRefs: string[]`, like `PartnerExplain.ledgerRefs`, and uses `EnvelopeStatus` where it has a status.

## Policy constants

`DENIED_TAG_PREFIXES` and `DENIED_TAG_KEYWORDS` are the base denylist. Packages may add to it (the engine adds identity, religion and health terms) but never relax it. `config/tags.json` carries a copy, and `config/test/tags.test.mjs` fails if the two drift apart.

## Changing a shape

Add the field here first, as optional when existing data lacks it, then implement.

## Tests

`npx vitest run packages/contracts` checks the memory ledger, the constants, and (at type level, through `npx tsc -p tsconfig.json --noEmit`) that every field added on Oct 14 is optional and a sheet with all of them filled in type-checks. The constants are also exercised by the engine, narrator, web and config tests (`npm test`, `node --test "config/test/*.test.mjs"`).

## Known limits

Types are not checked at runtime. A sheet read from disk or the network is trusted to match them; validate at the boundary where that matters.
