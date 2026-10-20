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
fly launch --no-deploy --copy-config --name walkup --region iad --org personal
```

- Fly app names are global. If `walkup` is taken, pick another name; `fly launch` writes it into `app` in
  `fly.toml`, and every `-a walkup` below changes with it.
- Decline the database, Redis and object-storage offers.
- Run `git diff fly.toml` afterwards. `fly launch` can rewrite settings; keep `auto_stop_machines = "off"`,
  `min_machines_running = 1`, the `[[mounts]]` block and the `/healthz` check.
- Non-interactive alternative: `fly apps create walkup --org personal`.

```bash
# 2. The volume: 1 GB, daily snapshots kept for 14 days. One volume means one machine.
fly volumes create walkup_data --region iad --size 1 --snapshot-retention 14 --yes -a walkup
```

```bash
# 3. Secrets, staged so the first deploy applies them all at once.
#    The leading space keeps the line out of bash history when HISTCONTROL includes ignorespace.
 fly secrets set --stage -a walkup \
  QLOO_API_KEY=... \
  TICKETMASTER_API_KEY=... \
  GOOGLE_PLACES_API_KEY=... \
  CENSUS_API_KEY=... \
  ANTHROPIC_API_KEY=... \
  RESEND_API_KEY=... \
  RESEND_FROM='Walkup <street-sheets@your-verified-domain.example>' \
  WALKUP_SIGNING_SECRET="$(openssl rand -hex 32)" \
  WALKUP_POSTAL_ADDRESS='Street address, City, ST 00000'
```

The last two are read by `@walkup/send` and are not in `.env.example` yet (see
[Variables the send step reads](#variables-the-send-step-reads)). Without the postal address every real send is
refused.

To keep keys off the command line entirely, write `NAME=value` lines to a file outside the repository, run
`fly secrets import --stage -a walkup < that-file`, then delete the file.

```bash
# 4. Deploy. Fly's remote builder builds the image; nothing is built or pushed from this machine.
fly deploy -a walkup --ha=false
```

```bash
# 5. Check.
fly status -a walkup
fly volumes list -a walkup
curl -s https://walkup.fly.dev/healthz
fly logs -a walkup
```

`/healthz` answers `{"ok":true,"mode":...,"configured":{...}}`. `configured` shows which keys are present, never their
values. Until the web app is connected to the engine, `mode` stays `"fixture"` even with every key set.

The image is built without secrets, so the mode pill and the layout watermark on pages that `next build` prerenders
(the landing page and the preset sheets) show what the build saw ("No keys configured"), not the machine's secrets.
`/healthz` is rendered per request and is the one to trust. Request 8 in
The web app reads the mode per request.

### Every variable in `.env.example`

| Variable | Set on the host as | Value or note |
|---|---|---|
| `QLOO_API_KEY` | secret | Unset it when the key is deactivated (see [Fixture mode](#fixture-mode-after-the-qloo-key-is-deactivated)). |
| `QLOO_BASE_URL` | `fly.toml` `[env]` | `https://hackathon.api.qloo.com`. Any other host is refused. |
| `TICKETMASTER_API_KEY` | secret | |
| `GOOGLE_PLACES_API_KEY` | secret | Also set a 300 requests/day quota on the Google Cloud project. |
| `CENSUS_API_KEY` | secret | Optional: the gazetteer already carries adult counts. |
| `ANTHROPIC_API_KEY` | secret | Without it, narration uses the labelled template. |
| `RESEND_API_KEY` | secret | |
| `RESEND_FROM` | secret | A sender on a domain verified in Resend. Not sensitive, but set per deployment. |
| `WALKUP_DATA_DIR` | `fly.toml` `[env]` and the image | `/data` (the volume). |
| `WALKUP_MODE` | `fly.toml` `[env]` and the image | `auto`: live while `QLOO_API_KEY` is set, fixture replay once it is unset. |
| `QLOO_MONTH_GUARD_FLOOR` | `fly.toml` `[env]` | `1500`: fresh Qloo calls stop below 1,500 calls left this month. |
| `WALKUP_RECORD` | secret, only while recording | `1` writes Qloo bodies to `/data/fixtures/raw`. Unset it afterwards. |
| `WALKUP_FIXTURES_DIR` | `fly.toml` `[env]` and the image | `/data/fixtures` (`raw/` recorded on the volume, `synthetic/` from the image). |
| `WALKUP_GAZETTEER_DIR` | `fly.toml` `[env]` and the image | `/app/data/gazetteer/out`. |
| `WALKUP_TAGS_FILE` | `fly.toml` `[env]` and the image | `/app/config/tags.json`: the pinned Qloo tag URNs the orchestrator reads. |
| `WALKUP_FRESH_RUNS_PER_IP`, `WALKUP_FRESH_RUNS_PER_DAY` | optional, `fly.toml` `[env]` | Fresh live runs per network and in total per UTC day; defaults 3 and 15. |
| `WALKUP_PLAN_STORE` | not on the host | `memory` keeps plans in memory (tests); the host uses `/data/plans.sqlite`. |
| `QLOO_ALLOW_HOST` | never | Local mock servers only. |
| `WALKUP_URL` | not on the host | For the agent skill CLI on a user's machine: `https://walkup.fly.dev`. |

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
  (`fly scale count 1 -a walkup`): a second one would need its own volume and would split the cache and quota
  files.
- **UptimeRobot, every 5 minutes.** Add a monitor of type *Keyword*, URL `https://walkup.fly.dev/healthz`,
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
- **After Dec 31 2026**, the owner chooses: keep it running; stop compute with `fly scale count 0 -a walkup`
  (the volume is still billed); or download what is worth keeping and run `fly apps destroy walkup`, which
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

With 1 GB RAM (`fly scale memory 1024 -a walkup`) the total is about $6-7. Watch `fly logs` for out-of-memory
restarts, especially during PDF exports, and go back to 2 GB if they appear.

### Cost caps

| Service | Cap | Where it is enforced |
|---|---|---|
| Fly | about $15/month | Configuration: one machine of a fixed size, no autoscaling. |
| Qloo | stop fresh calls below 1,500 left this month; fresh runs capped per IP and per day | `QLOO_MONTH_GUARD_FLOOR` in `packages/qloo`; the per-IP and daily caps in the web app. Cached answers are still served. |
| Anthropic | $5/day | The narrator's spend guard; the spend file lives on the volume. Above the cap narration uses the labelled template. |
| Google Places | 300 requests/day | The client's daily cap, plus a quota on the Google Cloud project as a backstop. |
| Resend | free tier, 100/day; 10 confirmed sends per requester per day | Resend's plan; `WALKUP_SEND_DAILY_CAP` in `packages/send`. Every send needs a human confirm in the app. |

## Fixture mode after the Qloo key is deactivated

How the mode is chosen today: with `WALKUP_MODE=auto`, the app is live while `QLOO_API_KEY` is set and in
fixture mode when it is not. In fixture mode the Qloo client never calls Qloo. It reads
`/data/fixtures/raw/<sha256>.json` first, then `/data/fixtures/synthetic/`, and reports a request that was never
recorded as a missing fixture (`QlooFixtureMissingError`) instead of calling Qloo. The plan runner is required to show
that as a `degraded` card, not an error page, to mark every sheet produced this way `mode: "fixture"` with the fixture
watermark, and to disable fresh runs with an explanation (the web app already answers fresh runs with 503 in fixture
mode).

1. **Before the key goes away, record.** Run each preset plan that has a live show once in live mode with recording on
   (g1-a and g1-b once key day fills their `live` blocks; a preset without one stops with "This preset has no live show
   yet." and records nothing). On the host:

   ```bash
   fly secrets set WALKUP_RECORD=1 -a walkup      # restarts the machine
   # run each preset plan once in the hosted app
   fly secrets unset WALKUP_RECORD -a walkup
   fly ssh console -a walkup -C "sh -c 'ls /data/fixtures/raw | wc -l'"
   ```

   Bodies recorded on the host go straight to `/data/fixtures/raw` and never touch a laptop or git. Bodies recorded
   locally are copied up as described in the next section.
2. **Snapshot the volume.**

   ```bash
   fly volumes list -a walkup                           # note the volume id
   fly volumes snapshots create <volume-id> -a walkup
   ```

3. **Switch.** The day the key is deactivated (or the day before):

   ```bash
   fly secrets unset QLOO_API_KEY -a walkup             # restarts; auto now resolves to fixture
   ```

   Equivalent: set `WALKUP_MODE = "fixture"` in `fly.toml` and run `fly deploy`.
4. **Check.** `curl -s https://walkup.fly.dev/healthz` shows `"mode":"fixture"` and `"qloo":false`. Open each
   preset plan and confirm the fixture watermark and the recorded date.

A deactivated key that is still set looks like live mode to the app: every Qloo call fails and the cards show
`error`. Until the app detects a rejected key on its own (request 5 in
the deploy notes above), unset the key the same day.

## Copying recorded fixtures onto the volume

Recorded fixtures are Qloo response bodies. They stay out of git (`fixtures/raw/` is git-ignored and
`scripts/check-no-raw.mjs` refuses them in the pre-commit hook) and out of the image (`.dockerignore`). On the host
they live only on the volume.

From the repository root, on the machine that holds them:

```bash
ls fixtures/raw | wc -l
tar -czf "$HOME/walkup-raw.tgz" -C fixtures/raw .       # the archive goes outside the repository
fly ssh sftp shell -a walkup
```

In the sftp shell (`put` takes an absolute local path; on Windows, for example `C:/Users/you/walkup-raw.tgz`):

```
put /home/you/walkup-raw.tgz /data/walkup-raw.tgz
```

Leave the shell with Ctrl-D, then unpack, hand the files to `node` and count them:

```bash
fly ssh console -a walkup -C "sh -c 'tar -xzf /data/walkup-raw.tgz -C /data/fixtures/raw && rm /data/walkup-raw.tgz && chown -R node:node /data/fixtures && ls /data/fixtures/raw | wc -l'"
rm "$HOME/walkup-raw.tgz"
```

The count on the host should match the local count. A single file works the same way:
`put /abs/path/fixtures/raw/<sha256>.json /data/fixtures/raw/<sha256>.json`. If `put` refuses to overwrite an
existing file, remove it first with `fly ssh console -C "rm /data/<file>"`. Anything else the app keeps under `/data`
(for example stored plans) copies the same way.

To take a copy off the host (keep it outside the repository):

```bash
fly ssh console -a walkup -C "sh -c 'tar -czf /tmp/walkup-data.tgz -C /data fixtures/raw'"
fly ssh sftp get /tmp/walkup-data.tgz "$HOME/walkup-data.tgz" -a walkup
```

## Deploys and restarts

- `fly deploy` rebuilds the image and updates the machine in place (same machine, same volume). The health check on
  `GET /healthz` has to pass within 30 seconds of start. If it does not, `fly deploy` reports the failure;
  `fly releases -a walkup --image` lists earlier images and `fly deploy -a walkup --image <image>` goes back
  to one.
- On `SIGTERM` the Next.js server exits at once, so a plan run in progress stops and has to be run again.
- `fly apps restart walkup` re-runs the entrypoint, which re-owns `/data` for `node`.

## Security notes

- Keys exist only as Fly secrets. `/healthz` reports presence only; ledger entries and copy-as-curl show
  `$QLOO_API_KEY`, never the value.
- `fly ssh console` is root on the machine. Keep the Fly organization to the people who operate the app.
- The server process runs as `node`. Only the entrypoint runs as root, to prepare `/data`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Build stops at `apps/web/.next/standalone/apps/web/server.js is missing` | `output: "standalone"` is not set in `apps/web/next.config.ts`. |
| `better-sqlite3` fails to load at runtime | It must stay a server external (Next lists it by default; request 1 lists it explicitly) and `@walkup/qloo` must be imported from server code only. The image carries the Linux binary: `fly ssh console -a walkup -C "ls /app/node_modules/better-sqlite3/prebuilds"` should show `linux-x64.node` (or check `build/Release/better_sqlite3.node` if the build compiled it). |
| Health check fails, logs show the server listening | The port must be 3000 (`PORT`, `internal_port`); the entrypoint sets `HOSTNAME=0.0.0.0`. |
| `EACCES` under `/data` | Files were copied in as root after the last start: `fly apps restart walkup`. |
| Restarts with `Out of memory` in `fly logs` | `fly scale memory 2048 -a walkup`. |
| Cards show `error` on every Qloo call | The key was deactivated but is still set: `fly secrets unset QLOO_API_KEY -a walkup`. |
