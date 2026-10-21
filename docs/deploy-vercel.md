# Hosting the recorded sheets on Vercel

The hosted site, https://walkup-eight.vercel.app, runs the real Next.js app (`apps/web`) on Vercel's free Hobby plan
in **recorded mode**: it serves the hero sheets recorded from live runs, with their receipts, the print view, every
download (PDF, CSV, ICS, `sheet.json`), `/system-card`, `/eval`, `/healthz` and the MCP tools that read stored sheets.
New plans, searches and revisions answer with the plain recorded-mode reason (HTTP 503), as described in
[deploy.md, Recorded mode](deploy.md#recorded-mode-after-the-qloo-key-is-switched-off-nov-2-2026). No API key is set
on Vercel: recorded mode calls nothing.

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
   for p in g1-a g1-b; do curl -sS -X POST localhost:3219/api/plan -H 'content-type: application/json' -d "{\"presetId\":\"$p\"}" | head -c 300; echo; done
   curl -sS -X POST localhost:3219/api/plan/<g1-b planId>/revise -H 'content-type: application/json' \
     -d '{"instruction":"All ages, no bars","wait":"complete"}' | head -c 300
   curl -s localhost:3219/healthz      # "recorded": {"presets": {"g1-a": {...}, "g1-b": {...}}}
   ```

   A fresh data directory means a cold Qloo cache: about 30 Qloo calls for the first bill, fewer for the second,
   none for the revision. Raw bodies (`WALKUP_RECORD`) stay in the data directory under `.cache/`.
2. Stop the dev server, then export: `node scripts/export-plans.mjs "$R/plans.sqlite"`.
3. Check what would be uploaded; no `.env`, `fixtures/raw`, `probe_out` or `.cache` path may appear, and
   `deploy/vercel/plans.json` must:

   ```bash
   git ls-files -co --exclude-from=.vercelignore | grep -E '(^|/)\.env|fixtures/raw|probe_out|data/private|\.cache|\.sqlite|deploy/vercel'
   ```

4. Deploy from the repository root: `npx vercel@latest deploy --prod`. Vercel builds on Linux, so better-sqlite3 and
   the PDF renderer get their Linux files.
5. Check: `curl -s https://walkup-eight.vercel.app/healthz` says `"mode":"recorded"`, `"planStore":"memory"` and a
   `planId` for g1-a and g1-b; open both preset pages, a receipt, the PDF and a CSV.

`.github/workflows/uptime.yml` checks `/healthz` every 15 minutes.

## Limits on the free plan

- No new plans on the hosted site: it has no keys and no lasting disk. Fresh runs need your own machine (README, "Run
  it yourself") or a live host such as Fly.
- The send step stays in demo mode (no Resend key); prepared sends live in one instance's memory.
- The recorded sheets are in the deployment, not in git. A deploy from a machine without `deploy/vercel/plans.json`
  shows the bundled sample sheets, labelled as samples.
