"use client";
import { useState } from "react";
import type { Candidate } from "@walkup/contracts";
import { subtypeLabel } from "../../lib/labels";

function CandidateRow({ c, disabled, chosen, onPick, sample }: { c: Candidate; disabled: boolean; chosen: boolean; onPick: () => void; sample: boolean }) {
  const facts = [subtypeLabel(c.subtype), c.releaseYear ? String(c.releaseYear) : null, c.popularity === null ? null : `popularity ${c.popularity.toFixed(2)}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className={`flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-rule py-3 ${chosen ? "bg-subtle" : ""}`}>
      <div className="min-w-0 flex-1">
        <p>
          <span className="font-semibold">{c.name}</span> <span className="text-muted">{facts}</span>
        </p>
        {/* The sample strip already says the data is made up; no per-row suffix. */}
        {c.shortDescription ? <p className="mt-0.5">{c.shortDescription.replace(/\s*\(synthetic\)$/, "")}</p> : null}
        {/* Sample entities carry made-up external ids, so a link would open a missing page on a real site. */}
        {c.externalUrl && !sample ? (
          <p className="mt-0.5 text-sm">
            <a href={c.externalUrl} className="link" target="_blank" rel="noreferrer">
              Reference page<span className="sr-only"> for {c.name} (opens in a new tab)</span>
            </a>
          </p>
        ) : null}
      </div>
      {/* The accessible name starts with the visible words, so voice control can say "Use this one". */}
      <button type="button" className="btn btn-ghost" disabled={disabled} onClick={onPick}>
        {chosen ? "Picked" : "Use this one"}
        <span className="sr-only">: {c.name} ({subtypeLabel(c.subtype)})</span>
      </button>
    </li>
  );
}

async function postResolve(planId: string, pick: { input: string; entityId: string; proxy?: boolean }): Promise<{ planId: string }> {
  const res = await fetch(`/api/plan/${encodeURIComponent(planId)}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ picks: [pick], wait: "none" }),
  });
  const body = (await res.json().catch(() => ({}))) as { planId?: string; reason?: string };
  if (!res.ok || !body.planId) throw new Error(body.reason ?? `The server answered ${res.status}.`);
  return { planId: body.planId };
}

/**
 * needs_input: the candidates for one ambiguous name. One click picks and
 * resumes the run. "None of these" searches film and TV titles to stand in.
 */
export function CandidatePicker({
  planId,
  input,
  candidates,
  onResolved,
  sample = false,
}: {
  /** The plan to resume. Null renders the candidates read-only. */
  planId: string | null;
  input: string;
  candidates: Candidate[];
  onResolved?: (planId: string) => void;
  /** Sample data: hide the reference links (their ids are made up). */
  sample?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proxyOpen, setProxyOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<"both" | "movie" | "tv_show">("both");
  const [titles, setTitles] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const readOnly = planId === null;
  const slug = input.replace(/[^A-Za-z0-9]+/g, "-");

  const pick = async (entityId: string, proxy = false) => {
    if (!planId || busy) return;
    setBusy(true);
    setChosen(entityId);
    setError(null);
    try {
      const r = await postResolve(planId, { input, entityId, ...(proxy ? { proxy: true } : {}) });
      onResolved?.(r.planId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setChosen(null);
      setBusy(false);
    }
  };

  const findTitles = async () => {
    const q = title.trim();
    if (q.length < 2) {
      setError("Type a film or TV title first.");
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`/api/proxy-search?q=${encodeURIComponent(q)}&type=${type}`);
      const body = (await res.json().catch(() => ({}))) as { candidates?: Candidate[]; reason?: string };
      if (!res.ok) throw new Error(body.reason ?? `The server answered ${res.status}.`);
      setTitles(body.candidates ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  return (
    <fieldset className="mt-6 min-w-0" aria-busy={busy}>
      <legend className="text-lg font-semibold">Which &ldquo;{input}&rdquo; is on this bill?</legend>
      <p className="hint mt-1">
        {readOnly
          ? "These are the recorded matches. Open the preset to pick one and run it again."
          : "Pick the one on this bill and the plan carries on from here. This browser keeps your pick for 30 days."}
      </p>
      <ul className="mt-3 border-t border-rule">
        {candidates.map((c) => (
          <CandidateRow key={c.entityId} c={c} disabled={readOnly || busy} chosen={chosen === c.entityId} onPick={() => void pick(c.entityId)} sample={sample} />
        ))}
      </ul>

      <div className="mt-4">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={readOnly || busy}
          aria-expanded={proxyOpen}
          aria-controls={`proxy-${slug}`}
          onClick={() => setProxyOpen((v) => !v)}
        >
          None of these: use a film or TV title instead
        </button>
        {proxyOpen && !readOnly ? (
          <div id={`proxy-${slug}`} className="mt-3 max-w-[560px]">
            <p className="hint">The title stands in for {input} when Walkup reads this crowd. Check the year so you get the right one.</p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="min-w-[12rem] flex-1">
                <label className="label text-sm" htmlFor={`proxy-q-${slug}`}>
                  Film or TV title
                </label>
                <input
                  id={`proxy-q-${slug}`}
                  className="input mt-1"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void findTitles();
                    }
                  }}
                  placeholder="A sitcom or a stand-up special"
                />
              </div>
              <div>
                <label className="label text-sm" htmlFor={`proxy-t-${slug}`}>
                  Type
                </label>
                <select id={`proxy-t-${slug}`} className="input mt-1 w-auto" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                  <option value="both">Film or TV</option>
                  <option value="movie">Film</option>
                  <option value="tv_show">TV show</option>
                </select>
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => void findTitles()} disabled={searching || busy}>
                {searching ? "Searching…" : "Find titles"}
              </button>
            </div>
            {titles !== null ? (
              titles.length === 0 ? (
                <p className="hint mt-3">No film or TV title matched. Try the exact title.</p>
              ) : (
                <ul className="mt-3 border-t border-rule">
                  {titles.map((c) => (
                    <CandidateRow key={c.entityId} c={c} disabled={busy} chosen={chosen === c.entityId} onPick={() => void pick(c.entityId, true)} sample={sample} />
                  ))}
                </ul>
              )
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="mt-3 min-h-6 text-base" aria-live="polite">
        {error ? <span className="text-accent">{error}</span> : busy ? <span className="text-muted">Picked. Carrying on with the plan…</span> : null}
      </p>
    </fieldset>
  );
}
