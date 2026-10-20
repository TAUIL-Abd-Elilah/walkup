"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface ShowHit {
  tmEventId: string;
  name: string;
  date: string | null;
  venue: string | null;
  city: string | null;
  acts: string[];
}

export interface FreshRunsInfo {
  youRemaining: number;
  youLimit: number;
  todayRemaining: number;
  todayLimit: number;
}

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

/**
 * Find a show on Ticketmaster: live mode only. A name lists matching events;
 * picking one (or pasting an event URL) starts a fresh run, capped per network
 * and per day, and opens the sheet, which fills in step by step. No match
 * gets a short help list ("Don't see your show?") with causes that are true for
 * this search. Without keys there is no box, only a sentence (the landing page
 * shows the sample sheets in its place).
 */
export function ShowSearch({ enabled, fresh }: { enabled: boolean; fresh: FreshRunsInfo | null }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ShowHit[] | null>(null);
  const [busy, setBusy] = useState<null | "search" | "start">(null);
  const [message, setMessage] = useState<string | null>(null);
  const [left, setLeft] = useState(fresh);

  const search = async () => {
    const text = q.trim();
    if (text.length < 2) {
      setMessage("Type at least two letters of the act or the venue.");
      return;
    }
    setBusy("search");
    setMessage(null);
    setHits(null);
    try {
      const res = await fetch(`/api/events/search?q=${encodeURIComponent(text)}`);
      const body = (await res.json().catch(() => ({}))) as { events?: ShowHit[]; reason?: string };
      if (!res.ok) throw new Error(body.reason ?? `The search didn't work (the server answered ${res.status}). Try again in a minute.`);
      setHits(body.events ?? []);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const start = async (body: Record<string, unknown>) => {
    setBusy("start");
    setMessage(null);
    try {
      const res = await fetch("/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, wait: "none" }) });
      const out = (await res.json().catch(() => ({}))) as { planId?: string; reason?: string; freshRuns?: FreshRunsInfo };
      if (out.freshRuns) setLeft(out.freshRuns);
      if (!res.ok || !out.planId) throw new Error(out.reason ?? `The plan didn't start (the server answered ${res.status}). Try again in a minute.`);
      router.push(`/plan/${out.planId}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!enabled) return;
    if (isUrl(q)) void start({ event: q.trim() });
    else void search();
  };

  const help = enabled
    ? left
      ? `Fresh runs left today: ${left.youRemaining} of ${left.youLimit} from this connection, ${left.todayRemaining} of ${left.todayLimit} in total. The example sheets below don't count.`
      : "Fresh runs are limited each day. The example sheets below don't count."
    : "Search needs Qloo and Ticketmaster keys, and this copy of Walkup runs without them. The sample sheets below work now.";

  // Without keys there is nothing to search: say so in one sentence, with no greyed-out field.
  if (!enabled) return <p className="max-w-[760px]">{help}</p>;

  return (
    <form role="search" aria-label="Find a show" onSubmit={onSubmit}>
      <label htmlFor="show-search" className="label">
        Act, venue or Ticketmaster event URL
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id="show-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-describedby="show-search-help"
          className="input min-w-0 flex-1"
        />
        <button type="submit" className="btn btn-primary" disabled={busy !== null}>
          {busy === "search" ? "Searching…" : busy === "start" ? "Starting…" : isUrl(q) ? "Plan this show" : "Search"}
        </button>
      </div>
      <p id="show-search-help" className="hint mt-1.5">
        {help}
      </p>
      {message ? (
        <p className="note-error mt-3 text-base" role="alert">
          {message}
        </p>
      ) : null}
      {hits && hits.length > 0 ? (
        <>
          <ul className="mt-4 border-t border-rule" aria-label="Matching shows">
            {hits.map((h) => (
              <li key={h.tmEventId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule py-2.5">
                <div className="min-w-0">
                  <p className="font-semibold">{h.name}</p>
                  <p className="text-sm text-muted">
                    {[h.venue, h.city, h.date].filter(Boolean).join(" · ")}
                    {h.acts.length > 0 ? ` · ${h.acts.join(", ")}` : ""}
                  </p>
                </div>
                <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void start({ tmEventId: h.tmEventId })}>
                  Plan this show
                </button>
              </li>
            ))}
          </ul>
          <p className="hint mt-2">Not in the list? Paste the Ticketmaster event URL above. Event data from Ticketmaster.</p>
        </>
      ) : null}
      {hits && hits.length === 0 ? (
        <div className="mt-4" role="status">
          <h3 className="text-base">Don&apos;t see your show?</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>The search only finds upcoming shows listed on Ticketmaster. A show sold only somewhere else won&apos;t come up.</li>
            <li>Search by the headliner&apos;s name as Ticketmaster spells it, or by the venue&apos;s name.</li>
            <li>If you have the Ticketmaster event page, paste its URL to plan that show directly.</li>
          </ul>
        </div>
      ) : null}
    </form>
  );
}
