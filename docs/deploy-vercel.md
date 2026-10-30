# Hosting the recorded sheets on Vercel

The hosted site, https://walkup-eight.vercel.app, runs the real Next.js app (`apps/web`) on Vercel's free Hobby plan
in **recorded mode**: it serves the hero sheets recorded from live runs, with their receipts, the print view, every
download (PDF, CSV, ICS, `sheet.json`), `/system-card`, `/eval`, `/healthz` and the MCP tools that read stored sheets.
New plans and searches answer with the plain recorded-mode reason (HTTP 503), as described in
[deploy.md, Recorded mode](deploy.md#recorded-mode-live-runs-paused). No API key is set
on Vercel: recorded mode calls nothing.

"Change something" still works on the four hero sheets, from changes made ahead. Each hero sheet has four or five
revisions recorded from live runs, 19 in all (its ready-made changes, listed under the box). The fixed rules read the note on Vercel (no
model key there, and the page says so) and turn it into revise tool calls; the page shows that reading, then opens the
ready-made revision whose own calls give the same changes. Any other change gets a plain
answer that it needs new Qloo requests while live runs are paused, with the ready-made changes to pick from; nothing
is sent and nothing is stored. `WALKUP_RECORDED_REVISE=off` turns this off (revisions answer 503 again and the box
hides).

| Sheet | Ready-made changes |
|---|---|
| g1-a Rhiannon Giddens, The Anthem | All ages, no bars (Oct 21, with the sheet); Street team only on Saturday; Within 10 km of the room; Skip H Street NE; No restaurants |
| g1-b FLO, The Anthem | All ages, no bars (Oct 21, with the sheet); Street team only on Saturday; Skip U Street / Shaw; No restaurants |
| g4-a Greensky Bluegrass, The Salt Shed | All ages, no bars (Oct 21, with the sheet); Street team only on Saturday; Within 10 km of the room; Skip Schaumburg; No restaurants |
| g4-b The Roots, The Salt Shed | Street team only on Saturday; Within 10 km of the room; Skip Bronzeville; No restaurants; All ages, no bars |

The changes without a date (16) were recorded on Oct 28 2026 and say so on their sheets. They re-ran each parent's own
request with the note's overrides, on the parent's own Qloo answers wherever a request did not change (the Qloo cache
of the records that made the parents) and on the parent's Ticketmaster roster of the room (rebuilt from the parent's
receipts, so the room's usual crowd is the parent's; that receipt is marked as reused). Recording them did not change
the parents.

After that, on Oct 28 to 30 2026, all 23 sheets in `plans.json`, the four parents included, were re-checked offline
with no API call (`recheckSheet` in `packages/orchestrator/src/refresh.ts`, run by
`scripts/refresh-recorded-plans.ts --recheck`; the README's "Re-checked offline, Oct 28 to 30 2026" lists what
changed). Each area gained its state, partner lines were reworded, 16 Claude sentences became template wording,
"isn't searched yet" became "aren't", and the Checks step and each revision's change list were rebuilt. SWIG, a bar by
its Qloo tags, left the two "All ages, no bars" revisions at The Salt Shed. That pass changed no Qloo or Ticketmaster answer, ranking,
partner list or ledger number, and removed FLO's "Within 10 km of the room" version (below). A second
pass on Oct 29 gave one FLO partner back its run's kind, dropped four dead partner website links, showed four places'
own websites, made chain lists count places, said partner chains are last in their area, fixed the Summary and Checks
steps' wording, wrote "partner lines" for "line(s)" and "1 of 1 act" for "1 of 1 acts", named every chain signal in the chain note and removed a repeated
label from 16 ledger notes. A third pass on Oct 29 made every "about N times" follow one rule (the 2-decimal lift,
rounded half up); four stored lines changed. A fourth pass on Oct 29 held Claude's lines to newer checks (ten of the
16 template swaps above: partner lines that called a partner a before- or after-show stop, an area's places called
spots, an unbacked "stands out most", a wrong percentile, an equal budget split the sheet doesn't show), wrote "an 82nd"
for "a 82nd", wrote "about 2.0 times" for "about 2 times" where 2.0 is the area's figure, and dropped two fan copy
lines that called the room "cozy" or "intimate" from a taste tag. A fifth pass on Oct 30 fixed wording that the rest
of its sheet contradicts: the lift card's count of areas names its two tests, a top pick that passed over a
higher-ranked national chain says "national chains aside", one Claude summary says "R&B" for "Music / R&B", the
Summary step no longer counts the copy lines kept as the lines Claude wrote, the Checks step counts a dropped "cozy"
or "intimate" copy line as a claim the run didn't back, and two more Claude sentences (an
unbacked top percentile in an area line, and a summary's "stands out in five areas" where the lift card counts 66)
became template wording, the last of the 16. The same pass left out a partner whose name says restaurant on two of the
four "No restaurants" revisions (Right Spot Restaurant & Bar on FLO's, La Parra Restaurant & Bar on Greensky
Bluegrass's; each now lists 13 partners and its counts follow), gave Walmart Neighborhood Market on The Roots' "Skip
Bronzeville" revision the kind its own tags say, a bakery (a department-store tag alone no longer makes a clothing
store), and had the fixed-wording summary say the crowd stands out "in the sheet's top 5 areas". No Qloo or
Ticketmaster answer, ledger number or ranking of the places kept changed.

FLO has no "Within 10 km of the room" change. Fewer than 200 map squares come back near The Anthem for FLO's crowd,
so the map widens to 60 km either way, and the version recorded for that note changed nothing on the sheet. It was
removed.

Fly.io ([deploy.md](deploy.md)) is still the setup for a live host (an always-on machine and a volume). Nothing in
this file changes it.

## How it works

| Piece | What it does |
|---|---|
| `scripts/export-plans.mjs` | Exports the complete live plans of a plan store (`plans.sqlite`) to `deploy/vercel/plans.json`: the recorded sheets and their revisions, never raw Qloo bodies. The file is git-ignored and ships with a deploy only. |
| `WALKUP_PLAN_SEED` | When set, the server loads that JSON into an in-memory plan store instead of opening `plans.sqlite` (`apps/web/lib/server/engine.ts`). A relative path is looked up from the working directory upwards. Each serverless instance reads the same copy; nothing new is kept. |
| `apps/web/next.config.ts` | When `VERCEL` is set at build time, traces in the files the server reads from computed paths: the gazetteer, `config/*.json`, `fixtures/synthetic`, `deploy/vercel/plans.json` and better-sqlite3's Linux binary. |
| `apps/web/vercel.json` | Installs from the repository root (`npm ci`, npm workspaces) and runs `next build` in `apps/web`. |
| `.vercelignore` | The CLI uploads local files, git-ignored ones included, so this lists everything that must never leave the machine: `.env*`, `fixtures/raw/`, `probe_out/`, `data/private/`, `.cache/`, SQLite files, `node_modules`, `.next`. |

Project settings (Vercel project `walkup`): root directory `apps/web`, framework Next.js, Node 22.x. Environment
variables (Production and Preview), none of them secret:

| Variable | Value |
|---|---|
| `WALKUP_MODE` | `recorded` |
| `WALKUP_DATA_DIR` | `/tmp/walkup` (the only writable place; small state files only) |
| `WALKUP_PLAN_SEED` | `deploy/vercel/plans.json` |
| `NEXT_TELEMETRY_DISABLED` | `1` |

## Recording and deploying again

1. Record on a machine that has the keys, into a fresh data directory, with the dev server in live mode:

   ```bash
   R="$PWD/.cache/record-$(date +%F)"; mkdir -p "$R/fixtures/raw"
   (cd apps/web && WALKUP_MODE=live WALKUP_RECORD=1 WALKUP_DATA_DIR="$R" WALKUP_FIXTURES_DIR="$R/fixtures" \
     WALKUP_FRESH_RUNS_PER_IP=10 npx next dev -p 3219)
   # in another shell
   for p in g1-a g1-b g4-a g4-b; do curl -sS -X POST localhost:3219/api/plan -H 'content-type: application/json' -d "{\"presetId\":\"$p\"}" | head -c 300; echo; done
   curl -sS -X POST localhost:3219/api/plan/<g1-b planId>/revise -H 'content-type: application/json' \
     -d '{"instruction":"All ages, no bars","wait":"complete"}' | head -c 300
   curl -s localhost:3219/healthz      # "recorded": {"presets": {"g1-a": {...}, "g1-b": {...}, "g4-a": {...}, "g4-b": {...}}}
   ```

   A fresh data directory means a cold Qloo cache: about 30 Qloo calls for the first bill, fewer for the second,
   none for the revision. Raw bodies (`WALKUP_RECORD`) stay in the data directory under `.cache/`.
2. Stop the dev server, then export: `node scripts/export-plans.mjs "$R/plans.sqlite"`. Then make the ready-made
   changes for "Change something" (about 90 Qloo calls and 35 model calls for all four sheets; a note the model reads
   differently from the fixed rules is skipped, since the rules read notes on Vercel; `--reader rules` records it
   with the rules):

   ```bash
   D="$PWD/.cache/record-$(date +%F)-revisions"
   npx tsx scripts/precompute-revisions.ts seed --dir "$D" --from "$R"      # plans.json + the record's Qloo cache
   npx tsx scripts/precompute-revisions.ts record --dir "$D" --offline     # no call: every unchanged request is cached
   npx tsx scripts/precompute-revisions.ts record --dir "$D"               # live; stops on drift or past --max-qloo/--max-model
   npx tsx scripts/precompute-revisions.ts merge --dir "$D"                # backs up plans.json, appends, proves the old plans unchanged
   ```

   `record` stops if a revision makes a request its note cannot reach (the bill, the room, its usual crowd; the heat
   calls too unless the note changes the radius). A new room needs its roster in `ROOM_ROSTERS` in the script first.
   Sheets kept from an older engine can be held to the newer checks offline, with no API call:
   `npx tsx scripts/refresh-recorded-plans.ts --recheck` (the original is kept as `plans.before-refresh.json`).
3. Check what would be uploaded; no `.env`, `fixtures/raw`, `probe_out` or `.cache` path may appear, and
   `deploy/vercel/plans.json` must:

   ```bash
   git ls-files -co --exclude-from=.vercelignore | grep -E '(^|/)\.env|fixtures/raw|probe_out|data/private|\.cache|\.sqlite|deploy/vercel'
   ```

4. Deploy from the repository root: `npx vercel@latest deploy --prod`. Vercel builds on Linux, so better-sqlite3 and
   the PDF renderer get their Linux files.
5. Check: `curl -s https://walkup-eight.vercel.app/healthz` says `"mode":"recorded"`, `"planStore":"memory"` and a
   `planId` for g1-a, g1-b, g4-a and g4-b; open the preset pages, a receipt, the PDF and a CSV.

`.github/workflows/uptime.yml` checks `/healthz` every 15 minutes.

## Limits on the free plan

- No new plans on the hosted site: it has no keys and no lasting disk. Fresh runs need your own machine ([README, "Setup from a
  clean environment"](../README.md#setup-from-a-clean-environment)) or a live host such as Fly.
- The send step stays in demo mode (no Resend key); prepared sends live in one instance's memory.
- The recorded sheets are in the deployment, not in git. A deploy from a machine without `deploy/vercel/plans.json`
  shows the bundled sample sheets, labelled as samples.
