# config

## `chains.json`: national chains, by name

A hand-kept list of national and large regional US chain brands that show up as Qloo places: coffee, bakeries and desserts, fast food, fast casual, pizza, casual dining, sports bars, retail, book stores, barbers and salons (195 brands, reviewed Oct 20 2026). Partner and pre/post lists put a place whose name is on it after the local places; nothing on the list is dropped, and a chain is kept when no local place can fill its slot. The rule and the matcher are in [`packages/engine`](../packages/engine/README.md#partners).

Shape (JSON Schema: [`chains.schema.json`](chains.schema.json)): `version`, `about` (what the list is), `reviewedAt` (date of the last review), and `chains[]`, each with:

| Field | Meaning |
|---|---|
| `name` | The brand as it usually appears on a store ("Starbucks", "Dunkin'") |
| `aliases` | Other names the brand's stores use ("Starbucks Coffee Company", "Dunkin' Donuts") |
| `kind` | `coffee`, `bakery_dessert`, `fast_food`, `fast_casual`, `pizza`, `casual_dining`, `sports_bar`, `retail`, `book_store` or `beauty_barber`; for review only |
| `exact` | `true` for a brand named with a common word or a town ("Target", "Gap", "Burlington"): it matches only as the whole name, never as the start of a longer one |

A name matches when its words equal a brand's words or start with them, after case, accents, apostrophes, periods and `&`/"and" are normalized ("Potbelly Sandwich Shop" is Potbelly; "Jerry's Seafood" is not Jerry's Subs & Pizza). Before adding a brand, check that no local business is likely to start its name with the brand's words; if one could, mark it `exact` or use a longer name. `node --test config/test/chains.test.mjs` checks the shape, that no name is claimed twice and that common one-word names are `exact`. The list is bundled with the code, so a change ships with the next build.

## `tags.json`: pinned Qloo tag URNs

Walkup never sends a free-text tag to Qloo at runtime. Every tag ID in a request (partner categories in `filter.tags`, exclusions in `filter.exclude.tags`, the generic heatmap baseline, the comedian check) comes from this file, where it was pinned once from `GET /v2/tags` (call Q16) and validated.

Shape (JSON Schema: [`tags.schema.json`](tags.schema.json)):

| Field | Meaning |
|---|---|
| `categories[]` | Place categories: `bar`, `pub`, `sports_bar`, `irish_pub`, `restaurant`, `cafe`, `record_store`, `book_store`, `barber_shop`, `beauty_salon`, `clothing_store`, `night_club`, `place_of_worship`, `soul_food` |
| `baselines[]` | Genre-tag baselines for Q5 when the room's roster resolves fewer than 5 acts, keyed by a lower-cased Ticketmaster genre. Validated by heatmap cells, not rows (`validation.baselineMinCells`, 200, near a hero room). Comedy never gets one: the stand-up comedy tag heatmap came back with 0 cells on Oct 15 (probe 19), and the code ignores a comedy baseline even if one is pinned. `validatedRows` holds the cell count |
| `sponsorExclusions[]` | Brand tags excluded from the sponsor card (Q13) when the show is not 21+: `alcohol`, `tobacco`, `gambling` |
| `personChecks[]` | Tags checked on person entities: `comedian` (Q1 admits a person on a comedy bill only with it) |
| `denied` | Copy of `DENIED_TAG_PREFIXES` and `DENIED_TAG_KEYWORDS` from [`packages/contracts`](../packages/contracts/src/index.ts). A test fails if the two drift apart. Code should import the constants from contracts; this copy exists so the policy is readable next to the pins |
| `validation` | The rule a tag must pass before it is pinned (see below); `baselineMinCells` and `baselineAnchor` for baselines |

Each entry:

| Field | Meaning |
|---|---|
| `key` | Stable key used in code and on cards (`Partner.category`) |
| `label` | Human label |
| `query` | The `filter.query` sent to `/v2/tags` |
| `usedBy` | Which calls (`Q#`) or evals (`P#`) read it |
| `probeGated` | Used only if validation passes (barber shops, beauty salons) |
| `candidates` | Known candidate URNs to confirm (comedian) |
| `urn` | The pinned tag ID, or `null` |
| `status` | `unpinned` (not yet looked up), `pinned` (validated, in use) or `dropped` (looked up, failed validation, not used) |
| `pinnedAt` | ISO timestamp of the pin, or `null` |
| `validatedRows` | How many rows the validation call returned, or `null` |
| `note` | Policy or usage note |

**Runtime rule.** Code uses a tag only when `status` is `pinned`. A category that is `unpinned` or `dropped` is skipped, and the card that needed it is marked `partial` with the reason. Nothing falls back to a free-text tag.

**Policy notes.** `night_club` is used only as an exclusion on shows that are not 21+ (age policy comes from Ticketmaster `ageRestrictions`, never from Qloo). `place_of_worship` exists only so an operator can pick a congregation they declared themselves from a search pick list; it is never used to discover or rank places on its own. `soul_food` is a cuisine and joins the partner category set only when the operator selects it. No pinned URN may start with a denied prefix; a test checks this.

## Pinning on key day

Pinning needs a live Qloo key, so it happens once the key exists, together with the day-one probes. Response bodies stay in the git-ignored probe output; only the URN, the timestamp and the row count are written here.

For each entry with `status: "unpinned"`:

1. **Look up candidates.**
   `GET /v2/tags?filter.query=<query>&feature.semantic_search=true` (for place categories add `filter.parents.types=urn:entity:place`; for sponsor exclusions `urn:entity:brand`; for person checks `urn:entity:person`).
2. **Keep only exact candidates.** Every keyword in `query` must appear in the candidate's `name`. If several remain, prefer the one in the category namespace for places, and record the choice.
3. **Validate.**
   - Place categories: `GET /v2/insights?filter.type=urn:entity:place&filter.tags=<urn>&filter.location=POINT(<lon> <lat>)&filter.location.radius=25000&take=10` at the anchor in `validation.anchor`. It passes with at least `validation.minRows` (5) rows.
   - Sponsor exclusions: `GET /v2/insights?filter.type=urn:entity:brand&filter.tags=<urn>&take=10` returns at least 5 rows.
   - Person checks: the tag appears in `tags[]` of at least one known comedian resolved by typed `/search`.
   - Baselines: `GET /v2/insights?filter.type=urn:heatmap&signal.interests.tags=<urn>&filter.location=POINT(<lon> <lat>)&filter.location.radius=40000` at a hero room returns at least `validation.baselineMinCells` (200) cells.
4. **Write the result.**
   - Passed: set `urn`, `status: "pinned"`, `pinnedAt` (ISO time), `validatedRows`.
   - Failed: set `status: "dropped"`, `pinnedAt`, `validatedRows` (and `urn` if a candidate was found). The category is then not used.
5. **Check.** `node --test "config/test/*.test.mjs"` verifies the shape, the denied list against contracts, and that no pinned URN is in a denied namespace.

Tag URNs are identifiers, not response data, so they can be committed. Never commit a `/v2/tags` or `/v2/insights` response body.

**Oct 15 2026.** Probe 9 and the key-day checks pinned bar, pub, sports bar, restaurant (the canonical `genre:place` tag; no `category:place` restaurant tag came back), cafe, book store, barber shop, beauty salon, clothing store, night club and soul food, and dropped record store (2 rows), Irish pub (1) and place of worship (found only as `church`, 4 rows). The `alcohol` brand lookup returned no candidate, so it is dropped and the sponsor card relies on its name and tag filter. Tobacco, gambling, the comedian check and every baseline are still unpinned.

Re-pin when the probe shows a pinned tag returning fewer rows than the floor, and record the new `pinnedAt`.
