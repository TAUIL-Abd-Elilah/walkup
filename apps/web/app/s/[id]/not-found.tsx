import type { Metadata } from "next";
import Link from "next/link";

/**
 * The served 404 for an unknown sheet id. Next renders a page's notFound() from this boundary, and the head it serves
 * takes its title from here (with the layouts), not from the page's generateMetadata; without it the tab read
 * "Not found".
 */
export const metadata: Metadata = { title: "Sheet not found" };

/** An unknown sheet id. */
export default function SheetNotFound() {
  return (
    <div className="wrap py-16">
      <h1>No sheet at this address</h1>
      <p className="mt-3 text-muted">The link may be mistyped, or the plan was made on another server. The sheets are listed on the front page.</p>
      <p className="mt-6">
        <Link href="/#sheets" className="btn btn-primary">
          Go to the sheets
        </Link>
      </p>
    </div>
  );
}
