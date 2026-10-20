# @walkup/places

Google Places API (New) Text Search client. It served the "without Qloo" control list (same model, Google Places instead of Qloo) and the grounding checks: does the place exist, is it operating, and is it open on the street-team day.

Since Oct 20 2026 it is used only by the P1 research harness (`evals/p1/arms`), not by the product.

## Public API

```ts
import { createPlacesClient, isOpenOn, isOperational, overlapWithQloo, PLACES_ATTRIBUTION } from "@walkup/places";

const places = createPlacesClient({ ledger });   // key from GOOGLE_PLACES_API_KEY
const res = await places.searchText({ textQuery: "record store", center: { lat, lon }, radiusM: 5000, includedType: "store" });
res.control;                                     // ControlPlace[] (contracts)
res.places.filter((p) => isOperational(p) && isOpenOn(p, "saturday"));
overlapWithQloo(res.control, qlooPartners.map((p) => ({ name: p.entity.name, location: p.entity.location })));
```

| Export | What it does |
| --- | --- |
| `createPlacesClient(opts)` | `searchText({textQuery, center?, radiusM?, maxResultCount?, includedType?, strictTypeFiltering?})` returns `{ places: PlaceRecord[], control: ControlPlace[], ledgerRef, httpStatus, cacheHit }`. Also `usage()` and `purgeExpired()`. |
| `PLACES_FIELD_MASK` | Fixed: `id, displayName, formattedAddress, location, rating, userRatingCount, businessStatus, regularOpeningHours, types`. Phone and website are left out because they cost more. |
| `isOpenOn(place, weekday)` | `true` if a period opens that day (or a multi-day period covers noon) and `false` if the hours rule it out. `null` when there are no regular hours. Overnight spill such as Fri 18:00 to Sat 02:00 does not make a place "open on Saturday". |
| `isOpenAt(place, weekday, "HH:MM")` | Point-in-time check that handles overnight and week-wrap periods. |
| `isOperational(place)` | `OPERATIONAL` gives `true`, `CLOSED_*` gives `false`, anything else gives `null`. |
| `tokenSetRatio(a, b)`, `ratio`, `haversineM` | Name similarity (0..1, rapidfuzz token-set semantics) and distance in metres. |
| `matchPlaces(control, qloo)`, `overlapWithQloo(...)` | One-to-one matches with similarity ≥ 0.85 and distance ≤ 150 m. Places without coordinates never match. |
| `PLACES_ATTRIBUTION` (`"Google Maps"`), `PLACES_PROVIDER` (`"Google"`) | Show the attribution next to any Places content that is not on a Google map. |

### Client behaviour

- **Request:** `POST https://places.googleapis.com/v1/places:searchText` with `X-Goog-Api-Key` and `X-Goog-FieldMask`. `radiusM` is clamped to 0..50,000 and defaults to 40,000 when a center is given. `maxResultCount` is clamped to 1..20 (default 20).
- **Daily cap:** 300 requests per Pacific-time day, the day Google quotas use, kept in an injectable `counterStore`. Past the cap the client throws `PlacesQuotaError`, sends nothing, and writes a ledger note.
- **Cache:** successful responses are cached in an injectable `cache` store (in memory by default). The TTL is at most 30 days and longer values are clamped. Cache hits do not count toward the cap and are logged with `cacheHit: true`. `purgeExpired()` sweeps old entries.
- **Ledger:** one `kind: "places"` entry per call. Params are flattened (`locationBias.circle.radius`, ...) and the key is shown as `$GOOGLE_PLACES_API_KEY`. The copy-as-curl escapes apostrophes in the JSON body.
- **Retries:** one retry on 429 or 5xx. Google error bodies (`{error:{status,message}}`) are raised as `PlacesError`.

## Tests

```
npx vitest run packages/places
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "packages/places"
```

The tests run offline against `test/fixtures/text-search.synthetic.json` (`"synthetic": true`).

## Known limits

- Text Search returns at most 20 results per call. Pagination (`pageToken`) is not implemented.
- The client sends `maxResultCount`; newer API revisions also accept `pageSize`.
- Token-set ratio scores a name whose tokens are a subset of the other's as 1.0 ("The Pub" vs "The Pub at the Mill"). The 150 m distance rule is what guards against false matches.
- Hours come from `regularOpeningHours` only. Holiday or special hours are not checked.
- Caching: Google's Places service terms name latitude/longitude (up to 30 days) and place ids (no limit) as cacheable. Check that keeping the other fields (name, rating, hours) for up to 30 days fits the current terms before going live, or pass `cacheTtlMs: 0`.
- The daily cap is held per client instance. Several processes sharing one key need a shared `counterStore`; the GCP quota is the backstop.
