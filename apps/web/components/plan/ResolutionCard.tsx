"use client";
import type { Envelope, Resolution, StreetSheet } from "@walkup/contracts";
import { RESOLUTION_LABEL, ROLE_LABEL, subtypeLabel } from "../../lib/labels";
import { CandidatePicker } from "./CandidatePicker";
import { PlanCard } from "./PlanCard";
import { Refs } from "./receipts";

function matchedTo(r: Resolution, genreStandsIn: boolean): { main: string; note?: string } {
  if (r.proxy) {
    const e = r.proxy.entity;
    const year = typeof e.properties.release_year === "number" ? `, ${e.properties.release_year}` : "";
    const kind = subtypeLabel(e.subtype);
    // An extra stand-in row already names the title: say what it is.
    if (r.proxyFor) return { main: `${kind}${year}`, note: r.proxy.reason };
    return { main: `${e.name} (${kind.startsWith("TV") ? kind : kind.toLowerCase()}${year}) stands in`, note: r.proxy.reason };
  }
  if (r.entity) {
    const pop = r.entity.popularity === null ? "" : `, popularity ${r.entity.popularity.toFixed(2)}`;
    if (r.replaced) {
      // A swapped entry: name it, and say why when the swap is not clear-cut.
      const why = `Qloo has no taste data for its first entry under this name.${r.reason ? ` ${r.reason}` : ""}`;
      const kind = subtypeLabel(r.entity.subtype);
      return { main: `"${r.entity.name}" (${kind.startsWith("TV") ? kind : kind.toLowerCase()}${pop})`, note: why };
    }
    return { main: `${subtypeLabel(r.entity.subtype)}${pop}` };
  }
  if (r.status === "needs_input") return { main: "More than one match. Pick one below." };
  if (r.status !== "unresolved") return { main: r.role === "house" ? "The room's upcoming shows on Ticketmaster" : "Matched" };
  if (r.role === "venue") return { main: "Not in the catalog yet", note: "The run uses the Ticketmaster map point for distances." };
  if (r.role === "house") {
    return {
      main: "Too few of the room's headliners matched",
      note: genreStandsIn ? "The map compares this bill with fans of its genre in general instead." : "There is no usual crowd to compare this bill with, so there's no lift map.",
    };
  }
  return { main: "No exact match", note: "The run continues without it." };
}

/**
 * Who and where: one row per act, the venue and the house set, with how each
 * was matched. `planId` makes a needs_input row pickable (the pick resumes that
 * plan); without it the candidates are shown read-only.
 */
export function ResolutionCard({
  sheet,
  envelope,
  planId = null,
  onResolved,
  pickers = true,
}: {
  sheet?: StreetSheet;
  envelope?: Envelope<Resolution[]>;
  planId?: string | null;
  onResolved?: (planId: string) => void;
  /** Render the candidate pickers under the table (off when the page shows them first). */
  pickers?: boolean;
}) {
  const env = envelope ?? (sheet as StreetSheet).cards.resolution;
  const waiting = env.results.filter((r) => r.status === "needs_input");
  // Only a sheet whose lift map used a pinned genre tag may say a genre stands in.
  const genreStandsIn = sheet?.cards.liftMap.results.diagnostics.baseline === "tag";
  return (
    <PlanCard id="resolution" title="Acts and venue" envelope={env}>
      <table className="table">
        <caption className="sr-only">How each act, the venue and the room&apos;s usual crowd were matched</caption>
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Name</th>
            <th scope="col" className="hidden sm:table-cell">
              Matched to
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {env.results.map((r, i) => {
            const m = matchedTo(r, genreStandsIn);
            // A stand-in reason is said once, on the first row that carries it.
            if (m.note && env.results.slice(0, i).some((x) => x.proxy?.reason === m.note)) delete m.note;
            return (
              <tr key={`${r.input}-${i}`}>
                <td className={r.proxyFor ? "text-muted" : "whitespace-nowrap text-muted"}>{r.proxyFor ? `Stands in for ${r.proxyFor}` : (ROLE_LABEL[r.role] ?? r.role)}</td>
                <td>
                  <span className="font-semibold">{r.input}</span>
                  <span className="mt-0.5 block text-sm text-muted sm:hidden">
                    {m.main}
                    {m.note ? `. ${m.note}` : ""}
                  </span>
                </td>
                <td className="hidden sm:table-cell">
                  {m.main}
                  {m.note ? <span className="mt-0.5 block text-sm text-muted">{m.note}</span> : null}
                </td>
                <td className={`whitespace-nowrap ${r.status === "needs_input" ? "font-semibold" : ""}`}>
                  {RESOLUTION_LABEL[r.status]}
                  {r.ledgerRef ? <Refs ids={[r.ledgerRef]} /> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(pickers ? waiting : []).map((r) => (
        <CandidatePicker
          key={r.input}
          planId={planId}
          input={r.input}
          candidates={r.candidates ?? []}
          sample={sheet?.mode === "fixture"}
          {...(onResolved ? { onResolved } : {})}
        />
      ))}
    </PlanCard>
  );
}
