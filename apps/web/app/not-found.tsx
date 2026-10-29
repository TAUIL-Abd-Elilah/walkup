import type { Metadata } from "next";
import Link from "next/link";

/** Every unmatched path lands here, so the words fit any address; /plan/<id> has its own sheet wording. */
export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <div className="wrap py-16">
      <h1>Nothing at this address</h1>
      <p className="mt-3 text-muted">The link may be mistyped. The sheets are listed on the front page.</p>
      <p className="mt-6">
        <Link href="/#sheets" className="btn btn-primary">
          Go to the sheets
        </Link>
      </p>
    </div>
  );
}
