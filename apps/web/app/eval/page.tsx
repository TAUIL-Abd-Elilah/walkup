import type { Metadata } from "next";
import Link from "next/link";
import { headlinerName } from "@/lib/format";
import { getPlan } from "@/lib/plans";
// The product eval writes this file (npx tsx evals/product/run.ts); nothing in the sample-data section is typed in by hand.
// The live section is typed in from the runs recorded on the hosted site on Oct 20 2026 (no API call at render).
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

/** The two live hero bills at The Anthem, Washington DC, recorded on Oct 20 2026. */
const LIVE_BILLS = [
  { name: "Rhiannon Giddens", date: "Sun Feb 28 2027", partners: 11, topArea: "Langston (H Street NE)", lift: "about 2.2x", notPopular: 8 },
  { name: "FLO", date: "Wed Feb 17 2027", partners: 15, topArea: "Le Droit Park", lift: "about 2.8x", notPopular: 12 },
] as const;

/** The KG2 gate, re-run on Oct 20 2026 with The Truth's (Nashville) real Ticketmaster roster. */
const KG2 = [
  { measure: "Spearman(lift, raw heat)", value: "0.20 and 0.01", gate: "below 0.8" },
  { measure: "Top-decile lift Jaccard between two bills", value: "0.47", gate: "below 0.5" },
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
        What has been checked so far, and what has not. The first section comes from live runs recorded on Oct 20 2026 and recorded again on Oct 21 with the same numbers. The
        product eval after it ran on sample data: a stand-in for Qloo and Ticketmaster with made-up places and numbers.
      </p>

      <section id="live" className="section mt-8 scroll-mt-24" aria-labelledby="live-title">
        <h2 id="live-title">Live runs (Oct 20 2026)</h2>
        <p className="mt-3">
          Two real Ticketmaster bills at The Anthem, Washington DC, an independent room (I.M.P.), run on live Qloo and Ticketmaster calls and recorded for
          the hosted site, walkup-eight.vercel.app. A fixed rule picked them: the first Americana, country or folk bill from Dec 20 2026 to Feb 28 2027, and
          the bill whose genre is most distant from it. A fresh run makes about 30 Qloo calls. The hosted home page opens on these two sheets.
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

        <h3 className="mt-6">A change note</h3>
        <p className="mt-2">
          &ldquo;All ages, no bars&rdquo; on FLO&apos;s sheet. Claude (anthropic/claude-opus-5.5 through OpenRouter on Oct 20, anthropic/claude-haiku-5.5 on Oct 21) read it as two tool calls,
          set_all_ages and exclude_partner_categories, and the plan ran again with those settings.
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
              <td className="num">8</td>
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

        <h3 className="mt-6">Is lift just foot traffic? (KG2)</h3>
        <p className="mt-2">
          Re-run on Oct 20 with the real Ticketmaster roster of The Truth, Nashville, as the room&apos;s usual crowd. Passes.
        </p>
        <table className="table mt-2">
          <thead>
            <tr>
              <th scope="col">Measure</th>
              <th scope="col" className="num">
                Value
              </th>
              <th scope="col" className="num">
                Gate
              </th>
            </tr>
          </thead>
          <tbody>
            {KG2.map((k) => (
              <tr key={k.measure}>
                <td>{k.measure}</td>
                <td className="num">{k.value}</td>
                <td className="num">{k.gate}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ShowsLine shows="lift is not just foot traffic for that pair of bills, at one room." not="that it holds in other rooms." />

        <h3 className="mt-6">What the live host does without saying so</h3>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li>Explainability shares can sum to less than 1 (0.936 seen). From replaying the recorded bodies on Oct 20.</li>
          <li>A demographics call leaves out the block of a signal Qloo has no demographics for, with no warning. Oct 20.</li>
          <li>
            An exact /search hit can be a not_found signal that Qloo drops silently (Jason Isbell against &ldquo;Jason Isbell and The 400 Unit&rdquo;).
            Oct 15.
          </li>
          <li>Heatmaps drop such ids without a warning. Oct 15.</li>
        </ul>
        <ShowsLine shows="response shapes the code has to expect." not="anything about the picks." />
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
          . Last run {dateOf(score.generatedAt)}.
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
            <li className="border-b border-rule py-2">A CI workflow is set up to re-run these cases; it hasn&apos;t run on a hosted runner yet.</li>
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

      <section className="section" aria-labelledby="p1-title">
        <h2 id="p1-title">The Fan-Bar Test: designed, not run</h2>
        <p className="mt-3">
          The question was whether a supporters&apos; club, used as a Qloo signal, ranks that club&apos;s official home bar in each US metro above a
          popularity ranking of the same places, and above the same model searching Google Places.
        </p>
        <p className="mt-2">
          The analysis plan was hashed before any data existed, and the collector and analysis code are in the repository with tests on synthetic data.
          A full run would use more than a tenth of a month&apos;s Qloo calls, so we chose not to run it. There is no result.
        </p>
      </section>

      <section className="section" aria-labelledby="limits-title">
        <h2 id="limits-title">What nothing here shows</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5">
          <li>That a sheet sells tickets. No test here measures sales.</li>
          <li>Where buyers live. The map shows where this bill&apos;s fans stand out from the room&apos;s usual crowd.</li>
          <li>That a partner will take part. Partners are suggested, not affiliated.</li>
          <li>
            How live Qloo data behaves beyond the two live sheets and the one roster check above. The sample data was written from the documentation, not
            from real responses.
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
      </div>
    </div>
  );
}
