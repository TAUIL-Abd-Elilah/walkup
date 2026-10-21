"use client";
import Link from "next/link";
import { Fragment, useState } from "react";
import type { LiftTile } from "@walkup/contracts";
import type { Bbox } from "../lib/geohash";
import { LiftLegend } from "./LiftLegend";
import { LiftMap, MapCaption } from "./LiftMap";
import { TileList } from "./TileList";

export interface HeroSide {
  planId: string;
  headliner: string;
  /** Support acts in bill order. */
  support: string[];
  /** Genre from the listing, e.g. "Americana". */
  label: string;
  /** Venue name, e.g. "The Truth". */
  place: string;
  date: string;
  tiles: LiftTile[];
  top: LiftTile[];
  venue: { lat: number; lon: number; name: string };
  partners: number;
  /** A sample (fixture) sheet: said in the side's header. */
  sample?: boolean;
  /** One real pick a popularity list would miss, in one line, with the receipts behind it. */
  missed?: { line: string; refs: string[] } | null;
  /** Stored revisions of this sheet ("All ages, no bars"), linked under the header. */
  revisions?: { planId: string; instruction: string }[];
}

/** "A", "A and B", "A, B and C". */
export function andList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function Side({ side, letter, extent }: { side: HeroSide; letter: "A" | "B"; extent: Bbox | null }) {
  const [selected, setSelected] = useState<string | null>(null);
  const toggle = (gh: string) => setSelected((s) => (s === gh ? null : gh));
  const listId = `hero-${letter}-areas`;
  return (
    // Three rows (bill, map, areas) on a subgrid from 768px, so the two maps start and end on the same line.
    <article className="grid min-w-0 content-start gap-y-3 md:row-span-3 md:grid-rows-subgrid" aria-labelledby={`hero-${letter}`}>
      <header>
        <h3 id={`hero-${letter}`} className="text-[1.375rem]">
          {side.headliner}
        </h3>
        {side.support.length > 0 ? <p className="mt-0.5 text-sm text-muted">with {andList(side.support)}</p> : null}
        <p className="text-sm text-muted">{[`${side.place}, ${side.date}`, side.label, side.sample ? "sample" : null].filter(Boolean).join(" · ")}</p>
        {side.missed ? (
          <p className="mt-1.5 text-sm" data-testid={`hero-${letter}-missed`}>
            {side.missed.line}
            {side.missed.refs.length > 0 ? (
              <sup className="fn">
                {side.missed.refs.map((r, i) => (
                  <Fragment key={r}>
                    {i > 0 ? ", " : ""}
                    <Link href={`/plan/${side.planId}#receipt-${r}`} aria-label={`Receipt ${r}`}>
                      {r}
                    </Link>
                  </Fragment>
                ))}
              </sup>
            ) : null}
          </p>
        ) : null}
        {(side.revisions ?? []).map((r) => (
          <p key={r.planId} className="mt-1 text-sm">
            <span className="text-muted">Revised: </span>
            <Link href={`/plan/${r.planId}`} className="link">
              {r.instruction} &rarr;
            </Link>
          </p>
        ))}
      </header>
      <LiftMap
        tiles={side.tiles}
        venue={side.venue}
        ranked={side.top.map((t) => t.geohash)}
        selected={selected}
        onSelect={toggle}
        idBase={`hero-${letter}`}
        title={`${side.headliner}: areas around ${side.venue.name} by lift`}
        frameClass="aspect-[4/3] md:aspect-[16/9]"
        extent={extent}
        caption={false}
        listId={listId}
      />
      <div className="min-w-0">
        <h4 className="mb-1">{side.top.length === 1 ? "Top area" : `Top ${side.top.length} areas`}</h4>
        <TileList id={listId} tiles={side.top} selected={selected} onSelect={toggle} compact />
        <p className="mt-3">
          <Link href={`/plan/${side.planId}`} className="link">
            Open {side.headliner}&apos;s sheet
          </Link>
          <span className="text-muted"> · {side.partners} suggested partners</span>
        </p>
      </div>
    </article>
  );
}

/**
 * Both bills side by side on one shared frame, so the two maps have the same extent, zoom and scale bar and the
 * difference is the data (ProPublica's small multiples). One legend and one caption under both. Stacks below 768px.
 */
export function HeroSplit({
  a,
  b,
  extent = null,
  legendCaption,
  source,
}: {
  a: HeroSide;
  b: HeroSide;
  extent?: Bbox | null;
  /** Names the baseline: "Fans compared with the room's usual crowd". */
  legendCaption?: string;
  /** "Data: ..." for the caption's source line. */
  source?: string;
}) {
  return (
    <>
      <div className="grid gap-x-10 gap-y-12 md:grid-cols-2 md:gap-y-0">
        <Side side={a} letter="A" extent={extent} />
        <Side side={b} letter="B" extent={extent} />
      </div>
      <LiftLegend className="mt-8" caption={legendCaption} />
      <p className="mt-2 text-sm leading-snug text-muted">
        <MapCaption tiles={[...a.tiles, ...b.tiles]} lead="Both maps use the same frame and scale." whose="each bill's" source={source} />
      </p>
    </>
  );
}
