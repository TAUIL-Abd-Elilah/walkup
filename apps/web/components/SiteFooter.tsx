import Link from "next/link";
import { dataSourcesLine } from "@/lib/labels";
import { runtimeMode } from "@/lib/mode";

export function SiteFooter() {
  const kind = runtimeMode().kind;
  return (
    <footer className="no-print mt-16 border-t border-rule">
      <div className="wrap-wide space-y-2 py-8 text-sm text-muted">
        <p>
          <span className="font-semibold text-ink">Walkup</span>, the Fill-the-Room Agent. Fill the room, not the feed.
        </p>
        <p>
          It plans one booked show at a time from aggregate affinities, and nothing here describes a person. Partners are suggested, not
          affiliated.
        </p>
        <p>
          {dataSourcesLine(kind)}{" "}
          Area names and adult counts from the US Census and OpenStreetMap. Map data ©{" "}
          <a className="underline underline-offset-2 hover:text-ink" href="https://www.openstreetmap.org/copyright">
            OpenStreetMap
          </a>{" "}
          contributors, tiles by{" "}
          <a className="underline underline-offset-2 hover:text-ink" href="https://openfreemap.org">
            OpenFreeMap
          </a>
          .
        </p>
        <p className="flex flex-wrap gap-x-4">
          <Link className="underline underline-offset-2 hover:text-ink" href="/system-card">
            System card
          </Link>
          <Link className="underline underline-offset-2 hover:text-ink" href="/eval">
            Eval
          </Link>
        </p>
      </div>
    </footer>
  );
}
