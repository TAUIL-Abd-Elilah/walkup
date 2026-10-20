# @walkup/tm

Ticketmaster Discovery API v2 client. It looks up the show being planned, pulls the venue's upcoming roster, and maps events to the shared `Bill` shape. It also reduces the roster to the house set: the room's usual headliners.

## Public API

```ts
import { createTmClient, toBill, rosterHeadliners, TM_ATTRIBUTION } from "@walkup/tm";

const tm = createTmClient({ ledger });          // key from TICKETMASTER_API_KEY
const { data: event, ledgerRef } = await tm.getEvent("vvG1...");
const bill = toBill(event!);                    // throws TmMapError without venue coords or local date
const roster = await tm.eventsByVenue(bill.venue.tmVenueId!, { startDateTime: new Date(), size: 60 });
const house = rosterHeadliners(roster.data, { excludeEventIds: [bill.tmEventId!] }); // top 12
```

| Export | What it does |
| --- | --- |
| `createTmClient(opts)` | `getEvent(id)`, `eventsByVenue(venueId, {startDateTime, endDateTime, size, page, sort})`, `searchEvents({keyword, city, stateCode, countryCode, classificationName, startDateTime, endDateTime, size, page, sort})`, `searchVenues(keyword, {stateCode, countryCode, size, page})`, `usage()`. Each returns `{ data, ledgerRef, httpStatus, page? }`. |
| `toBill(event)` / `tryToBill(event)` | Discovery event to `Bill`. Acts follow `_embedded.attractions` order. The first act is the headliner. A later act is `co` when its name sits in the title before "with / w/ / featuring / special guest / +", and `support` otherwise. The Spotify id comes from `externalLinks.spotify[0].url`. `legalAgeEnforced` comes from `ageRestrictions` and is `null` when absent. Weekday is read from `dates.start.localDate` with no timezone shift. |
| `rosterHeadliners(events, opts)` | Unique headliners, score = sum of `0.5^(days from reference / 60)` over their nights. The list is sorted by score, then count, then first date, and `weight` is normalised to sum to 1. It skips canceled events, parking/upgrade listings and excluded events/attractions. Default `top: 12`. |
| `toVenue`, `actsOf`, `inferRole`, `parseSpotifyArtistId`, `classificationLabel` | Mapper pieces. `toVenue` keeps the venue's IANA `timezone` as `Venue.timeZone` when it is well formed. |
| `toTmDateTime`, `weekdayOfLocalDate` | Discovery's `YYYY-MM-DDTHH:mm:ssZ` format; calendar weekday. |
| `TM_ATTRIBUTION`, `TM_ATTRIBUTION_URL` | Show next to any Ticketmaster data; deep-link with `Bill.tmUrl`. |

### Client behaviour

- **Pacing:** at most 5 request starts per second (sliding window).
- **Daily cap:** requests are counted per UTC day in an injectable `counterStore`. `onQuotaWarning` fires once when the count reaches `dailyWarnAt` (default 4,500). Once the count reaches `dailyLimit` (default 5,000) the client throws `TmQuotaError` and sends nothing. The check and the count run one call at a time, so concurrent calls cannot overshoot the cap within one client.
- **Retries:** 429 and 5xx are retried up to twice. A 404 from `getEvent` returns `data: null`. A 2xx whose body is not a JSON object raises `TmError` rather than reading as an empty roster.
- **Ledger:** each logical call writes one `kind: "tm"` entry: the endpoint path, the params with `apikey: "$TICKETMASTER_API_KEY"`, status, latency, bytes, result count and a copy-as-curl that reads the key from the environment. The key never appears in entries or error messages.
- **Size:** clamped to 1..200, and the clamp is noted in the ledger. Deep paging past 1,000 results throws before anything is sent.

## Tests

```
npx vitest run packages/tm
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "packages/tm"
```

The tests run offline against the hand-written bodies in `test/fixtures/*.synthetic.json` (`"synthetic": true`). Fetch, clock and sleep are injected.

## Known limits

- Discovery has no billing-role field, so `co` vs `support` is a title heuristic.
- `isComedian` comes from the attraction's classification, or the event's when the attraction has none. Downstream still runs the comedian tag check.
- The daily counter is in memory unless you pass a persistent `counterStore`. Ticketmaster's own quota window may not match UTC days.
- The roster's recency weighting is a choice, not a measured quantity. The half-life is configurable (`halfLifeDays`).
- The house set lists candidates in rank order, but resolving them to Qloo happens elsewhere. To end with 12 resolved acts, ask for more (`top: 20`) and keep the first 12 that resolve.
