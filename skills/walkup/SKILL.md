---
name: walkup
description: Plan where to sell one booked live show's remaining seats. Give it a Ticketmaster event URL or "Artist @ Venue, Date"; a Walkup server compares this bill's crowd with the venue's usual crowd using Qloo taste data and returns a Street Sheet - the neighbourhoods where this crowd over-indexes, 15-25 real local partner places for ticket drops and posters (bars, cafes, book stores, barbershops), pre/post-show spots, podcasts, one sponsor brand and copy hooks - as a share link plus a JSON envelope with numbered receipts. Use when a promoter, venue marketer or street-team lead asks where to promote a specific show, which local businesses to approach, or in what order to call their own partner list. Not for choosing cities, rooms or supporting acts, not for pricing, and never about individual fans.
license: MIT
compatibility: Needs network access to a Walkup server (WALKUP_URL). Uses curl, or Node 22+ for the bundled CLI in scripts/.
metadata: {"openclaw": {"requires": {"env": ["WALKUP_URL"], "bins": ["curl"]}}}
---

# Walkup

Walkup plans the last weeks of local promotion for **one show that is already booked and still has seats to sell**. It finds where this bill's crowd differs from the crowd the venue already reaches, ranks the real local places that crowd already loves, and returns a one-page Street Sheet. Every place and number on the sheet carries a receipt (`[Q9]`) that points to the Qloo request that produced it.

This skill is a thin client. The Walkup server holds every API key and does all the work; the skill sends only what you type.

## Setup

Set `WALKUP_URL` to a Walkup server: the hosted instance, or your own (`npm run dev` in the repository serves `http://localhost:3000`). In OpenClaw you can set it per skill under `skills.entries.walkup.env`. The bundled CLI falls back to `http://localhost:3000` when the variable is empty.

No API key is needed or accepted. Self-hosters set `QLOO_API_KEY` and the other keys on the server only.

## Quick start

With the bundled CLI (Node 22+):

```bash
node {baseDir}/scripts/walkup.mjs plan "https://www.ticketmaster.com/event/<event-id>"
node {baseDir}/scripts/walkup.mjs plan "Artist @ Venue, Jan 16 2027" --street-days thu,sat --seats-left 900
node {baseDir}/scripts/walkup.mjs rank-partners "<event>" "Partner One" "Partner Two"
node {baseDir}/scripts/walkup.mjs sheet <plan-id> --pdf
```

With curl:

```bash
curl -sS -X POST "$WALKUP_URL/api/plan" \
  -H 'content-type: application/json' \
  -d '{"event":"Artist @ Venue, Jan 16 2027","operator":{"streetTeamDays":["thursday","saturday"]}}'

curl -sS -X POST "$WALKUP_URL/api/rank-partners" \
  -H 'content-type: application/json' \
  -d '{"event":"<event>","partners":["Partner One","Partner Two"]}'

curl -sS "$WALKUP_URL/api/sheet/<plan-id>"
curl -sS -o street-sheet.pdf "$WALKUP_URL/api/sheet/<plan-id>/pdf"

# Change a finished sheet in plain words; the answer has the new plan id (or one question back)
curl -sS -X POST "$WALKUP_URL/api/plan/<plan-id>/revise"   -H 'content-type: application/json'   -d '{"instruction":"All ages, no bars","wait":"complete"}'
```

A revision makes a new sheet under a new plan id and lists what changed (`revision.changes`); the earlier sheet stays as it was. It understands all ages, place types to leave out, areas to skip, street-team days and the radius. When the note is unclear it answers `status: "needs_input"` with a `question` and changes nothing. There is no CLI subcommand for it yet: use curl or the MCP tool.

## Subcommands

| Command | What it does | Server endpoint |
|---|---|---|
| `plan <ticketmaster-event-url \| "Artist @ Venue, Date">` | Builds a Street Sheet for the show. A fresh run makes 15 to 30 Qloo calls, so give it time. Options: `--seats-left`, `--capacity`, `--radius-km` (default 40), `--street-days`, `--pick "<input>=<id>"` | `POST /api/plan` |
| `rank-partners <event> <partner names...>` | Ranks the user's own partner list (up to 20 names) by this bill's crowd. Names not in Qloo's catalog come back unranked ("not in Qloo's catalog, kept in your order") | `POST /api/rank-partners` |
| `sheet <plan-id>` | Fetches an existing sheet's summary. `--pdf` saves the one-page PDF (`--out <file>` to choose where) | `GET /api/sheet/<plan-id>`, `GET /api/sheet/<plan-id>/pdf` |
| `health` | Server mode (live or fixture) and reachability | `GET /healthz` |

Add `--json` to print the server's envelope unchanged.

## MCP

The same server serves these operations as MCP tools at `$WALKUP_URL/mcp` (Streamable HTTP, stateless, no key): `plan_show`, `rank_partners`, `bill_vs_house`, `get_sheet` and `revise_plan` (`{planId, instruction}`). They return the same envelope as the REST routes and follow the same caps and refusals.

```bash
claude mcp add --transport http walkup "$WALKUP_URL/mcp"
```

## Before running it, check

1. **Is the show already on sale, with a fixed date and room?** If the user is still choosing cities, rooms or supporting acts, this is the wrong skill.
2. **Which days does the street team work?** Pass them with `--street-days`; partner hours are checked against those days.
3. **Does the user have their own partner list?** Use `rank-partners` for call order.
4. **Seat counts are what-ifs.** Pass them only if the user offers them. Never ask for, or pass, sales data or buyer data.

## Reading the result

The server returns one envelope: `status`, `summary`, `planId`, `sheetUrl`, `mode` (`live` or `fixture`), `results` (the Street Sheet: cards, ledger, guard report), `resolution`, `provenance`, `limits`.

- Each card has its own status: `ok`, `empty`, `needs_input`, `partial`, `degraded` or `error`. Relay the reason for anything that isn't `ok`.
- Cite places and numbers exactly as returned, with their receipt (`[Q9]`). Do not add places, rankings or numbers of your own.
- Partners are **suggested, not affiliated**: no business has agreed to anything.
- Always pass on the `limits` lines ("What this does not establish").
- If `mode` is `fixture`, say the data is sample data (synthetic), not live.

## What this sends

> Event ID or artist/venue/date text and any partner names you type. Nothing about you, your contacts or ticket buyers. No Qloo key leaves our server.

In full: the event text or URL, partner names, any what-if numbers you pass (seats left, capacity, radius, street-team days), candidate picks, and a `walkup-skill/<version>` user agent. No cookies, no environment variables, no API keys. The CLI refuses arguments that contain an email address.

## NEVER do

- **Never send emails or messages** on the user's behalf. Sending the sheet happens only in the Walkup web app, after the user confirms the recipients.
- **Never pass personal data**: fan or buyer names, email addresses, phone numbers, ticketing exports or customer lists.
- **Never put an API key** in `WALKUP_URL`, in arguments or in this skill.
- **Never describe a real show as "soft"**, "tracking" or selling badly. Counts are what-ifs.
- **Never present a partner as affiliated** or as having agreed to anything.
- **Never invent** places, IDs, ranks or numbers that aren't in the result.
- **Never infer** ethnicity, religion, politics, health or sexuality from a result, and never describe where a group of people lives. Lift tiles are where this bill's fans over-index, not buyers' homes.
- **Never treat affinity as purchase intent** or the sheet as a sales forecast.
- **Never use it for political candidates or campaigns**; the server refuses them.

## Common errors

| Error (CLI exit code) | Cause | Fix |
|---|---|---|
| `needs_input` (3) | An act, venue or partner name matches more than one entity (often a one-word name) | Show the candidates to the user. For `plan`, re-run with the `--pick "<input>=<id>"` they choose; for `rank-partners`, retype the name more specifically or pick in the web app. Never pick for them |
| `server unreachable` (4) | `WALKUP_URL` is wrong or the server is down | Check the URL. For a local server run `npm run dev` in the repository |
| `limit reached` (5, HTTP 429) | Fresh runs are capped per IP and per day, or the server's monthly Qloo quota guard is on | Use a cached preset in the web app, or try again tomorrow |
| `fixture mode` (6, HTTP 503) | The server has no live Qloo key (or it was deactivated) | Sample presets still open; fresh runs are disabled |
| `partial` / `degraded` card (0) | Thin signal, a new venue not yet in the catalog, generic compare results | Relay the card's reason; treat the list as a starting point |
| `empty` card (0) | Nothing survived the filters (for example, no sponsor on an all-ages show) | Say so; don't fill the gap |
| `Not found (HTTP 404)` (1) | Unknown plan id, or the URL is not a Walkup server | Check the plan id and `WALKUP_URL` |
| `not JSON` (1) | `WALKUP_URL` points at something else | Point it at a Walkup server |
| Email refused (2) | An argument contained an email address | Remove it; contacts are added only in the web app's confirm dialog |
| `cannot be used with` (2) | An option that the command does not use (for example `--pick` on `rank-partners`, `--out` without `--pdf`) | Drop the option; nothing was sent |

## Coverage map

| Area | Coverage | What you'll see |
|---|---|---|
| Music bills in large US metros | Densest signal | Full sheet, usually `ok` |
| Comedy bills | Thinner; one-word stage names collide | `needs_input` pickers, proxy seeds shown in receipts, `partial` badges |
| Venues that opened recently | Often not in the catalog yet | The Ticketmaster coordinates are used; "venue not in catalog yet" |
| Smaller metros | Fewer heatmap cells and places | Radius widens to 60 km; "thin signal: treat as a starting list" |
| Partner categories | Bars, pubs, restaurants, cafes, book stores, clothing stores, barber shops and beauty salons (the categories pinned in `config/tags.json`; record stores could not be pinned) | Categories come from pinned tags only |
| Podcasts | Ranked by this bill's crowd | Labelled "national, not local" unless location is shown to move the ranking |
| Sponsors | One local brand | Alcohol, tobacco and gambling excluded on all-ages shows |
| The user's own partners | Up to 20 names | Not in the catalog: "not in Qloo's catalog, kept in your order" |
| Outside the US | Not covered yet | Neighbourhood names and adult counts come from US Census data |
| Political candidates and campaigns | Refused | Error |

## Every action is on the ledger

Each request the server makes gets a numbered receipt (`Q1`... for Qloo, `T1` Ticketmaster, `L1` LLM, `A1` actions) with its parameters (keys redacted) and a copy-as-curl. The ledger ships inside the sheet's JSON.
