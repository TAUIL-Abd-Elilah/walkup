import Link from "next/link";

export default function NotFound() {
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
