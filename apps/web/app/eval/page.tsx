import type { Metadata } from "next";
import Link from "next/link";
import { headlinerName } from "@/lib/format";
import { getPlan } from "@/lib/plans";
import {
  BASELINE,
  baselineRows,
  exploratoryLine,
  missRows,
  modelName,
  preregisteredLine,
  RESULTS_HREF,
  WHY_LIFT,
  whyLiftRows,
  whyLiftSentences,
} from "@/lib/eval-data/llm-baseline";
// The product eval writes this file (npx tsx evals/product/run.ts); nothing in the sample-data section is typed in by hand.
// The live section is typed in from the runs recorded on the hosted site on Oct 21 2026 (no API call at render).
import scoreFile from "../../../../evals/product/out/score.json";

export const metadata: Metadata = {
  title: "Evaluation",
  description: "What has been checked so far, on live runs and on sample data, and what has not.",
};

interface Clause {
  id: string;
  text: string;
  status: string;
  cases: string[];
}

interface Case {
  id: string;
  title: string;
  status: string;
}

interface Score {
  source: string;
  generatedAt: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  clauses: Clause[];
  cases: Case[];
}

const score = scoreFile as unknown as Score;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function dateOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

/** Plain names for the checks; the eval's own wording stays in score.md. */
const CHECK_NAME: Record<string, string> = {
  D1: "Each of the four sample sheets renders.",
  D2: "No claim that cites a source is dropped by the checks.",
  D3: "Every partner is open on the street-team day or marked call first.",
  D4: "Every footnote points to a request made in that same run.",
  S1: "A fresh run stays within its Qloo call budget, and every fallback request shows on its section.",
  S2: "Every step has a status and a fallback, and a section that isn't ok says why.",
  S3: "Policy: aggregate tastes only, blocked tags never in copy or stored data, alcohol rules only from Ticketmaster, partners suggested and not affiliated, and no words about how a show is selling.",
  S4: "Two bills in the same room get different areas and partner lists (at most 5 of the top 8 in common).",
};

/** Clause status in words, said only when it isn't a plain pass. CI clauses are said once, below the list. */
function clauseStatus(status: string): string | null {
  if (status === "verified") return null;
  if (status === "failed") return "Fails.";
  return `${status.replace(/_/g, " ")}.`;
}

/** "Hollis Creek String Band at The Truth": a sample sheet named by its bill, never by an internal code. */
function billName(planId: string): string | null {
  const s = getPlan(planId)?.sheet;
  return s ? `${headlinerName(s.bill)} at ${s.bill.venue.name}` : null;
}

const SAMPLE_CASE: Record<string, string> = { "G1, bill A": "g1-a", "G1, bill B": "g1-b", G2: "g2", G3: "g3" };

/** Case titles without internal asides such as "(hero sheet)" or "(degraded: tag diff)". */
function caseTitle(title: string): string {
  const golden = /^Golden (G1, bill A|G1, bill B|G2|G3): [^(]*(?:\(([^)]*)\))?/.exec(title);
  if (golden) {
    const name = billName(SAMPLE_CASE[golden[1]!] ?? "");
    const aside = golden[2] && /thin signal/i.test(golden[2]) ? ": thin signal, each fallback labelled" : "";
    if (name) return `Sample sheet: ${name}${aside}`;
  }
  return title
    .replace(/\s*\((?:hero sheet|honesty demo|degraded: [^)]*|partial: [^)]*)\)/gi, "")
    .replace(/^needs_input: /, "Pick needed: ")
    .replace(/^Golden /, "Sample sheet ")
    .replace(/deterministic template/, "fixed template")
    .replace(/a tag diff/, "comparing two tag lists")
    .replace(/the genre tag baseline stands in/, "fans of the genre stand in")
    .replace(/the genre tag baseline/, "fans of the genre")
    .replace(/spread top tiles/, "the numbered areas");
}

/** The two live hero bills at The Anthem, Washington DC, recorded on Oct 21 2026. */
const LIVE_BILLS = [
  { name: "Rhiannon Giddens", date: "Sun Feb 28 2027", partners: 16, topArea: "H Street NE", lift: "about 2.2x", notPopular: 10 },
  { name: "FLO", date: "Wed Feb 17 2027", partners: 17, topArea: "U Street / Shaw", lift: "about 2.8x", notPopular: 15 },
] as const;

/** The second room, The Salt Shed, Chicago, recorded on Oct 21 2026 by the same rule. */
const SECOND_ROOM_BILLS = [
  { name: "Greensky Bluegrass", date: "Wed Dec 30 2026", partners: 19, topArea: "Schaumburg, IL", lift: "about 2.6x", notPopular: 12 },
  { name: "The Roots", date: "Fri Jan 15 2027", partners: 22, topArea: "Bronzeville, IL", lift: "about 2.4x", notPopular: 17 },
] as const;

/** One area per live sheet, popularity alone against Walkup's picks (the sheets' popularTop and partner ranks). */
const WITH_WITHOUT = [
  { bill: "Rhiannon Giddens", area: "H Street NE, DC", fact: "2 of the 7 most popular places made the list" },
  { bill: "FLO", area: "Laurel, MD", fact: "none of the 8 most popular places made the list" },
  { bill: "Greensky Bluegrass", area: "Oak Park, IL", fact: "2 of the 8 most popular places made the list" },
  { bill: "The Roots", area: "South Shore, IL", fact: "1 of the 8 most popular places made the list" },
] as const;

/** The foot-traffic check, run on Oct 20 2026 with The Truth's (Nashville) real Ticketmaster roster. Plain names for the measures. */
const FOOT_TRAFFIC = [
  { measure: "Rank agreement between lift and raw heat, per bill (1 means the same order)", value: "0.20 and 0.01", gate: "below 0.8" },
  { measure: "Overlap between the two bills' top tenth of areas (1 means the same areas)", value: "0.47", gate: "below 0.5" },
] as const;

function ShowsLine({ shows, not }: { shows: string; not: string }) {
  return (
    <p className="mt-2 text-sm text-muted">
      Shows: {shows} Does not show: {not}
    </p>
  );
}

function caseStatus(status: string): string {
  if (status === "passed") return "Passes";
  if (status === "failed") return "Fails";
  return status.replace(/_/g, " ");
}

export default function EvalPage() {
  return (
    <div className="wrap-wide pt-10 pb-16">
      <div className="max-w-[760px]">
      <h1>Evaluation</h1>
      <p className="mt-3">
        What has been checked so far, and what has not. The first section was recorded from live Qloo and Ticketmaster runs on Oct 21 2026, and the
        Claude-alone check after it ran on live Qloo calls on Oct 28 2026. Live runs on the hosted site are paused for judging; each sheet recorded
        there comes from a live run and was re-checked offline on Oct 28 and 29 2026, with no API call (the{" "}
        <Link href="/system-card#recheck" className="link">
          system card
        </Link>{" "}
        says what changed). The product eval after them ran on sample data: a stand-in for Qloo and Ticketmaster with made-up places and numbers.
      </p>

      <section id="live" className="section mt-8 scroll-mt-24" aria-labelledby="live-title">
        <h2 id="live-title">Live runs (Oct 21 2026)</h2>
        <p className="mt-3">
          Two real Ticketmaster bills at The Anthem, Washington DC, an independent room (I.M.P.), run on live Qloo and Ticketmaster calls and recorded for
          the hosted site, walkup-eight.vercel.app. A fresh run makes about 30 Qloo calls. The hosted home page shows these two sheets as its second room, after The Salt Shed in Chicago.
        </p>
        <p className="mt-2">
          A fixed rule from the spec picked the two bills: in one independent room, the first Americana, country or folk bill in the window (here Dec 20
          2026 to Feb 28 2027), and the bill in that window whose genre is most distant from it. On The Anthem&apos;s Ticketmaster calendar, Rhiannon
          Giddens on Feb 28 was the only Americana, country or folk bill in that window, so the rule picked her show. FLO&apos;s R&amp;B show on Feb 17
          was the most distant genre. No bill was skipped.
        </p>

        <h3 className="mt-6">Same room, two crowds</h3>
        <p className="mt-2">
          The two sheets share none of their top 5 areas and none of their suggested partners. The table names the area where each bill&apos;s crowd
          stands out most from the room&apos;s usual crowd.
        </p>
        <table className="table mt-2">
          <thead>
            <tr>
              <th scope="col">Bill</th>
              <th scope="col">Stands out most in</th>
              <th scope="col" className="num">
                Lift
              </th>
              <th scope="col" className="num">
                Partners
              </th>
            </tr>
          </thead>
          <tbody>
            {LIVE_BILLS.map((b) => (
              <tr key={b.name}>
                <td>
                  {b.name}
                  <span className="block text-sm text-muted">{b.date}</span>
                </td>
                <td>{b.topArea}</td>
                <td className="num">{b.lift}</td>
                <td className="num">{b.partners}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint mt-1">Lift is against the room&apos;s usual crowd, the acts The Anthem usually hosts.</p>
        <ShowsLine
          shows="in one room, the bill changes where the street team goes and which places it calls."
          not="that either list sells tickets."
        />

        <h3 className="mt-6">Popularity check</h3>
        <p className="mt-2">
          For each area, the same Qloo place search without the bill as the signal, which Qloo returns in popularity order, with the same list length as
          the partners picked there. The count is the partners that are not in that popularity list for their area.
        </p>
        <table className="table mt-2">
          <thead>
            <tr>
              <th scope="col">Bill</th>
              <th scope="col" className="num">
                Not in the popularity list
              </th>
            </tr>
          </thead>
          <tbody>
            {LIVE_BILLS.map((b) => (
              <tr key={b.name}>
                <td>{b.name}</td>
                <td className="num">
                  {b.notPopular} of {b.partners}
                </td>
              </tr>
            ))}
            <tr>
              <td>Both</td>
              <td className="num">
                {LIVE_BILLS.reduce((n, b) => n + b.notPopular, 0)} of {LIVE_BILLS.reduce((n, b) => n + b.partners, 0)}
              </td>
            </tr>
          </tbody>
        </table>
        <ShowsLine
          shows="most partners are places a popularity list of the same areas would not name."
          not="ticket sales. It compares two lists, not sales, and not whether the partners are better."
        />

        <h3 className="mt-6">With Qloo and without, by name</h3>
        <p className="mt-2">
          Each live sheet shows one area&apos;s two lists side by side: the places most popular there for any crowd, and Walkup&apos;s picks there for
          this show&apos;s fans. The area is the one where the most picks are missing from the popularity list.
        </p>
        <table className="table mt-2">
          <thead>
            <tr>
              <th scope="col">Bill</th>
              <th scope="col">Area</th>
              <th scope="col">Of the area&apos;s most popular places</th>
            </tr>
          </thead>
          <tbody>
            {WITH_WITHOUT.map((r) => (
              <tr key={r.bill}>
                <td>{r.bill}</td>
                <td>{r.area}</td>
                <td>{r.fact}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 className="mt-6">A second room: The Salt Shed, Chicago</h3>
        <p className="mt-2">
          The same rule and window at an independent room in another city: the indoor Shed (3,600), owned and run by 16&quot; On Center, the Chicago group
          behind the Empty Bottle and Thalia Hall, and a member of the Chicago Independent Venue League. The first listing in the window is a two-night
          pass for Greensky Bluegrass, a ticket package rather than a show, so bill A is their Dec 30 show. The Roots on Jan 15, hip-hop, is the most
          distant genre. The two sheets share none of their top 5 areas and none of their partners (19 and 22): Greensky Bluegrass&apos;s crowd stands out
          in the suburbs (Schaumburg, Highwood, Oak Park), The Roots&apos; on the South Side (Bronzeville, South Shore) and in Midlothian. Neither signal is
          thin. 29 of the 41 partners are not in the popularity list for their area.
        </p>
        <table className="table mt-2">
          <thead>
            <tr>
              <th scope="col">Bill</th>
              <th scope="col">Stands out most in</th>
              <th scope="col" className="num">
                Lift
              </th>
              <th scope="col" className="num">
                Not in the popularity list
              </th>
            </tr>
          </thead>
          <tbody>
            {SECOND_ROOM_BILLS.map((b) => (
              <tr key={b.name}>
                <td>
                  {b.name}
                  <span className="block text-sm text-muted">{b.date}</span>
                </td>
                <td>{b.topArea}</td>
                <td className="num">{b.lift}</td>
                <td className="num">
                  {b.notPopular} of {b.partners}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <ShowsLine
          shows="the same rule runs in a second city, and a thin signal is said plainly instead of filled in."
          not="that the result holds in every room, or that either list sells tickets."
        />

        <h3 className="mt-6">A change note</h3>
        <p className="mt-2">
          &ldquo;All ages, no bars&rdquo; on FLO&apos;s sheet. Claude (Haiku 5.5 through OpenRouter) read it as two tool calls, set_all_ages and
          exclude_partner_categories, and the plan ran again with those settings. An earlier run on Oct 20, with Opus 5.5, made the same two calls.
        </p>
        <table className="table mt-2">
          <tbody>
            <tr>
              <th scope="row" className="font-normal">
                Tool calls
              </th>
              <td className="num">2</td>
            </tr>
            <tr>
              <th scope="row" className="font-normal">
                Partners removed
              </th>
              <td className="num">5</td>
            </tr>
            <tr>
              <th scope="row" className="font-normal">
                New Qloo calls
              </th>
              <td className="num">0</td>
            </tr>
            <tr>
              <th scope="row" className="font-normal">
                Answered from cache
              </th>
              <td className="num">30</td>
            </tr>
          </tbody>
        </table>
        <ShowsLine shows="a plain note became settings, and the re-run cost no Qloo calls." not="that every note is read correctly." />

        <h3 className="mt-6">A partial map</h3>
        <p className="mt-2">
          FLO&apos;s map is marked partial: only 159 areas came back, so the search widened to 60 km. Some suburban areas still carry national chains when
          no local place fits; they are listed after local places and labelled.
        </p>
        <ShowsLine shows="the sheet says when its map is thin." not="which areas a fuller map would pick." />

        <h3 className="mt-6">Is lift just foot traffic?</h3>
        <p className="mt-2">
          A separate check, run on Oct 20 2026 at another room: The Truth, Nashville, with its real Ticketmaster roster as the room&apos;s usual crowd. If
          lift ranked areas in the same order as raw heat (where people are), or two bills got the same top areas, the map would add nothing. Passes.
        </p>
        <table className="table mt-2">
          <thead>
            <tr>
              <th scope="col">Measure</th>
              <th scope="col" className="num">
                Value
              </th>
              <th scope="col" className="num">
                Passes if
              </th>
            </tr>
          </thead>
          <tbody>
            {FOOT_TRAFFIC.map((k) => (
              <tr key={k.measure}>
                <td>{k.measure}</td>
                <td className="num">{k.value}</td>
                <td className="num">{k.gate}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ShowsLine shows="lift is not just foot traffic for that pair of bills, at one room." not="that it holds in other rooms." />

        <h4 className="mt-6">The two live rooms</h4>
        <p className="mt-2">
          The same question on the four live bills, from the heatmaps recorded on Oct 21 2026, with no new Qloo call. Raw heat is where a bill&apos;s own
          crowd is strongest; lift is where it stands out from the room&apos;s usual crowd. Shared areas are counted as the sheets count them: the same
          map square.
        </p>
        <table className="table mt-2">
          <thead>
            <tr>
              <th scope="col">Room</th>
              <th scope="col" className="num">
                Top 5 shared, raw heat
              </th>
              <th scope="col" className="num">
                Top 5 shared, lift
              </th>
              <th scope="col" className="num">
                Raw heat against the usual crowd
              </th>
            </tr>
          </thead>
          <tbody>
            {whyLiftRows().map((r) => (
              <tr key={r.room}>
                <td>{r.room}</td>
                <td className="num">
                  {r.rawShared} of {r.of}
                </td>
                <td className="num">
                  {r.liftShared} of {r.of}
                </td>
                <td className="num">{r.rhos}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint mt-1">The last column is Spearman&apos;s rank correlation over the areas both maps cover, one value per bill: 1 would mean the same order.</p>
        <p className="mt-2">{WHY_LIFT.map((r) => whyLiftSentences(r).join(" ")).join(" ")}</p>
        <p className="mt-2">
          Counting areas within 3 km of each other, or sharing a ZIP, as the same place: raw heat shares{" "}
          {whyLiftRows()
            .map((r) => `${r.rawSharedPlace} of ${r.of} at ${r.room}`)
            .join(" and ")}
          ; lift shares{" "}
          {whyLiftRows()
            .map((r) => `${r.liftSharedPlace} at ${r.room}`)
            .join(" and ")}
          .
        </p>
        <ShowsLine
          shows="how far each bill's raw heat already follows the room's usual crowd, and how many top areas two bills share with and without lift."
          not={
            whyLiftRows().every((r) => r.liftShared < r.rawShared)
              ? "that lift picks better areas."
              : "that lift picks better areas. Counted by map square, raw heat kept these bills apart as well as lift did."
          }
        />

        <h3 className="mt-6">API notes we handled</h3>
        <p className="mt-2">Things the live Qloo responses do that the docs don&apos;t spell out, and what the code does with each.</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li>
            Explainability shares can sum to less than 1 (0.936 seen in the recorded responses). The sheet uses them only to name the act behind a
            place, never as a percentage.
          </li>
          <li>A demographics call can leave out an act Qloo has no age data for. The age card is marked partial and names the act.</li>
          <li>
            An exact /search hit can be an entry Qloo has no taste data for (Jason Isbell, where &ldquo;Jason Isbell and The 400 Unit&rdquo; works), and
            heatmaps drop such ids quietly. A signal check runs before planning, swaps in the next usable entry and says so. Found on Oct 15 2026.
          </li>
        </ul>
        <ShowsLine shows="response shapes the code expects and labels." not="anything about the picks." />
      </section>

      <section id="claude-alone" className="section scroll-mt-24" aria-labelledby="claude-alone-title">
        <h2 id="claude-alone-title">Claude alone, same areas</h2>
        <p className="mt-2 text-sm text-muted">
          Run Oct 28 2026 on live Qloo calls; plan written and hashed before any call, but committed only after the run.{" "}
          {modelName(BASELINE.model)} through OpenRouter, the model Walkup&apos;s narrator uses, with no tools and no web search. One run.
        </p>
        <p className="mt-3">
          For each live bill, we asked Claude for what Walkup&apos;s sheet lists: in each area with partners, the same number of places of the same
          kinds, for this show&apos;s fans, open on the street-team days, no national chains. Then we checked every name with a Qloo place search: is it
          there, inside the area, not marked closed, not closed on Thursday, and not a national chain.
        </p>
        <p className="mt-3">
          {BASELINE.sentences[0]} {BASELINE.sentences[1]}
        </p>
        <table className="table mt-2">
          <thead>
            <tr>
              <th scope="col">Bill</th>
              <th scope="col" className="num">
                Asked
              </th>
              <th scope="col" className="num">
                Claude alone
              </th>
              <th scope="col" className="num">
                Walkup
              </th>
              <th scope="col" className="num">
                On both lists
              </th>
            </tr>
          </thead>
          <tbody>
            {baselineRows().map((r) => (
              <tr key={r.bill}>
                <td>
                  {r.bill}
                  {r.venue ? <span className="block text-sm text-muted">{r.venue}</span> : null}
                </td>
                <td className="num">{r.asked}</td>
                <td className="num">{r.usable}</td>
                <td className="num">{r.walkupUsable}</td>
                <td className="num">{r.sameAsWalkup}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint mt-1">
          The Claude alone and Walkup columns count usable places: Qloo finds them in the area, not marked closed, not closed on Thursday, not a
          national chain. Walkup&apos;s{" "}
          {BASELINE.total.walkup.chains} misses are the national chains on its lists.
        </p>

        <h3 className="mt-6">Why Claude&apos;s names missed</h3>
        <p className="mt-2">
          {BASELINE.sentences[2]} {BASELINE.sentences[3]}
        </p>
        <table className="table mt-2">
          <thead>
            <tr>
              <th scope="col">First check the name failed</th>
              <th scope="col" className="num">
                Names
              </th>
            </tr>
          </thead>
          <tbody>
            {missRows(BASELINE.total.claude).map((m) => (
              <tr key={m.key}>
                <td>{m.label}</td>
                <td className="num">{m.count}</td>
              </tr>
            ))}
            <tr>
              <td>Passed every check</td>
              <td className="num">{BASELINE.total.claude.usable}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3">{BASELINE.sentences[4]}</p>
        <ul className="mt-3 list-disc space-y-1.5 pl-5">
          <li>{preregisteredLine()}</li>
          <li>{exploratoryLine()}</li>
          <li>
            The name match let through 3 doubtful matches, all in Claude&apos;s favor, and they stay counted as the plan says: &ldquo;Ben&apos;s Chili
            Bowl&rdquo; matched Qloo&apos;s &ldquo;Ben&apos;s Chili Bowl Foundation&rdquo; and &ldquo;Stony Island Grill&rdquo; matched &ldquo;The Retro
            Grill Stony Island&rdquo;, both counted usable; &ldquo;Local bakery on Oak Park Ave&rdquo; counted as on Walkup&apos;s list.
          </li>
          <li>
            Walkup&apos;s own picks pass the area, closed and hours checks by construction: Walkup chose them from Qloo place searches inside these
            areas and dropped places marked closed or closed on Thursday. The chain check is the one its list can fail.
          </li>
        </ul>
        <ShowsLine shows={BASELINE.shows} not={BASELINE.doesNotShow} />
        <p className="mt-3">
          <a href={RESULTS_HREF} className="link">
            Plan, every name and check, and deviations
          </a>
          .
        </p>
      </section>

      <section className="section" aria-labelledby="product-title">
        <h2 id="product-title">Product eval on sample data</h2>
        <p className="mt-3">
          <span className="tabular">{score.passed}</span> of <span className="tabular">{score.total}</span> cases pass
          {score.failed > 0 ? (
            <>
              ; <span className="tabular">{score.failed}</span> fail
            </>
          ) : null}
          . Score file last updated {dateOf(score.generatedAt)}; CI re-runs the cases on every push.
        </p>
        <p className="mt-2 text-muted">
          Each case runs one plan end to end and checks the sheet it produces: every card has a status and says why when it is not ok, every receipt
          is in that run&apos;s ledger, the policy rules hold, and the sheet fits one page. It checks that Walkup behaves as described. It says nothing
          about whether Qloo&apos;s picks are better than another list, and nothing about ticket sales.
        </p>

        <h3 className="mt-6">What the cases check</h3>
        <p className="hint mt-0.5">Every check below passes on sample data unless it says otherwise.</p>
        <ul className="mt-2 border-t border-rule">
          {score.clauses
            .filter((c) => c.status !== "ci")
            .map((c) => {
            const status = clauseStatus(c.status);
            return (
              <li key={c.id} className="border-b border-rule py-2">
                {CHECK_NAME[c.id] ?? c.text}
                {status ? <span className={`block text-sm ${c.status === "failed" ? "font-semibold text-ink" : "text-muted"}`}>{status}</span> : null}
              </li>
            );
          })}
          {score.clauses.some((c) => c.status === "ci") ? (
            <li className="border-b border-rule py-2">CI re-runs these cases on every push, and on the main branch commits the score file when anything in it other than its timestamp changes.</li>
          ) : null}
        </ul>

        <h3 className="mt-6">Cases</h3>
        <p className="hint mt-0.5">
          {score.failed === 0 ? "Every case passes." : `${score.failed} ${score.failed === 1 ? "case fails" : "cases fail"}; each is marked.`}
        </p>
        <ol className="mt-2 list-decimal border-t border-rule pl-6">
          {score.cases.map((c) => (
            <li key={c.id} className="border-b border-rule py-1.5 pl-1">
              {caseTitle(c.title)}
              {c.status !== "passed" ? <span className="block text-sm font-semibold">{caseStatus(c.status)}</span> : null}
            </li>
          ))}
        </ol>
        <p className="hint mt-3">
          Run it yourself with <code className="font-sans font-semibold">npx tsx evals/product/run.ts</code>. The full report, check by check, is in{" "}
          <code className="font-sans font-semibold">evals/product/out/score.md</code>.
        </p>
      </section>

      <section className="section" aria-labelledby="limits-title">
        <h2 id="limits-title">What nothing here shows</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5">
          <li>That a sheet sells tickets. No test here measures sales.</li>
          <li>Where buyers live. The map shows where this bill&apos;s fans stand out from the room&apos;s usual crowd.</li>
          <li>That a partner will take part. Partners are suggested, not affiliated.</li>
          <li>
            How live Qloo data behaves beyond the live sheets, the checks above and the Fan-Bar Test below. The sample data was written from the
            documentation, not from real responses.
          </li>
        </ul>
      </section>

      <section className="section" aria-labelledby="dropped-title">
        <h2 id="dropped-title">What we tried and dropped</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5">
          <li>Public tour grosses as an outcome: nearly every reported date is close to sold out, so they cannot score a tool for filling seats.</li>
          <li>
            Ticketmaster &quot;sold out&quot; as a live outcome: the public status field has no sold-out value and no inventory, and a public board of slow
            shows would hurt artists.
          </li>
          <li>Minting promo codes: the box office creates them. We export suggested codes.</li>
          <li>Emailing partners: places carry phone numbers and websites, not email. We never scrape addresses.</li>
          <li>Radio format from demographics: a proxy inference, so the promoter picks the format.</li>
        </ul>
        <p className="mt-6">
          See also the{" "}
          <Link href="/system-card" className="link">
            system card
          </Link>
          .
        </p>
      </section>

      <section id="fanbar" className="section scroll-mt-24" aria-labelledby="fanbar-title">
        <h2 id="fanbar-title">The Fan-Bar Test: no edge over popularity, 25% vs 27% in the top 50 (one-sided p = 0.89)</h2>
        <p className="mt-2 text-sm text-muted">Run Oct 21 2026 on live Qloo calls; plan sealed Oct 13 before any data.</p>
        <p className="mt-3">
          Football supporters&apos; clubs list their official bar in each US city. We gave Qloo the club as the taste signal (Arsenal, Liverpool, the US
          men&apos;s team) and asked for the top 50 bars and pubs within 25 km, then asked again with no signal, which Qloo returns in popularity order.
          The test, its numbers and its pass mark were written down and hashed before any call.
        </p>
        <ul className="mt-3 list-disc space-y-1.5 pl-5">
          <li>
            In 325 club-and-city pairs across 225 US cities, the club&apos;s signal put its official bar in the top 50 for 25% of pairs (95% CI 21% to 30%);
            popularity alone did for 27% (22% to 32%). Mean reciprocal rank 0.024 against 0.030: a difference of &minus;0.006 (95% CI &minus;0.018 to
            0.006), one-sided p = 0.89. The test fails.
          </li>
          <li>
            In cities where two clubs both list a bar, the club&apos;s own bar ranked above its rival&apos;s in 95 of 182 trials: 52% (95% CI 45% to 60%), no
            better than a coin flip.
          </li>
          <li>
            Not run: the arm with a language model searching Google Places (the project&apos;s Google billing is closed) and the model-only arm. Closed bars
            could not be checked. These changes were logged and pushed before the first call.
          </li>
        </ul>
        <p className="mt-3">
          What it means: a football club&apos;s taste signal did not find that club&apos;s bar better than popularity. Walkup&apos;s signal is a show&apos;s
          acts, not a club, but this test gives no evidence that its picks beat popularity, so Walkup does not claim they do. The Claude-alone check
          above asks a different question: whether a list is usable, not whether it beats popularity.{" "}
          <a href="https://github.com/TAUIL-Abd-Elilah/walkup/blob/main/evals/p1/results.md" className="link">
            Full results, coverage and deviations
          </a>
          .
        </p>
      </section>
      </div>
    </div>
  );
}
