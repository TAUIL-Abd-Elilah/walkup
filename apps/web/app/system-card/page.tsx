import type { Metadata } from "next";
import Link from "next/link";
import { DENIED_TAG_KEYWORDS, DENIED_TAG_PREFIXES } from "@walkup/contracts";
import { FANBAR_HREF, FANBAR_RESULT, PARTNER_RANK_LINE } from "@/lib/labels";

export const metadata: Metadata = {
  title: "System card",
  description: "What Walkup calls, what it stores, what it will not do, and where it is known to fail.",
};

/** Request types by name (never Q numbers, which on a sheet number one run's calls in order), with calls per fresh run. */
const ENDPOINTS: { id: string; shape: string; decides: string; calls: string }[] = [
  { id: "Act lookup", shape: "GET /entities?external.spotify.ids=… or typed /search", decides: "Which acts match; Walkup asks you when a name is ambiguous", calls: "1 to 4" },
  {
    id: "Signal check",
    shape: "filter.type=urn:entity:place with every seed as the signal, at the venue, 1,500 m, take=1",
    decides: "Which acts Qloo has taste data for; an entry it has none for is swapped, asked about or left out, and the sheet says which",
    calls: "1 per 25 ids checked, plus 1 per Spotify-matched act Qloo drops. A 200 is reused for a week; a 400 isn't cached",
  },
  { id: "Venue lookup", shape: "GET /search types=urn:entity:place near the venue", decides: "The venue, else the Ticketmaster map point", calls: "1" },
  { id: "The room's usual acts", shape: "GET /entities for the venue's Ticketmaster roster", decides: "The room's usual crowd (its top 12 headliners)", calls: "1 to 3 per venue a week" },
  { id: "Heatmap, bill", shape: "GET /v2/insights filter.type=urn:heatmap", decides: "Where this bill's crowd is, per area", calls: "1" },
  { id: "Heatmap, usual crowd", shape: "The same heatmap with the room's usual acts", decides: "Where the usual crowd is, per area", calls: "0 or 1" },
  { id: "Heatmap, popularity check", shape: "The same heatmap with a generic tag", decides: "A check only: does lift just follow general popularity", calls: "0 or 1" },
  { id: "Map check", shape: "The bill and usual-crowd heatmaps again, each for one half of the acts", decides: "Whether the map holds up when the bill is split in two", calls: "up to 4" },
  { id: "Age mix", shape: "GET /v2/insights filter.type=urn:demographics", decides: "Age mix, this bill and the usual crowd", calls: "1" },
  { id: "Crowd compare", shape: "GET /v2/analysis/compare (bill and usual crowd)", decides: "How this crowd differs; copy-line candidates", calls: "1, or 3 if it falls back to two tag lists" },
  { id: "Partner search", shape: "filter.type=urn:entity:place per numbered area, stacked filters, explainability", decides: "The partners", calls: "3, one per partner area" },
  { id: "Partner search, usual crowd", shape: "Each partner search again with the usual crowd's signal (same area, radius and filters)", decides: "The usual-crowd rank on partner rows", calls: "3, one per partner area" },
  { id: "Spots near the venue", shape: "Places within 1.5 km of the venue, and the same for the usual crowd", decides: "Spots for before and after the show, and how the usual crowd ranks them", calls: "1, plus 1 a week" },
  { id: "Your partners", shape: "filter.results.entities with the operator's list", decides: "Call order for your own partners", calls: "1" },
  { id: "Podcasts", shape: "filter.type=urn:entity:podcast with signal.location", decides: "Podcasts for a host read", calls: "1" },
  { id: "Sponsor", shape: "filter.type=urn:entity:brand with signal.location", decides: "One sponsor", calls: "1" },
  { id: "Copy-line tags", shape: "filter.type=urn:tag, namespace-scoped, diversify.by=subtype", decides: "The tags copy lines may use", calls: "1" },
  { id: "Tag list", shape: "GET /v2/tags", decides: "Pins every tag id; no free-text tags at runtime", calls: "none at runtime; build time only" },
];

/**
 * Each request shape a run sends, checked against hackathon.api.qloo.com on Oct 15 2026. Derived facts only
 * (statuses, counts, field names): no response data.
 */
const VERIFIED: { shape: string; usedFor: string; result: string; status: "verified" | "verified, changed" | "changed" | "added" | "removed" }[] = [
  { shape: "Typed /search for artists and people, exact name", usedFor: "Acts and the room's usual acts", result: "Most musicians come back twice under one name, an artist and a person entry; the run counts them as one act.", status: "verified, changed" },
  { shape: "Place insights with every seed as the signal, at the venue, take=1", usedFor: "Signal check", result: "Names each seed Qloo has no taste data for in a not_found warning.", status: "added" },
  { shape: "/search for places near a point (lat,lon and a radius in miles)", usedFor: "Venue, pick list for your partners", result: "One room found 5 m from its point within 1 mile; another is not in the catalog.", status: "verified" },
  { shape: "/entities by Spotify id", usedFor: "Acts and the room's roster", result: "Ids come back under properties.external. The roster-wide check waits for the Ticketmaster key.", status: "verified, changed" },
  { shape: "Heatmap with entity signals, a point and a radius", usedFor: "Bill and usual-crowd maps, map check", result: "Radius honoured. A seed Qloo has no taste data for is dropped without a warning, and a map of only such seeds still comes back with areas, hence the signal check.", status: "verified" },
  { shape: "Heatmap with a place tag (restaurant) as the signal", usedFor: "Popularity check", result: "Answers as expected.", status: "verified" },
  { shape: "Heatmap with a genre tag as the signal", usedFor: "Genre baseline when the roster is short", result: "The stand-up comedy tag returned 0 areas near a comedy club. Comedy gets no genre baseline; no music genre tag is pinned yet.", status: "changed" },
  { shape: "urn:demographics", usedFor: "Age mix", result: "One block per signal, 6 age buckets, 2 gender keys.", status: "verified" },
  { shape: "/v2/analysis/compare, bill against usual crowd", usedFor: "How this crowd differs", result: "take has no effect, so each list is cut on our side.", status: "verified, changed" },
  { shape: "Place insights per area: radius, pinned category tags (union), filter.hours, price cap, explainability, take=50", usedFor: "Partners, their usual-crowd rank, spots near the venue", result: "filter.hours honoured: 5 places closed that day without it, 0 with it. Exclusion filters not checked yet.", status: "verified" },
  { shape: "Pinned category tags", usedFor: "Partner and spot categories", result: "11 of 14 pinned (5 to 10 places within 25 km, each carrying the tag); record store, Irish pub and place of worship dropped.", status: "verified, changed" },
  { shape: "filter.results.entities with the bill as the signal", usedFor: "Call order for your partners", result: "A 10-entity shortlist came back fully scored.", status: "verified" },
  { shape: "Podcasts with signal.location", usedFor: "Podcasts", result: "15 rows with a usable seed; the day-one errors came from a seed Qloo had no taste data for. Location effect not shown, so labelled national.", status: "verified" },
  { shape: "Brands with signal.location", usedFor: "Sponsor", result: "15 rows with a usable seed. No alcohol brand tag found to exclude, so a name and tag filter keeps those brands off shows that aren't 21+.", status: "verified, changed" },
  { shape: "urn:tag with tag types and diversify.by=subtype", usedFor: "Copy-line tags", result: "At most 5 tags per namespace.", status: "verified" },
  { shape: "GET /v2/tags", usedFor: "Pinning tag ids at build time", result: "Answers as expected.", status: "verified" },
  { shape: "POST /v2/insights with weighted signals", usedFor: "Weighting an act against its stand-ins", result: "HTTP 400.", status: "removed" },
  { shape: "filter.results.entities.query (names instead of ids)", usedFor: "Scoring a typed list without a pick list", result: "HTTP 400. Never sent.", status: "removed" },
  { shape: "signal.demographics.age on place calls", usedFor: "Age-tuned partner ranking", result: "Its check ran on a seed Qloo had no taste data for, so it showed nothing. Never sent.", status: "removed" },
  { shape: "GET /v2/audiences", usedFor: "Declared group segments", result: "Nothing came back for either test query.", status: "removed" },
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="section scroll-mt-24">
      <h2 id={`${id}-title`}>
        {title}
      </h2>
      <div className="mt-3 space-y-3 [&_strong]:font-semibold">{children}</div>
    </section>
  );
}

const TOC = [
  ["purpose", "Purpose and operator"],
  ["models", "Models and versions"],
  ["endpoints", "Qloo endpoints"],
  ["pick", "How the top pick is chosen"],
  ["data", "Data sources and licences"],
  ["storage", "What we store and what we don't"],
  ["policy", "Policy enforced in code"],
  ["evals", "Evals"],
  ["failures", "Known failure modes"],
  ["gates", "Human gates"],
  ["costs", "Cost caps"],
  ["contact", "Contact"],
] as const;

export default function SystemCardPage() {
  return (
    <div className="wrap-wide pt-10 pb-16">
      <div className="max-w-[760px]">
      <h1>How Walkup works, and where it stops</h1>
      <p className="mt-3">
        Walkup plans the street team for one booked show: the areas where this bill&apos;s crowd stands out from the room&apos;s usual crowd, and the local
        places that crowd already likes. This page says what it calls, what it stores, what it won&apos;t do and where it is known to fail.
      </p>
      <p className="mt-2">
        The hosted sheets were recorded from live Qloo and Ticketmaster runs on Oct 21 2026, and most of their ready-made changes on Oct 28 2026. Live
        runs are paused for judging; each recorded sheet comes from a live run and was re-checked offline afterwards, as the next paragraph says.
      </p>
      <p id="recheck" className="mt-2 scroll-mt-24">
        On Oct 28 and 29 2026 the recorded sheets were re-checked offline with the newer checks, with no API call. Four Claude sentences that fail a check
        now read as template wording, with the reason in the sheet&apos;s checks. Partner lines say a place is &ldquo;near&rdquo; its area unless the
        address is on that street, and each area carries its own state. Each revision&apos;s change list was rebuilt over the five numbered areas. One
        spot listed as a restaurant, SWIG, is a bar by its Qloo tags (a bar and grill, with dive-bar tags), so it left the two &ldquo;All ages, no
        bars&rdquo; revisions at The Salt Shed, which now list 7 spots. FLO&apos;s &ldquo;Within 10 km&rdquo; revision, which changed nothing, was
        removed. No Qloo or Ticketmaster answer, ranking, partner list or ledger changed.
      </p>
      <nav aria-label="Sections" className="mt-6">
        <h2 className="text-base">On this page</h2>
        <ol className="mt-2 list-decimal gap-x-8 pl-5 text-base sm:columns-2">
          {TOC.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`} className="link">
                {label}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="mt-6">
        <Section id="purpose" title="Purpose and operator">
          <p>
            Walkup helps the people selling one booked show (a promoter, a venue marketer, a street-team lead) decide where to put posters, ticket drops and
            calls for the seats that are left. It works one show at a time, after booking.
          </p>
          <p>
            It is a planning tool. It does not sell tickets, set prices or rank shows, and it shows no sales data for any show. Seats left and capacity are
            what-ifs the operator enters, marked as what-ifs. The sample presets use invented bills; the live sheets use two real Ticketmaster bills at
            The Anthem, Washington DC, and two at The Salt Shed, Chicago. No preset carries a seats-left count.
          </p>
        </Section>

        <Section id="models" title="Models and versions">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <strong>Claude</strong> Haiku 5.5 (<span className="font-semibold">anthropic/claude-haiku-5.5</span>) through OpenRouter when that key is set (no server-side refusal fallback on that route),
              otherwise Opus 5.5 (<span className="font-semibold">claude-opus-5-5</span>) through the Anthropic Messages API.
            </li>
            <li>
              Narration: effort <span className="font-semibold">low</span>, structured output against a JSON schema built per run. It may cite only entity ids and
              numbers returned in that run; a deterministic guard drops anything else and the sheet shows the count.
            </li>
            <li>
              Revisions: effort <span className="font-semibold">medium</span>. The model reads the operator&apos;s change note and a short summary of the sheet
              (no partner names or contacts) and chooses among six strict tools: all ages, leave out place types, skip areas on the sheet, street-team days,
              search radius (5 to 60 km), or ask one question. The tools only set inputs; the plan then runs again through Qloo and the same code, and
              requests whose inputs didn&apos;t change come from the cache.
            </li>
            <li>
              Without a model key, or when the model call fails, fixed rules read common notes (&ldquo;all ages&rdquo;, &ldquo;no bars&rdquo;,
              &ldquo;skip an area&rdquo;, &ldquo;only Saturday&rdquo;, &ldquo;within 10 km&rdquo;) into the same tools, and the revised sheet says the rules
              read it. A note they can&apos;t read gets a question and no change.
            </li>
            <li>Above the daily spend cap, narration falls back to a deterministic template, labelled on the sheet.</li>
            <li>
              The model is called only to parse free-text show input, to narrate and to read a change note. Resolution, lift, partner
              ranking and scoring are Qloo responses plus deterministic code.
            </li>
          </ul>
        </Section>

        <Section id="endpoints" title="Qloo endpoints">
          <p>
            Base URL <span className="font-semibold break-all">https://hackathon.api.qloo.com</span>, key in a server-side header only. About 16 to 32 calls per
            fresh run on the sample data: the sample bill A at The Truth, Nashville, makes 32 from cold, including the signal check, the 4 map-check heatmaps, 3 usual-crowd
            partner searches and 3 popularity searches; the Super Funny, Tacoma sample, with no lift map, makes 16. The live runs on Oct 21 2026 made
            about 30 calls each. From a cold cache, the first runs made 30 and 22 new calls at The Anthem and 29 and 21 at The Salt Shed; the second
            bill at each room reused the room&apos;s cached answers. The sheets served here are same-day re-runs with the final rules, at 29 or 30 requests
            each. Of those, 0 were new at The Anthem and 12 and 11 at The Salt Shed; the rest came from the cache. Each sheet shows its own count. The
            hackathon key&apos;s monthly limit read 50,000 calls. Every call is a GET with plain entity ids.
          </p>
          <p className="hint">
            Every request shape below was checked against the live Qloo host on Oct 15 2026, the day the key arrived; what it did is listed after this
            list. The four hero sheets were run live and recorded on Oct 21 2026 (see{" "}
            <a href="#evals" className="link">
              Evals
            </a>
            ).
          </p>
          <ul className="border-t border-rule">
            {ENDPOINTS.map((e) => (
              <li key={e.id} className="border-b border-rule py-2">
                <span className="font-semibold">{e.id}</span>
                <span className="text-muted"> · {e.calls}</span>
                <span className="block">{e.decides}</span>
                <span className="block text-sm break-words text-muted">{e.shape}</span>
              </li>
            ))}
          </ul>
          <p className="hint">Each line gives the calls in one fresh run. On a sheet, receipt ids (Q1, Q2 …) number that run&apos;s calls in the order they were made.</p>
          <h3 id="verified" className="mt-6 text-base">Verified on hackathon.api.qloo.com, Oct 15 2026</h3>
          <p>
            Each request shape a run sends, checked against the live host. Only statuses, counts and field names are listed, no response data.
            &ldquo;Changed&rdquo; means the check changed what Walkup sends or how it reads the answer; &ldquo;removed&rdquo; means the code path is gone.
          </p>
          <ul className="border-t border-rule">
            {VERIFIED.map((v) => (
              <li key={v.shape} className="border-b border-rule py-2">
                <span className="font-semibold">{v.usedFor}</span>
                <span className="text-muted"> · {v.status}</span>
                <span className="block">{v.result}</span>
                <span className="block text-sm break-words text-muted">{v.shape}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="pick" title="How the top pick is chosen">
          <p>
            &ldquo;Start with this place&rdquo; or &ldquo;Start in this area&rdquo; at the top of a sheet comes from a fixed rule, never from the model. The partner
            rule goes first. Walk the numbered areas on the map in order (the 1 to 5 the area list and the partner table share). In each area, take the
            partners in this crowd&apos;s rank order, skip national chains, and pick the first one that the room&apos;s usual crowd ranks at least 5 places
            lower in the same search, or not at all. If no place in area 1 qualifies, area 2 is tried, and so on. If no partner qualifies, the area rule:
            the highest-lift numbered area that ranks at least 5 places lower when you look at this crowd on its own. If neither finds one, the sheet says
            &ldquo;No top pick on this sheet&rdquo; and why. A picked partner that the partner table marks less certain keeps the table&apos;s dagger
            (&dagger;) and its note. Both need the room&apos;s own crowd as the baseline, and the area rule needs a map that passed its checks.
          </p>
        </Section>

        <Section id="data" title="Data sources and licences">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <strong>Qloo</strong>: every taste decision, and the partner and spot details on the sheet (address, phone, website, hours, closed or open).
              Response bodies are never committed (git hook and CI check); private cache only.
            </li>
            <li>
              <strong>Claude</strong>, through OpenRouter or the Anthropic API: narration, free-text parsing and change notes. No personal data is sent.
            </li>
            <li>
              <strong>Google</strong>: nothing. The product makes no Google request.
            </li>
            <li>
              <strong>Ticketmaster Discovery</strong>: bill, venue, date, age policy and the venue roster. Attribution and deep links, within rate limits.
            </li>
            <li>
              <strong>OpenStreetMap via OpenFreeMap</strong>: base map tiles, ODbL attribution on every map.
            </li>
            <li>
              <strong>U.S. Census Bureau ACS 5-year</strong>: adults per ZCTA for the budget heuristic and tile floors. Public domain.
            </li>
            <li>
              <strong>Supporters&apos;-club home-bar lists</strong> (eval only): facts only, attributed, linked and date-stamped, robots.txt respected, the full table
              not redistributed.
            </li>
          </ul>
        </Section>

        <Section id="storage" title="What we store and what we don't">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>No fan data and no personal data. Inputs are the bill, the venue, the date and counts or lists the operator types.</li>
            <li>No cookies beyond one functional cookie.</li>
            <li>The optional &quot;send a copy to&quot; address is used once for that send and never stored. The ledger records that a copy was requested, not the address.</li>
            <li>Already-reached ZIPs, when supplied, are aggregate counts from the operator&apos;s own report. No names.</li>
            <li>Tags about individual people are removed before anything is stored.</li>
            <li>
              Ad exports (ZIP and pin lists) carry no audience labels. The operator sets targeting in their own ad account. A race-share audit (one aggregate
              number, never per show or tile) has not been run, so none is reported.
            </li>
          </ul>
        </Section>

        <Section id="policy" title="Policy enforced in code">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>Aggregate affinities only. Walkup never infers identity, ethnicity, religion, health, finance, politics or sexuality.</li>
            <li>
              Lift is always said against a named baseline (&quot;about 1.8 times the room&apos;s usual crowd&quot;), never as where a group lives.
            </li>
            <li>Community channels (alumni chapters, fraternities and sororities, congregations) appear only when the operator types them.</li>
            <li>Alcohol and 21+ rules come from the Ticketmaster age policy, never from Qloo. Unknown counts as all-ages for fan-facing lists.</li>
            <li>Partners are suggested, not affiliated. No email goes to anyone the operator did not type. Contact details are never scraped.</li>
            <li>Copy uses only allowlisted tag words: no jokes, no likeness, nothing in an artist&apos;s voice.</li>
          </ul>
          <p>Tag namespaces that never reach copy or storage:</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[0.875rem]">
            {DENIED_TAG_PREFIXES.map((p) => (
              <li key={p} className="break-all">
                {p}*
              </li>
            ))}
          </ul>
          <p>
            Plus any tag whose id or name contains: <span className="text-[0.875rem]">{DENIED_TAG_KEYWORDS.join(", ")}</span>.
          </p>
        </Section>

        <Section id="evals" title="Evals">
          <p>
            <strong>Live, recorded Oct 21 2026.</strong> Two real Ticketmaster bills at The Anthem, Washington DC (an independent room, I.M.P.). A fixed
            rule from the spec picked them: the first Americana, country or folk bill from Dec 20 2026 to Feb 28 2027, and the bill in that window whose
            genre is most distant from it. Rhiannon Giddens on Feb 28 was the only Americana, country or folk bill in that window on The Anthem&apos;s
            Ticketmaster calendar; FLO&apos;s R&amp;B show was the most distant. Both were run live, about 30 Qloo calls per fresh run. The two sheets share none
            of their top 5 areas and none of their suggested partners. 25 of their 33 partners are not in the popularity list for their area (the same Qloo
            place search without the bill as the signal); that compares two lists, not ticket sales. The change note &ldquo;All ages, no bars&rdquo; was
            read by Claude as two tool calls on FLO&apos;s sheet, removed 5 partners and made no new Qloo call. A separate check on Oct 20, that lift is not just foot traffic,
            passed for two bills at The Truth, Nashville, with that room&apos;s real roster. One room and two bills show the pipeline runs on live data, not that a sheet
            sells tickets. The same rule at a second independent room, The Salt Shed in Chicago (owned and run by 16&quot; On Center, a member of the
            Chicago Independent Venue League), picked Greensky Bluegrass and The Roots (a two-night pass listed first was skipped as a ticket package, not a
            show). Those two sheets share none of their top 5 areas and none of their partners; 29 of their 41 partners are not in the popularity list for
            their area. Neither signal is thin.{" "}
            <Link href="/eval#live" className="link">
              The numbers
            </Link>
            .
          </p>
          <p>
            The product eval (20 cases) passes on the sample data. It checks that the pipeline behaves as described, not that Qloo&apos;s picks are better.
          </p>
          <p id="fanbar">
            <strong>Against popularity, Oct 21 2026.</strong> {FANBAR_RESULT} The plan was sealed before any data. The difference in mean reciprocal
            rank was -0.006 (95% CI -0.018 to 0.006), one-sided p = 0.89. It tested a football club as the signal, not a show&apos;s acts, and it did not
            test lift. So we don&apos;t claim Walkup&apos;s picks beat popularity. Each sheet says this once, in its limits, and each partner table carries
            one line: &ldquo;{PARTNER_RANK_LINE}&rdquo;{" "}
            <Link href={FANBAR_HREF} className="link">
              The test
            </Link>
            .
          </p>
        </Section>

        <Section id="failures" title="Known failure modes">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>Thin signal for comedians and smaller acts: fewer map cells, film or TV titles standing in for an act Qloo has little on, and sections marked partial.</li>
            <li>
              A comedy room whose roster matches fewer than 5 comedians has no lift map: Qloo&apos;s comedy-wide map came back empty, so nothing can stand in for
              the room&apos;s crowd. The map section says so and partners are picked near the venue.
            </li>
            <li>
              A map that ranks areas almost like the bill&apos;s own crowd shows where the crowd is, not where it stands out. The map section says so and
              partners are picked near the venue.
            </li>
            <li>
              Qloo can list an act it has no taste data for. The signal check swaps in the next usable entry from the same search and says so, asks when
              several fit, or leaves the act out.
            </li>
            <li>New venues not yet in the catalog: the run uses the Ticketmaster point instead.</li>
            <li>Sparse small metros: the radius widens and the sheet says so.</li>
            <li>
              A sparse map in a big metro: on FLO&apos;s live sheet only 159 areas came back, so the search widened to 60 km and the map is marked partial.
              Some suburban areas then carry national chains when no local place fits; they are listed after local places and labelled.
            </li>
            <li>
              API notes we handled: explainability shares can sum to less than 1, so the sheet uses them only to name the act behind a place; and a
              demographics call can leave out an act Qloo has no age data for, so the age card is marked partial and names it.
            </li>
            <li>Empty or generic compare results: two tag lists compared by rank stand in, and the section says so.</li>
            <li>signal.location has not been shown to move podcast or brand rankings: those picks are labelled national.</li>
            <li>One-word act names: always stop for a pick, never resolved silently.</li>
          </ul>
        </Section>

        <Section id="gates" title="Human gates">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>Ambiguous acts wait for the operator&apos;s pick.</li>
            <li>A revision starts only from the operator&apos;s own note and makes a new plan; the original stays. All ages only adds restrictions: Ticketmaster&apos;s 21+ still holds.</li>
            <li>Nothing is sent without an explicit Confirm. The default recipient is a test inbox.</li>
            <li>Promo codes are exported for the operator to create in their own ticketing platform; Walkup never mints them.</li>
          </ul>
        </Section>

        <Section id="costs" title="Cost caps">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>Qloo: fresh runs stop when the monthly quota falls to 1,500; presets are served from cache. Fresh runs are capped at 3 per connection and 15 per day in total.</li>
            <li>Claude (OpenRouter or Anthropic): a daily spend cap; above it, narration uses the labelled template and change notes are read by the fixed rules.</li>
            <li>
              Revisions: on a live server a revision that runs again counts as a fresh run (same caps, refunded when it makes no new Qloo call), and at
              most 12 per connection per hour; 30 per hour in sample mode; 120 per hour on the recorded site, where a change only opens a stored version (no
              API call).
            </li>
            <li>Email: the provider&apos;s free tier, test inbox by default.</li>
          </ul>
        </Section>

        <Section id="contact" title="Contact">
          <p>
            Open an issue at{" "}
            <a href="https://github.com/TAUIL-Abd-Elilah/walkup/issues" className="link">
              github.com/TAUIL-Abd-Elilah/walkup
            </a>
            . For a security or data concern, open an issue titled &ldquo;security&rdquo; without details and we will reply with a private channel.
          </p>
        </Section>
      </div>
      </div>
    </div>
  );
}
