import type { Metadata } from "next";
import Link from "next/link";
import { headlinerName } from "@/lib/format";
import { getPlan } from "@/lib/plans";
// The product eval writes this file (npx tsx evals/product/run.ts); nothing on this page is typed in by hand.
import scoreFile from "../../../../evals/product/out/score.json";

export const metadata: Metadata = {
  title: "Evaluation",
  description: "What has been checked so far, on sample data, and what has not.",
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
        What has been checked so far, and what has not. Everything on this page ran on sample data: a stand-in for Qloo, Ticketmaster and Google Places with
        made-up places and numbers. No result here comes from a live Qloo call.
      </p>

      <section className="section mt-8" aria-labelledby="product-title">
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
          <li>How live Qloo data behaves. The sample data was written from the documentation, not from real responses.</li>
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
