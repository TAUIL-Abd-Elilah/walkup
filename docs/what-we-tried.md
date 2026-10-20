# What we tried and dropped

Things we looked at, tested or designed, and decided against, with the reason. Each one narrowed what Walkup claims.

## Scoring fill against public box-office grosses

**Tried:** using reported grosses as an outcome to score a fill tool.

**Found:** in 2023-25 Wikipedia tour pages with Boxscore rows (684 pages, 97 tours, ~5,800 rows), **81% of dates were at least 98% sold, only 2.3% were below 65%, and only 3 of 61 comedy-tour pages had any rows at all.**

**Decision:** public grosses are reported mostly for shows that sold well, so they cannot tell a good fill plan from a bad one. We do not use them as an outcome, and we do not claim a sales effect. The field test (P5) is designed instead and resolves only when a pilot runs.

## Ticketmaster "sold out" as a live outcome

**Tried:** reading sell-through from the Ticketmaster Discovery API to score plans on real shows.

**Found:** `dates.status.code` takes only `onsale`, `offsale`, `canceled`, `postponed` and `rescheduled`. There is no sold-out value and no inventory field.

**Decision:** no public scoreboard of real shows is possible from public data. A public board of slow-selling shows would also be bad for the artists on it, so we would not publish one anyway. Real shows appear only with public listing facts; any count is an operator what-if with a `HYPOTHETICAL COUNT` watermark, and no show is ever labelled "soft" or "tracking".

## Minting promo codes

**Tried:** generating per-partner promo codes for the field test.

**Found:** codes are created by the box office in the ticketing platform. A code that exists only in our app does nothing at checkout.

**Decision:** we export `offer-codes.csv` in a common ticketing-platform column layout, labelled "suggested codes: create these in your ticketing platform". The operator creates them; redemptions come back as an aggregate report from the operator.

## Emailing partners

**Tried:** sending the sheet directly to suggested partner businesses.

**Found:** Qloo places carry phone numbers and websites, not email addresses. Getting addresses would mean scraping.

**Decision:** we never scrape contact data. Partners get phone numbers and website deep links on the sheet. Email goes only to contacts the operator types in, after a confirm, with a physical-address footer and an opt-out line.

## Picking a radio format from demographics

**Tried:** suggesting which radio station format to buy from the bill's age and gender skew.

**Decision:** dropped. Mapping an audience's demographics to a station format is a proxy inference about who people are. The promoter picks the format. The sheet shows only the bill-versus-house age skew, for creative and dayparting.

## A discount go/no-go

**Tried:** a recommendation on whether to discount.

**Decision:** cut. Nothing we can measure supports it. The budget split that remains is proportional to tile lift and adult population, editable, and labelled "heuristic, not a forecast".

## Neighbourhood names from the heatmap endpoint

**Considered:** `output.heatmap.boundary=city|neighborhood` on heatmap requests, to get named areas from Qloo.

**Found:** published probe notes from other developers on the API host we use report HTTP 400 for both values, contrary to the documentation. Our first probe run re-checks it; the app's Qloo client refuses to send it.

**Decision:** tiles are named by our own gazetteer (Census places plus OpenStreetMap neighbourhoods and suburbs), and names come only from the run, never pre-written.

## Trends and top-cities data in the fair control

**Considered:** giving the fair-control arm Google Trends and Spotify's top cities.

**Decision:** excluded, because neither has an official API. The fair control uses the same model with Google Places Text Search and Census ACS lookups. This is stated on the System Card.

## Ticket-outlet recall (attempted, gated)

**Plan:** collect public package-show listings that name local "tickets available at" outlets, and score them like the Fan-Bar Test with the bill as the signal.

**Rule:** if fewer than 30 (show, outlet) pairs can be found, we publish "attempted; public corpus too small (n = k)" here instead of a result.

**Status:** pending.
