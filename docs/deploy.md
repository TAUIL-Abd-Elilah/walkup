# Deploying Walkup on Fly.io

One Fly.io app, one always-on machine in `iad` (US East), one volume at `/data`. The owner runs every command below
from the repository root with their own Fly account. Nothing here creates an account, and nothing is deployed until
`fly deploy` is run.

Files: [`Dockerfile`](../Dockerfile), [`.dockerignore`](../.dockerignore), [`fly.toml`](../fly.toml).
The web app already builds with `output: "standalone"`, which the image needs.

## What runs where

| Where | What |
|---|---|
| Image (rebuilt on every deploy) | Next.js standalone server for `apps/web`, run as the `node` user from `/app/apps/web`. Read-only data in the repository layout: `/app/data/gazetteer/out`, `/app/config`, `/app/fixtures/synthetic`. |
| Volume `walkup_data` at `/data` (kept across deploys) | Everything the server writes: the Qloo SQLite cache and month quota (`qloo-cache.sqlite`), the Anthropic daily spend file, stored plans and sends, and recorded fixtures in `/data/fixtures/raw`. `/data/fixtures/synthetic` is a link to the image's copy. |
| Fly secrets | API keys, the Resend sender, the send signing secret and the postal address. Encrypted by Fly, visible to the machine as environment variables only. |
| Never on the host, in the image or in git | `.env*`, `data/private/`, `probe_out/`. Recorded Qloo bodies (`fixtures/raw/`) live only on the volume and on the machine that recorded them. |

The image is multi-stage: `npm ci` from the lockfile (with `python3`, `make` and `g++` in case `better-sqlite3` has to
be compiled), `next build` with standalone output, then a slim `node:22-bookworm-slim` runtime. The entrypoint starts
as root only to create `/data/fixtures/raw` and hand `/data` to `node` (Fly mounts volumes owned by root), then runs
the server as `node` with `setpriv`.

## Before the first deploy

1. `apps/web/next.config.ts` needs `output: "standalone"`. Without it the Docker build stops with a message that
   says so.
2. Install `flyctl` ([fly.io/docs/flyctl/install](https://fly.io/docs/flyctl/install/)) and sign in:

   ```bash
   fly auth login
   ```

3. Optional local check (Docker with BuildKit, which is the default since Docker 23):

   ```bash
   docker build -t walkup:local .
   docker run --rm -p 3000:3000 -v walkup-data:/data walkup:local
   curl -s http://localhost:3000/healthz
   ```

   Pass keys with `--env-file` pointing at a file outside the repository if you want live mode locally. Do not push
   this image anywhere; `fly deploy` builds its own.

## First deploy

```bash
# 1. Create the app from fly.toml without deploying.
fly launch --no-deploy --copy-config --name walkup-agent --region iad --org personal
```

- Fly app names are global. `walkup` was taken, so the hosted app is `walkup-agent`. If that is taken too, pick another name; `fly launch` writes it into `app` in
  `fly.toml`, and every `-a walkup-agent` below changes with it.
- Decline the database, Redis and object-storage offers.
- Run `git diff fly.toml` afterwards. `fly launch` can rewrite settings; keep `auto_stop_machines = "off"`,
  `min_machines_running = 1`, the `[[mounts]]` block and the `/healthz` check.
- Non-interactive alternative: `fly apps create walkup-agent --org personal`.

```bash
# 2. The volume: 1 GB, daily snapshots kept for 14 days. One volume means one machine.
fly volumes create walkup_data --region iad --size 1 --snapshot-retention 14 --yes -a walkup-agent
```

```bash
# 3. Secrets, staged so the first deploy applies them all at once.
#    The leading space keeps the line out of bash history when HISTCONTROL includes ignorespace.
 fly secrets set --stage -a walkup-agent \
  QLOO_API_KEY=... \
  TICKETMASTER_API_KEY=... \
  CENSUS_API_KEY=... \
  OPENROUTER_API_KEY=... \
  RESEND_API_KEY=... \
  RESEND_FROM='Walkup <street-sheets@your-verified-domain.example>' \
  WALKUP_SIGNING_SECRET="$(openssl rand -hex 32)" \
  WALKUP_POSTAL_ADDRESS='Street address, City, ST 00000'
```

The last two are read by `@walkup/send` (see
[Variables the send step reads](#variables-the-send-step-reads)). Without the postal address every real send is
refused.

To keep keys off the command line entirely, write `NAME=value` lines to a file outside the repository, run
`fly secrets import --stage -a walkup-agent < that-file`, then delete the file.

```bash
# 4. Deploy. Fly's remote builder builds the image; nothing is built or pushed from this machine.
fly deploy -a walkup-agent --ha=false
```

```bash
# 5. Check.
fly status -a walkup-agent
fly volumes list -a walkup-agent
curl -s https://walkup-agent.fly.dev/healthz
fly logs -a walkup-agent
```

`/healthz` answers `{"ok":true,"mode":...,"configured":{...},"qloo":{...},"recorded":{...}}`. `mode` is `live`,
`fixture` or `recorded` (see [Recorded mode](#recorded-mode-after-the-qloo-key-is-switched-off-nov-2-2026)).
`configured` shows which keys are present, never their values; `qloo` shows a key Qloo rejected (status and time) and
`WALKUP_QLOO_UNTIL`; `recorded` lists the stored live run each preset shows in recorded mode.

The image is built without secrets. The web app reads the mode per request (the layout opts out of prerendering and the
pages are dynamic), so every page and `/healthz` show the machine's own mode.

### Every variable in `.env.example`

| Variable | Set on the host as | Value or note |
|---|---|---|
| `QLOO_API_KEY` | secret | Can stay set after the key is switched off: recorded mode calls nothing (see [Recorded mode](#recorded-mode-after-the-qloo-key-is-switched-off-nov-2-2026)). |
| `QLOO_BASE_URL` | `fly.toml` `[env]` | `https://hackathon.api.qloo.com`. Any other host is refused. |
| `TICKETMASTER_API_KEY` | secret | |
| `CENSUS_API_KEY` | secret | Optional: the gazetteer already carries adult counts. |
| `OPENROUTER_API_KEY` | secret | Claude through OpenRouter (narration, free-text parsing, change notes). `OPENROUTER_MODEL` (plain env) overrides the slug `anthropic/claude-opus-5.5`. |
| `ANTHROPIC_API_KEY` | secret | Optional instead of the OpenRouter key: Claude directly, with the server-side refusal fallback. With neither key, narration uses the labelled template and change notes the fixed rules. |
| `RESEND_API_KEY` | secret | |
| `RESEND_FROM` | secret | A sender on a domain verified in Resend. Not sensitive, but set per deployment. |
| `WALKUP_DATA_DIR` | `fly.toml` `[env]` and the image | `/data` (the volume). |
| `WALKUP_MODE` | `fly.toml` `[env]` and the image | `auto`: live while `QLOO_API_KEY` and `TICKETMASTER_API_KEY` are set, the synthetic sample world (fixture) without them. `recorded`: stored live sheets only, no new plans. `fixture`: the sample world whatever else is set. |
| `WALKUP_QLOO_UNTIL` | secret or `fly.toml` `[env]`, from late October | The time Qloo stops answering, e.g. `2026-11-02` (00:00 UTC). From then on the server is in recorded mode. Unset: no date. |
| `QLOO_MONTH_GUARD_FLOOR` | `fly.toml` `[env]` | `1500`: fresh Qloo calls stop below 1,500 calls left this month. |
| `WALKUP_RECORD` | secret, only while recording | `1` writes Qloo bodies to `/data/fixtures/raw`. Unset it afterwards. |
| `WALKUP_FIXTURES_DIR` | `fly.toml` `[env]` and the image | `/data/fixtures` (`raw/` recorded on the volume, `synthetic/` from the image). |

`GOOGLE_PLACES_API_KEY` is no longer read: Google Places was removed from the product on Oct 20 2026. A host that
still has it set can drop it with `fly secrets unset GOOGLE_PLACES_API_KEY -a walkup-agent`.
| `WALKUP_GAZETTEER_DIR` | `fly.toml` `[env]` and the image | `/app/data/gazetteer/out`. |
| `WALKUP_TAGS_FILE` | `fly.toml` `[env]` and the image | `/app/config/tags.json`: the pinned Qloo tag URNs the orchestrator reads. |
| `WALKUP_FRESH_RUNS_PER_IP`, `WALKUP_FRESH_RUNS_PER_DAY` | optional, `fly.toml` `[env]` | Fresh live runs per network and in total per UTC day; defaults 3 and 15. |
| `WALKUP_PLAN_STORE` | not on the host | `memory` keeps plans in memory (tests); the host uses `/data/plans.sqlite`. |
| `QLOO_ALLOW_HOST` | never | Local mock servers only. |
| `WALKUP_URL` | not on the host | For the agent skill CLI on a user's machine: `https://walkup-agent.fly.dev`. |

### Variables the send step reads

`@walkup/send` (the confirm-gated "Send to street team") reads three more variables (also in `.env.example`):

| Variable | Set on the host as | Value or note |
|---|---|---|
| `WALKUP_SIGNING_SECRET` | secret | At least 32 characters (`openssl rand -hex 32`). Signs confirm tokens and keys the address and IP hashes. Unset: a random secret per process, so a prepared send cannot be confirmed after a restart. |
| `WALKUP_POSTAL_ADDRESS` | secret | The physical postal address in every email footer. A real send is refused without it. `\n` in the value becomes a line break. |
| `WALKUP_SEND_DAILY_CAP` | optional, `fly.toml` `[env]` | Confirmed sends per requester per UTC day; default 10. |

Changing a secret (`fly secrets set` or `fly secrets unset` without `--stage`) restarts the machine.

## Keeping it up through Dec 31 2026

- **Always on.** `min_machines_running = 1` and `auto_stop_machines = "off"` keep the machine running when idle;
  `[[restart]] policy = "always"` restarts it after a crash. Keep exactly one machine
  (`fly scale count 1 -a walkup-agent`): a second one would need its own volume and would split the cache and quota
  files.
- **GitHub Actions, every 5 minutes.** `.github/workflows/uptime.yml` GETs `/healthz` (3 tries, 20 s apart) and fails
  unless it answers `"ok":true`; a failed run shows in the Actions tab and GitHub emails the owner. GitHub can start
  a scheduled run a few minutes late and pauses schedules after 60 days without repository activity. Run it by hand
  from the Actions tab (`workflow_dispatch`).
- **UptimeRobot, every 5 minutes (optional second monitor).** Add a monitor of type *Keyword*, URL `https://walkup-agent.fly.dev/healthz`,
  keyword `"ok":true` (alert when it is missing), interval 5 minutes, alerting the owner's email. The free plan
  allows a 5-minute interval; check that its current terms fit this use. `/healthz` never calls Qloo or any other
  upstream API, so these 8,640 checks a month, plus Fly's own check every 30 seconds, cost no API quota.
- **Prepaid credit.** In the Fly dashboard (Billing), add credit that covers the machine through Dec 31 2026: about
  $28-33 at the estimate below (two and a half months from mid-October); $40 leaves a margin.
- **Monthly look (Nov 1, Dec 1).** `fly status`, `fly volumes list` (size and auto-extend), `fly volumes snapshots list
  <volume-id>`, the `/healthz` output, `fly logs` for restarts, and the invoice preview in the dashboard.
- **Deploys take the site offline briefly** (about 20-60 seconds: with one machine and one volume, Fly stops the
  machine, swaps the image and starts it again, keeping the same volume). Do not deploy while someone is using the
  hosted sheet.
- **After Dec 31 2026**, the owner chooses: keep it running; stop compute with `fly scale count 0 -a walkup-agent`
  (the volume is still billed); or download what is worth keeping and run `fly apps destroy walkup-agent`, which
  deletes the volume and its snapshots for good.

## Cost estimate

Approximate, from Fly's published pay-as-you-go prices for `iad`. Check
[fly.io/docs/about/pricing](https://fly.io/docs/about/pricing/) before prepaying.

| Item | Size | About, per month |
|---|---|---|
| Machine, always on | `shared-cpu-1x`, 2 GB RAM | $10-11 |
| Volume | 1 GB, auto-extends 1 GB at a time up to 5 GB when 80 % full | $0.15-0.75 |
| Volume snapshots | daily, kept 14 days | under $1 |
| Outbound data | pages and JSON only; map tiles come from OpenFreeMap | under $1 |
| IPv4 | shared (the default) | $0 |
| UptimeRobot | free plan | $0 |
| **Total** | | **about $11-13** (under $15 with a $2 dedicated IPv4) |

With 1 GB RAM (`fly scale memory 1024 -a walkup-agent`) the total is about $6-7. Watch `fly logs` for out-of-memory
restarts, especially during PDF exports, and go back to 2 GB if they appear.

### Cost caps

| Service | Cap | Where it is enforced |
|---|---|---|
| Fly | about $15/month | Configuration: one machine of a fixed size, no autoscaling. |
| Qloo | stop fresh calls below 1,500 left this month; fresh runs capped per IP and per day | `QLOO_MONTH_GUARD_FLOOR` in `packages/qloo`; the per-IP and daily caps in the web app. Cached answers are still served. |
| Claude (OpenRouter or Anthropic) | $5/day | The narrator's spend guard; the spend file lives on the volume. Above the cap narration uses the labelled template. |
| Resend | free tier, 100/day; 10 confirmed sends per requester per day | Resend's plan; `WALKUP_SEND_DAILY_CAP` in `packages/send`. Every send needs a human confirm in the app. |

## Recorded mode after the Qloo key is switched off (Nov 2 2026)

The Qloo hackathon key stops working on Nov 2 2026. From then on the site serves the sheets it recorded on live runs
and makes nothing new. The web app calls this **recorded** mode:

- Each preset (`g1-a`, `g1-b`, `g2`, `g3`) shows its latest stored live run made with the preset's own inputs, skipping
  a run on which Qloo refused the key (401, or 403 with no fresh Qloo call answered; answers from the Qloo cache do not
  count) and one with at least half of its cards failed. A preset with no such run shows its bundled sample sheet, labelled "Sample sheet".
- Any stored live sheet still opens at `/plan/<id>`, `/s/<id>` and `/api/sheet/<id>`, with its downloads. Sample
  sheets stored earlier stay labelled sample. The send step stays as it is (confirm first, test inbox by default).
  A recorded sheet's envelope (`/api/sheet/<id>`, MCP `get_sheet`) says `"mode": "recorded"`; the sheet inside keeps
  `"mode": "live"`. A sheet recorded before Oct 20 2026 is served without the Google Places comparison list it carried.
- A strip on every page says since when Qloo has been unavailable, that new plans are off, and that sheets recorded
  from live runs show the date of the run and are not refreshed. The landing page lists the sheets as recorded, or as
  sample sheets when no live run was recorded. A recorded sheet says "Recorded <date>" where a live one says
  "Planned <date>", on the page and in the PDF.
- New plans, the show and title searches, picks, revisions and the MCP tools other than `get_sheet` answer with
  `"mode": "recorded"` and one plain reason (HTTP 503 on the REST routes). Nothing calls Qloo or Ticketmaster.

The server is in recorded mode when `WALKUP_MODE=recorded`, when the time in `WALKUP_QLOO_UNTIL` has passed, or when
Qloo has rejected the configured key and the plan store holds a live sheet. A rejected key with no live sheet stored
falls back to fixture mode (the synthetic sample world), as before. The stored sheets live in `/data/plans.sqlite` on
the volume; raw Qloo bodies (`WALKUP_RECORD`) are not needed for this.

1. **Before Nov 2, record each preset live on the host.** Only a preset with a live show (its `live` block: g1-a and g1-b)
   can be recorded; one without stops with "This preset has no live show yet." and records nothing. While the
   server is live, a preset page shows the bundled sample until a live run of that preset's live show is stored. Start one per preset with the preset's own inputs (no what-ifs,
   no partner list, no picks sent up front). Each is a fresh run and counts against the caps (3 per network and 15 per
   day), so run the fourth from another network or the next day; answering a pick does not count again.

   ```bash
   for p in g1-a g1-b g2; do      # g3 the same way, from another network or the next day
     curl -sS -X POST https://walkup-agent.fly.dev/api/plan -H 'content-type: application/json' -d "{\"presetId\":\"$p\"}" | head -c 400; echo
   done
   ```

   A preset that stops at `needs_input` (G2's one-word act) lists its candidates under `pending`. Pick one, as an
   operator would, with the `planId` it returned:

   ```bash
   curl -sS -X POST https://walkup-agent.fly.dev/api/plan/<planId>/resolve -H 'content-type: application/json' \
     -d '{"picks":[{"input":"<the pending input>","entityId":"<one of its candidates>"}],"wait":"complete"}'
   ```

   Then check that every preset has its recording:

   ```bash
   curl -s https://walkup-agent.fly.dev/healthz    # "recorded": {"presets": {"g1-a": {"planId": ..., "createdAt": ...}, ...}}
   ```

   A preset that shows `null` has no usable live run yet. Open each `/plan/<preset>` and read the sheet before the key
   goes: this is what visitors will see until Dec 31.

   **Re-recording.** Once a preset has a stored run, `POST /api/plan {"presetId": ...}` serves that run; there is no
   public way to replace it. After a code change or a show change, the operator re-records with a token held in Fly
   secrets (32 characters or more; requests without it get 403):

   ```bash
    fly secrets set WALKUP_OPERATOR_TOKEN="$(openssl rand -hex 32)" -a walkup-agent   # once; keep a copy off the repo
   curl -sS -X POST https://walkup-agent.fly.dev/api/plan -H "Authorization: Bearer $WALKUP_OPERATOR_TOKEN" \
     -H 'content-type: application/json' -d '{"presetId":"g1-a","rerecord":true}' | head -c 400
   ```

   The new run is stored and becomes the preset; earlier runs stay in the store under their own ids. A re-record is a
   fresh run and counts against the caps.
2. **Snapshot the volume.**

   ```bash
   fly volumes list -a walkup-agent                           # note the volume id
   fly volumes snapshots create <volume-id> -a walkup-agent
   ```

3. **Switch.** Either set the date ahead of time, and the server switches itself at 00:00 UTC that day:

   ```bash
   fly secrets set WALKUP_QLOO_UNTIL=2026-11-02 -a walkup-agent   # restarts; a date means 00:00 UTC, a time without an offset is UTC
   ```

   or, on the day, set `WALKUP_MODE = "recorded"` under `[env]` in `fly.toml` and run `fly deploy`. Keep the volume:
   it holds the recordings. The keys can stay set; nothing calls Qloo in recorded mode. `WALKUP_MODE=fixture` would
   show the synthetic sample world instead.
4. **Check.** `curl -s https://walkup-agent.fly.dev/healthz` shows `"mode":"recorded"`, `"qloo":{"keyRejected":...,"until":...}`
   and a `planId` for each recorded preset. Open each preset: the strip at the top, "Recorded <date>" in the header,
   and no "Run it again" or "Change something".

If neither variable is set, the first fresh run after the key is switched off sees Qloo refuse it (401, or 403 on every
call), records that in `/data/qloo-key-status.json`, and the server switches to recorded mode from then on (fixture
mode if no live sheet is stored). That run stops with an error, or its sheet fails the recording check, so it never
stands in for a preset.

## Copying recorded fixtures onto the volume

Recorded fixtures are Qloo response bodies. They stay out of git (`fixtures/raw/` is git-ignored and
`scripts/check-no-raw.mjs` refuses them in the pre-commit hook) and out of the image (`.dockerignore`). On the host
they live only on the volume.

From the repository root, on the machine that holds them:

```bash
ls fixtures/raw | wc -l
tar -czf "$HOME/walkup-raw.tgz" -C fixtures/raw .       # the archive goes outside the repository
fly ssh sftp shell -a walkup-agent
```

In the sftp shell (`put` takes an absolute local path; on Windows, for example `C:/Users/you/walkup-raw.tgz`):

```
put /home/you/walkup-raw.tgz /data/walkup-raw.tgz
```

Leave the shell with Ctrl-D, then unpack, hand the files to `node` and count them:

```bash
fly ssh console -a walkup-agent -C "sh -c 'tar -xzf /data/walkup-raw.tgz -C /data/fixtures/raw && rm /data/walkup-raw.tgz && chown -R node:node /data/fixtures && ls /data/fixtures/raw | wc -l'"
rm "$HOME/walkup-raw.tgz"
```

The count on the host should match the local count. A single file works the same way:
`put /abs/path/fixtures/raw/<sha256>.json /data/fixtures/raw/<sha256>.json`. If `put` refuses to overwrite an
existing file, remove it first with `fly ssh console -C "rm /data/<file>"`. Anything else the app keeps under `/data`
(for example stored plans) copies the same way.

To take a copy off the host (keep it outside the repository):

```bash
fly ssh console -a walkup-agent -C "sh -c 'tar -czf /tmp/walkup-data.tgz -C /data fixtures/raw'"
fly ssh sftp get /tmp/walkup-data.tgz "$HOME/walkup-data.tgz" -a walkup-agent
```

## Deploys and restarts

- `fly deploy` rebuilds the image and updates the machine in place (same machine, same volume). The health check on
  `GET /healthz` has to pass within 30 seconds of start. If it does not, `fly deploy` reports the failure;
  `fly releases -a walkup-agent --image` lists earlier images and `fly deploy -a walkup-agent --image <image>` goes back
  to one.
- On `SIGTERM` the Next.js server exits at once, so a plan run in progress stops and has to be run again.
- `fly apps restart walkup-agent` re-runs the entrypoint, which re-owns `/data` for `node`.

## Security notes

- Keys exist only as Fly secrets. `/healthz` reports presence only; ledger entries and copy-as-curl show
  `$QLOO_API_KEY`, never the value.
- `fly ssh console` is root on the machine. Keep the Fly organization to the people who operate the app.
- The server process runs as `node`. Only the entrypoint runs as root, to prepare `/data`.

## Static mirror

https://walkup-mirror.fly.dev is a static copy of the hero sheets for when the main app is down: the home page,
both Anthem sheets and the "All ages, no bars" revision (each with its print view and every download), the system
card and the eval. It is a second Fly app in another region (`ord`; the main app is in `iad`), plain nginx, no
Node, no keys, no database. Every page says at the top that it is a static copy and when it was saved; the street
map, receipt dialogs, sending and new plans are off there. The uptime workflow checks it too.

To refresh it after the hero runs change (the files in `deploy/mirror/site/` are git-ignored: they hold the sheets'
data):

```
cd deploy/mirror
npm i --no-save playwright-core
A=<g1-a plan id>; B=<g1-b plan id>; R=<revision plan id>
CHROMIUM_PATH=<path to chromium> node mirror.mjs https://walkup-agent.fly.dev site $A $B $R
for id in $A $B $R; do mkdir -p site/api/sheet/$id
  for f in pdf ics partners.csv zips.csv pins.csv offer-codes.csv sheet.json; do
    curl -fsS -o site/api/sheet/$id/$f https://walkup-agent.fly.dev/api/sheet/$id/$f; done; done
mkdir -p site/_next && cp -R ../../apps/web/.next/static site/_next/static   # the CSS of the deployed build
fly deploy -a walkup-mirror
```

Copy `_next/static` from the same build that is deployed, or the pages lose their styles. Run the crawl against
the live site, not a local server, so the saved pages match what judges and users see.

## Troubleshooting

### Building the image without a remote builder

Fly's remote builder is reached over WireGuard, or over plain HTTP when WireGuard is off. A machine behind an
HTTPS-only proxy can reach neither. There, build the app on the host and package it with the runtime stage only
(this is how the first deploy on Oct 20 2026 was made):

1. `npm ci && cd apps/web && npx next build` on a Linux x64 host (better-sqlite3's bundled `linux-x64` binary needs
   glibc 2.34 or newer; the runtime image has 2.36).
2. Put next to each other, in an empty directory: `standalone/` (`apps/web/.next/standalone`), `static/`
   (`apps/web/.next/static`), an empty `public/`, `out/node_modules/better-sqlite3/` (its `package.json`, `lib/` and
   `prebuilds/linux-x64.node`), `gazetteer-out/` (`data/gazetteer/out`), `config/` and `fixtures-synthetic/`
   (`fixtures/synthetic`). Check that no `.env`, SQLite file or `fixtures/raw` body is in it.
3. Copy the `runtime` stage of the `Dockerfile` into `Dockerfile.runtime` and point each `COPY --from=build` at those
   directories. Build it with `docker build --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim`
   (the mirror avoids Docker Hub's anonymous pull limit) and tag it `registry.fly.io/walkup-agent:<commit>-host`.
4. `fly auth docker`, `docker push <tag>`, then `fly deploy -a walkup-agent --image <tag>`.

| Symptom | Cause and fix |
|---|---|
| Build stops at `apps/web/.next/standalone/apps/web/server.js is missing` | `output: "standalone"` is not set in `apps/web/next.config.ts`. |
| `better-sqlite3` fails to load at runtime | It must stay a server external (Next lists it by default; `serverExternalPackages` in `apps/web/next.config.ts` lists it too) and `@walkup/qloo` must be imported from server code only. The image carries the Linux binary: `fly ssh console -a walkup-agent -C "ls /app/node_modules/better-sqlite3/prebuilds"` should show `linux-x64.node` (or check `build/Release/better_sqlite3.node` if the build compiled it). |
| Health check fails, logs show the server listening | The port must be 3000 (`PORT`, `internal_port`); the entrypoint sets `HOSTNAME=0.0.0.0`. |
| `EACCES` under `/data` | Files were copied in as root after the last start: `fly apps restart walkup-agent`. |
| Restarts with `Out of memory` in `fly logs` | `fly scale memory 2048 -a walkup-agent`. |
| Cards show `error` on every Qloo call | The key was deactivated but is still set. The run that saw it switches the server to recorded mode (fixture mode if no live sheet is stored); set `WALKUP_QLOO_UNTIL` or `WALKUP_MODE=recorded` so no visitor gets that run (see [Recorded mode](#recorded-mode-after-the-qloo-key-is-switched-off-nov-2-2026)). |
