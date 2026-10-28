import type { ReactNode } from "react";
import { pickRanksLine, type WithWithoutArea } from "../lib/sheet-utils";

/**
 * With Qloo and without, in one area: Qloo's place search with no signal (popularity order) beside Walkup's picks
 * for this show's fans, row by row. The heading is the measured fact (how many of the area's most popular places
 * made the list). No hooks, so the plan page (client) and the landing (server) both use it; each passes its own
 * receipt links.
 */
export function WithWithout({
  data,
  refs,
  lead,
  as: Heading = "h3",
  className = "",
  testId = "with-without",
  explain = true,
}: {
  data: WithWithoutArea;
  /** Receipt links for the two searches, shown after the explanation. */
  refs?: ReactNode;
  /** A muted line above the heading ("Rhiannon Giddens, area 1"). */
  lead?: string;
  as?: "h3" | "h4";
  className?: string;
  testId?: string;
  /** The two-searches explanation under the heading; off where the page explains it once for several tables. */
  explain?: boolean;
}) {
  const n = Math.max(data.popular.length, data.picks.length);
  const where = data.geohash === null ? "near the room" : `in ${data.area}`;
  return (
    <div className={`max-w-[760px] ${className}`} data-testid={testId}>
      {lead ? <p className="text-sm text-muted">{lead}</p> : null}
      <Heading className="text-base">{data.headline}</Heading>
      {!explain && refs ? (
        // A little room above, so the superscript receipt numbers don't ride up into the heading.
        <p className="mt-1 text-sm text-muted">
          The two searches
          {refs}
        </p>
      ) : null}
      {explain ? (
        <p className="mt-1 text-sm text-muted">
          The same Qloo place search {where}, run twice. With no signal, Qloo returns places in popularity order. With this show&apos;s acts as the
          signal, it ranks them for these fans, and Walkup marks down what the room&apos;s usual crowd likes just as much.
          {refs}
        </p>
      ) : null}
      <table className="table mt-2 table-fixed">
        <caption className="sr-only">
          The {data.k} most popular places {where} for any crowd, beside Walkup&apos;s {data.picks.length} picks there for this show&apos;s fans
        </caption>
        <thead>
          <tr>
            <th scope="col" className="w-1/2">
              Most popular here, any crowd
            </th>
            <th scope="col" className="w-1/2">
              Picked for this show&apos;s fans
            </th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: n }, (_, i) => {
            const pop = data.popular[i];
            const pick = data.picks[i];
            return (
              <tr key={i}>
                <td className="break-words align-top">
                  {pop ? (
                    <>
                      <span className="tabular text-muted">{pop.rank}. </span>
                      {pop.name}
                      {pop.onSheet ? <span className="text-sm text-muted"> (also picked)</span> : null}
                    </>
                  ) : null}
                </td>
                <td className="break-words align-top">
                  {pick ? (
                    <>
                      {pick.name}
                      <span className="block text-sm text-muted">{pickRanksLine(pick)}</span>
                    </>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
