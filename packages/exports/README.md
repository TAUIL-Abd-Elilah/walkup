# @walkup/exports

Pure functions from a `StreetSheet` (see `@walkup/contracts`) to the files an operator takes away: the one-page Street Sheet PDF, the street-team calendar, four CSVs and `sheet.json`. No network, no clock (every date comes from the sheet), no disk writes. The same sheet always gives the same CSV, ICS and JSON bytes.

## Files

| File | Function | What it is |
|---|---|---|
| `street-sheet.pdf` | `toPdf(sheet, opts?)` | One page, US Letter (A4 with `pageSize: "A4"`): a day sheet for the street team with the partner table as a form (below). |
| `street-team.ics` | `toIcs(sheet, opts?)` | RFC 5545 calendar: top-tile visits by street-team day, plus the show. |
| `partners.csv` | `partnersCsv(sheet, opts?)` | The call list: suggested partners (with activation, why and confidence when the run built them), then the operator's own list in call order. |
| `zips.csv` | `zipsCsv(sheet, opts?)` | `zip, lift_score, suggested_weight` from the top tiles' ZCTAs. |
| `pins.csv` | `pinsCsv(sheet, opts?)` | `lat, lon, radius_mi` (radius never under 1 mile), one pin per top tile. |
| `offer-codes.csv` | `offerCodesCsv(sheet, opts?)` | Promo-code rows to create in the operator's ticketing platform. |
| `sheet.json` | `toSheetJson(sheet, opts?)` | The whole sheet, ledger included, in a small versioned envelope. A sheet stored before Oct 20 2026 loses its Google Places comparison list first (`withoutControl`). |

`toExportFiles(sheet, opts?)` returns all of them (or `include: [...]`) as `{ kind, filename, contentType, data: Buffer }`, ready to attach to an email or zip. Fixture sheets get a `fixture-` file-name prefix so a file never passes for a live run once it leaves the app; inside the files, the same plain sentence (`FIXTURE_NOTICE`: "Sample data: made-up places and numbers, not a live run.") is on the PDF (with a "Sample data" header label and one light watermark), in `sheet.json` as its `notice`, in every `partners.csv` row's `notes` and in each calendar description; calendar summaries and offer-code descriptions start with `[Sample] `. `zips.csv` and `pins.csv` keep the bare ad-platform format and rely on the file name.

### The PDF

It looks like a crew day sheet: black text on white, thin rules, one accent ink (the ticket-stub red `#b42318`) for the map tiles only, regular and bold Helvetica, sentence-case headings, no badges or pills. The web print page (`/s/[id]`) renders the same `buildSheetModel` strings with the same section names as the plan page ("Where this crowd stands out, compared with the room's usual crowd", "Before and after the show", "Partners (24)", "Your list", "What this sheet doesn't show", "Requests behind this sheet"), so paper, screen and PDF say the same things.

- **Header (day sheet):** top left "Walkup street sheet" (plus "Sample data" on a fixture sheet), the bill with the headliner in bold and the rest after "with" (`headliner`, `support`), then the age rule, street-team days and radius. Top right: the date (and the show's name when `showName` is passed), the room, "21 days to the show" (days from the plan's `createdAt` to the show; `asOf` overrides) and the counts as "n of m" ("640 of 1,200 seats left", "Capacity 4,400"), with "(what-if)" on a what-if sheet; "Counts are what-ifs" appears only on a what-if sheet that prints no count. The age rule comes from Ticketmaster; the operator's `allAges` setting can only add to it ("All ages (operator setting)", "21+ (no bars: operator setting)"). One rule under the header. A thin signal is said once under it ("The signal is thin here, so treat this as a starting list."); the planning-tool note is left out when the sheet's limits already say it.
- **Watermark:** one light diagonal line, never two: "Sample data" on fixture sheets, "What-if counts" on live what-if sheets. A live sheet with real counts has none.
- **Discovery line** (when `sheet.discovery` exists): "Start with this place: {headline}. {detail}" (or "Start in this area") with its receipts, and one muted "Why this one: ..." line under it (the full rule is on the system card).
- **Where this crowd stands out, compared with the room's usual crowd** (or with fans of the genre on a tag baseline; left) beside **Before and after the show** (right). The map is an SVG of geohash-6 cells about 60 mm wide, framed on the numbered areas and the venue, in the accent at the web maps' steps, with a light kilometre grid, a scale bar, ink circles with white numbers that match the list, and the venue as an ink square. Under it, the key in one line with the web legend's four steps ("under 1.0x", "1.0 to 1.3x", "1.3x", "2.2x and up") and a caption naming the baseline (`legendCaption`). Beside it: areas 1-5 with lift, ZIPs and the narrator's why line (the area's name is not repeated). Under both: what the map is compared with and the split-half check. The spots are a small table: spot (with receipts), type ("Bar, not for fans" on an operator-only spot), distance, share of the crowd, and the rank for this crowd against the usual crowd ("3 places higher"), with the capacity assumption said once (`shareNote`) and the age policy.
- **Partners, as a form** (full width): a tick box, the row number, the place (name and type, then the address and phone, or "Phone not listed"), the area's map number and name, the hours on the first street-team day in words ("4 pm to 2 am"; "Hours not listed: call first", on a pale yellow row, the one thing to act on), the why line with its receipts ("Ranks 8th here for this crowd, 20th for the room's usual crowd.", "check first" when confidence isn't high), and a blank Notes column (22% of the width). Rows are 7 mm tall at full size. Receipts are one quiet, sorted group per row (`receiptGroup`: "Q6-Q7, Q13 +2"). Footer: "Suggested, not affiliated: no partner has agreed to anything." With `audience: "fan"` on a show not known to be 21+, bars are left out and counted.
- **Foot of the page, three columns:** "Your list" in call order (ranked first, then "not in Qloo's catalog, kept in your order"); "What this sheet doesn't show" (`sheet.limits`, or `LIMITS_EVERY_SHEET` when empty; every sheet prints them); "Requests behind this sheet" ("30 requests: Q1-Q28, T1-T2. Receipts for every Q number: {ledgerUrl or sheet.json}. Plan g1-a.", a link when `ledgerUrl` is absolute), a line saying podcasts, the sponsor pick, copy lines and the budget split are on the web sheet and in `sheet.json` (`footer.elsewhere`), and the data credits; on a fixture sheet the credit line says the data is a sample shaped like Ticketmaster and Qloo answers. "Sample" appears only in the header, the footer line and the watermark.
- **One footer line** (`footer.printLine`): "Hollis Creek String Band · The Truth · Fri Nov 20 · printed Wed Oct 14 2026 · data from Fri Oct 30 2026 · Sample" (the last word on fixtures only; `printedAt` overrides the clock).
- The model still carries panels 5 and 6 (podcasts and sponsor, copy lines) and the budget split for the web sheet, `sheetModelText` and other views; the paper leaves them out so the partner form fits one page.

**Fitting one page.** `renderStreetSheetPdf` renders at full size with 7 mm form rows, then at smaller type with rows no taller than their text needs (down to 74%), then with shorter lists (15 partners, 6 declared, 6 spots); omitted rows are counted on the sheet ("+N more partners in partners.csv"). It returns `{ buffer, pages, scale, truncated }`. `fit: false` renders once at `scale`.

**Text.** The PDF uses the built-in Helvetica faces, which only draw Windows-1252 characters. Every string goes through `pdfText`: arrows and maths signs get ASCII stand-ins, accented letters outside the set lose the accent, anything else becomes `?`.

The tree is plain `React.createElement` calls on react-pdf primitives (no components, no hooks): `streetSheetDocument(sheet)` returns it, `buildSheetModel(sheet)` returns every printed string, and both are tested without rendering. `buildSheetModel` is also exported on its own as `@walkup/exports/sheet-model`, so a page can use it without loading the PDF renderer.

### The calendar

- `streetTeamDays` (default: the sheet's) picks the last occurrence of each weekday in the 7 days before the show; `weeks` repeats for earlier weeks; dates before the plan's creation date are skipped (`notBefore` overrides).
- Within each week the top tiles are dealt round-robin over that week's days in lift order, then run back to back from `startTime` (10:00) with `visitMinutes` (90) and `gapMinutes` (30). A day with too many visits is compressed so it ends before midnight; if that would leave under 10 minutes per visit, the day starts earlier instead, so no visit runs past midnight or ends before it starts. With no tile at 1.3x or more, each day gets one visit to the partners near the venue.
- Each visit: SUMMARY, LOCATION, GEO (tile centre), DESCRIPTION (tile, lift, ZIPs, partners with address, hours and phone, the "suggested, not affiliated" line and ledger refs), `STATUS:TENTATIVE`. The show is an all-day event, or a timed one with `showStartTime`.
- CRLF line endings, lines folded at 75 octets without splitting UTF-8 characters, TEXT escaped (`\\`, `\;`, `\,`, `\n`).
- UIDs are `hl-{planId}-{yyyymmdd}-{geohash}@walkup` (`uidDomain` overrides) and the show's `hl-{planId}-show@...`; re-importing an updated plan updates events instead of duplicating them. DTSTAMP is the plan's `createdAt`.
- **Time zones:** times are floating local times by default (no TZID): "10:00" means 10:00 on the wall clock wherever the calendar is opened, which is right for a street team in the venue's city. Pass `timeZone` with one of `SUPPORTED_TIME_ZONES` (America/New_York, Detroit, Chicago, Denver, Phoenix, Los_Angeles, Anchorage, Pacific/Honolulu) to pin times with a VTIMEZONE using the US rules in force since 2007. Other zones fall back to floating times rather than inventing rules. Without `timeZone`, `toIcs` uses `sheet.bill.venue.timeZone` (Ticketmaster's venue timezone, filled by `@walkup/tm`), so sheets made from a Ticketmaster event get a VTIMEZONE when the zone is supported.

### The CSVs

All CSVs follow RFC 4180: header row, CRLF after every record, a field quoted only when it holds a comma, a double quote, CR or LF, inner quotes doubled. Output is UTF-8; `bom: true` adds a byte order mark (`toExportFiles` adds one to `partners.csv` and `offer-codes.csv`, which people open in spreadsheets, and never to `zips.csv` or `pins.csv`). Text cells that a spreadsheet would run as a formula (`=`, `@`, or `+`/`-` followed by anything other than a plain number or phone number) are prefixed with `'`; numbers are never touched. `formulaGuard: false` turns this off.

- **partners.csv** columns: `call_order, list, name, category, tile, tile_lift, address, hours_on_day, phone, website, contact_email, activation, why, confidence, affiliation, receipts, chips, qloo_entity_id, qloo_rank, score, called, outcome, notes`. `contact_email` is only ever an address the operator typed on their own list. `activation`, `why` (tags, then "High confidence: ..." and the explain limits) and `confidence` come from `partner.explain` and are blank without it and on the operator's own list. `called` and `outcome` are blank for the street team.
- **zips.csv:** the top tiles (lift >= 1.3, at most 5; `maxTiles` and `minLift` override) and their 5-digit ZCTAs. A tile's weight is the sheet's budget split when it covers every selected tile, otherwise proportional to lift; it is split evenly across the tile's ZCTAs, a ZCTA in two tiles sums its shares and keeps the higher lift, and weights are rounded to 4 decimals summing to exactly 1. ZIPs stay text, so leading zeros survive.
- **pins.csv:** the same tiles' centres to 5 decimals, `radius_mi` = half the cell's diagonal rounded up to 0.1, never below 1 (`minRadiusMi` can raise it).
- **offer-codes.csv** columns: `offer_code, description, channel, assigned_to, tile, event_id, event_date, venue, valid_from, valid_until, discount, max_uses, status`. One code per suggested partner, per declared entry and per top tile, built from the partner's or tile's own name plus a running number (`LOWHUM01`), with an optional `codePrefix`. Codes and descriptions never carry act names. `discount` and `max_uses` are blank: pricing is the operator's call. Every row's `status` is "create in your ticketing platform": nothing is created anywhere by this package.

**Loading the ad files.** Neither file carries an audience label: a ZIP or a pin and a weight, nothing about who lives there. The operator sets targeting in their own ad account. At the time of writing:
- Meta Ads Manager: in the ad set's Locations, "Add locations in bulk" takes a pasted list of ZIP codes (country United States). Pins are dropped one per row, radius in miles.
- Google Ads: in the campaign's Locations, "Advanced search" has "Bulk locations" for the ZIP list and "Radius" for each pin; Google Ads Editor can import both.
- Neither platform reads `lift_score` or `suggested_weight`; use the weight to split budget across ad sets or as a manual bid adjustment. Bulk-entry formats change; check the platform's current help page and rename columns if it asks for different headers.
- Opening `zips.csv` by double-clicking it in a spreadsheet can drop leading zeros (02134 -> 2134); import the column as text instead.

**Ticketing platforms.** The offer-code columns follow the fields TM One and Etix promo codes have (code, description, start and end dates, discount, usage limit); the names differ per platform, so map them when creating the codes.

### sheet.json

`{ format: "walkup.street-sheet", formatVersion: 1, planId, mode, hypothetical, notice?, sanitized, sheet }`. `sheet` is the full StreetSheet with its ledger. `notice` is set on fixture sheets. Before writing, `sanitizeSheet` re-applies two rules the pipeline already enforces, because this file is persisted and shared: denied tags (`isDeniedTag` from the engine) are removed from every tag list and tag-id list, person entities lose all tags, and ledger params or copy-as-curl strings holding a literal credential (anything not a `$ENV_VAR` reference) are replaced with `[redacted]`. `sanitized` reports the counts (zero when the pipeline did its job). `sanitize: false` skips the pass.

## Public API

Everything is exported from `src/index.ts`.

- PDF: `toPdf`, `renderStreetSheetPdf`, `streetSheetDocument`, `streetSheetElement`, `countPdfPages`, `PAGE_SIZES`.
- Model: `buildSheetModel` (options: `audience`, per-panel caps, `ledgerUrl`, `asOf`, `showName`), `sheetModelText`; also `@walkup/exports/sheet-model`.
- Map geometry: `layoutTileMap` (with `unitsPerKm` for the grid and scale bar), `placeLabels`, `liftBand`, `liftAlpha`, `liftFill`, `niceKm`, `LIFT_INK`, `MAP_COLORS`, `LABEL_RADIUS`, `MIN_VISIBLE_CELL`.
- Calendar: `toIcs`, `planStreetTeamVisits`, `streetTeamDates`, `escapeIcsText`, `foldLine`, `icsLocal`, `icsUtc`, `vtimezoneLines`, `SUPPORTED_TIME_ZONES`.
- CSV: `toCsv`, `csvCell`, `looksLikeFormula`, `partnersCsv`, `partnersCsvRows`, `declaredInCallOrder`, `zipsCsv`, `zipRows`, `pinsCsv`, `pinRows`, `offerCodesCsv`, `offerCodeRows`, `tileWeights`, `apportion`, `geohashHalfDiagonalMi`, and the column lists.
- JSON: `toSheetJson`, `sheetJsonDocument`, `sanitizeSheet`.
- Bundle: `toExportFiles`, `EXPORT_FILE_NAMES`, `EXPORT_CONTENT_TYPES`.
- Helpers: `pdfText`, `isPdfSafe`, `topTiles`, `tMinusDays`, `tMinusLabel`, `formatShowDate`, `ledgerRanges`, `actsLine`, `sheetAgeLabel`, `isAllAgesForCopy`, `explainTags`, `partnerWhy`, `partnerWhyLong`, `TOP_LIFT`, `SUGGESTED_NOT_AFFILIATED`, `ATTRIBUTION`, `FIXTURE_NOTICE`, `SAMPLE_LABEL`, `SAMPLE_PREFIX`.

Server-side only: `toPdf` needs Node (`Buffer`). In a Next.js route, import it from server code; if the bundler trips on react-pdf, add `@react-pdf/renderer` to `serverExternalPackages`.

## Test

```
npx vitest run packages/exports
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "packages/exports"
```

Test sheets are built in `test/helpers.ts` (invented acts, venue, businesses and ids). The PDF tests render real PDFs, inflate the content streams and read the text back (`test/pdf-text.ts`), walk the React tree, check page size and the one-page fit, and render every sheet in `fixtures/synthetic/` when present. The ICS tests unfold and check CRLF, the 75-octet limit, required properties, UIDs and zones; the CSV tests read the output back with a strict RFC 4180 reader (`test/csv-parse.ts`).

## Known limits

- No QR code on the PDF (no QR library is installed); the ledger line carries a link instead when `ledgerUrl` is absolute.
- No basemap or city outline under the tiles: geohash cells, a kilometre grid, a scale bar and the venue only.
- The paper table has no Activation column (it is in `partners.csv` and on the web sheet's "Why this place").
- The numbered areas (`topTiles`) skip a tile within 3 km of, or sharing a ZIP with, a higher one, the same rule as the orchestrator's spread tiles, so map numbers, partner areas and the budget split agree. Map labels closer than about two marker widths merge into one ("3, 4").
- Standard fonts only: names outside Windows-1252 (for example Vietnamese or CJK) print transliterated or with `?`. Embedding a Unicode font would fix this at the cost of shipping one.
- Partner hours on the PDF and in the calendar are the `hoursOnDay` string from the sheet, computed for the first street-team day; visits on other days show the same text.
- ZCTAs approximate ZIP codes; a few ZIPs (PO boxes, single buildings) have no ZCTA.
- ZIPs the operator already reaches (`operator.alreadyReachedZips`) are not down-weighted.
- The fit loop can render up to six times on an overfull sheet (about 1-2 s); a normal sheet renders once.
- `countPdfPages` counts page objects in this renderer's uncompressed object table; it is not a general PDF parser.
- `sanitizeSheet` scans arrays for tags and tag ids; a denied tag inside a free-text string is not caught there (the narration guard owns free text).
