/**
 * Key-day room tool. Finds one room on Ticketmaster Discovery, prints its
 * house roster (the next 60 events from the as-of date, as a plan reads them),
 * applies the hero selection rule to a window with every candidate and the
 * reason for each pick, and checks that both picks can be planned. With
 * --write-probe it writes the room's point and roster Spotify ids into
 * scripts/probe.config.json. Ticketmaster only: no Qloo call.
 *
 *   npm run tm:room -- --name="The Truth" --city=Nashville --state=TN
 *   npm run tm:room -- --venue-id=<id> --write-probe
 *
 * Flags: --name, --city, --state (city and state are required with --name), --venue-id (skips the
 *        search), --as-of=YYYY-MM-DD (default today, UTC), --window=FROM:TO (default the hero window),
 *        --probe-key=KEY (default the-truth), --write-probe, --config=<path>, --save, --json, --help
 * Env:   TICKETMASTER_API_KEY. A .env at the repo root is loaded. The key is sent only as Discovery's
 *        apikey parameter and is never printed or written.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HERO_WINDOW } from "@walkup/orchestrator";
import { createTmClient, TmError } from "@walkup/tm";
import { loadConfig } from "./lib/probe/config.js";
import { findVenue, renderReport, reportJson, rewriteProbeConfig, roomReport, type VenueRow, type Window } from "./lib/tm-room.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

interface Args {
  name: string | null;
  city: string | null;
  state: string | null;
  venueId: string | null;
  asOf: string;
  window: Window;
  probeKey: string;
  writeProbe: boolean;
  config: string;
  save: boolean;
  json: boolean;
  help: boolean;
}

const VALUE_FLAGS = new Set(["--name", "--city", "--state", "--venue-id", "--as-of", "--window", "--probe-key", "--config"]);

function isDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

export function parseArgs(argv: readonly string[], today: string): Args {
  const args: Args = {
    name: null,
    city: null,
    state: null,
    venueId: null,
    asOf: today,
    window: { from: HERO_WINDOW.from, to: HERO_WINDOW.to },
    probeKey: "the-truth",
    writeProbe: false,
    config: resolve(HERE, "probe.config.json"),
    save: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const eq = a.indexOf("=");
    const flag = eq >= 0 ? a.slice(0, eq) : a;
    let value = eq >= 0 ? a.slice(eq + 1) : undefined;
    // Value flags also take the next argument: --name "The Truth".
    if (value === undefined && VALUE_FLAGS.has(flag)) value = argv[++i];
    const need = (): string => {
      const v = (value ?? "").trim();
      if (!v) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--name":
        args.name = need();
        break;
      case "--city":
        args.city = need();
        break;
      case "--state": {
        const v = need().toUpperCase();
        if (!/^[A-Z]{2}$/.test(v)) throw new Error("--state is a two-letter code, e.g. --state=TN");
        args.state = v;
        break;
      }
      case "--venue-id":
        args.venueId = need();
        break;
      case "--as-of": {
        const v = need();
        if (!isDate(v)) throw new Error("--as-of is a date, YYYY-MM-DD");
        args.asOf = v;
        break;
      }
      case "--window": {
        const [from, to, ...rest] = need().split(":");
        if (!from || !to || rest.length > 0 || !isDate(from) || !isDate(to) || from > to) throw new Error("--window is FROM:TO, two dates YYYY-MM-DD with FROM first");
        args.window = { from, to };
        break;
      }
      case "--probe-key": {
        const v = need();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) throw new Error("--probe-key is lowercase letters, digits and dashes, e.g. the-truth");
        args.probeKey = v;
        break;
      }
      case "--config":
        args.config = resolve(need());
        break;
      case "--write-probe":
        args.writeProbe = true;
        break;
      case "--save":
        args.save = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument "${a}" (see --help)`);
    }
  }
  if (args.help) return args;
  if (!args.venueId && !args.name) throw new Error("give --name (with --city and --state), or --venue-id");
  if (args.name && !args.venueId && (!args.city || !args.state)) throw new Error("--name needs --city and --state");
  return args;
}

function usage(): string {
  return [
    'usage: npm run tm:room -- --name="<room>" --city=<city> --state=<XX> [--as-of=YYYY-MM-DD] [--window=FROM:TO]',
    "       npm run tm:room -- --venue-id=<id> [...]",
    "       [--write-probe] [--probe-key=the-truth] [--config=path] [--save] [--json]",
    "",
    `Default window: ${HERO_WINDOW.from}:${HERO_WINDOW.to} (the hero rule). Default as-of date: today (UTC).`,
    "--write-probe writes venues.<probe-key> (point and source) and roster (Spotify ids) in scripts/probe.config.json.",
    "--save writes the Ticketmaster bodies to probe_out/ (git-ignored). Nothing else is written.",
    "Exit codes: 0 done (warnings included), 2 usage, config or venue-choice error, 3 Ticketmaster refused or failed.",
  ].join("\n");
}

function loadDotEnv(): void {
  const p = resolve(ROOT, ".env");
  if (!existsSync(p)) return;
  try {
    process.loadEnvFile(p);
  } catch {
    console.error("warning: could not read .env; using the process environment only");
  }
}

function venueLine(v: VenueRow): string {
  return [v.id, v.name, [v.city, v.state].filter(Boolean).join(", "), v.address ?? "-", v.url ?? "-"].join("  ");
}

async function main(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2), today);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(usage());
    return 2;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }

  loadDotEnv();
  const apiKey = (process.env.TICKETMASTER_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("TICKETMASTER_API_KEY is not set. Put it in .env or the environment.");
    return 2;
  }
  const tm = createTmClient({ apiKey });
  // With --json, stdout holds only the JSON; everything else goes to stderr.
  const info = args.json ? (line: string) => console.error(line) : (line: string) => console.log(line);

  try {
    let venue: VenueRow | null = null;
    let venueId: string;
    let venueQuery: string;
    if (args.venueId) {
      venueId = args.venueId;
      venueQuery = `events.json venueId=${venueId} (the venue on the room's events)`;
    } else {
      const found = await findVenue(tm, { name: args.name as string, city: args.city as string, state: args.state as string });
      if (found.kind === "choose") {
        console.error(found.reason);
        if (found.candidates.length > 0) console.error(["Candidates (id, name, city, address, url):", ...found.candidates.map((v) => `  ${venueLine(v)}`)].join("\n"));
        return 2;
      }
      venue = found.venue;
      venueId = venue.id;
      venueQuery = found.query;
    }

    const report = await roomReport(tm, { venue, venueId, venueQuery, asOf: args.asOf, window: args.window });
    if (args.json) console.log(JSON.stringify(reportJson(report), null, 2));
    else for (const line of renderReport(report)) console.log(line);

    if (args.save) {
      const dir = resolve(ROOT, "probe_out", `tm-room-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "roster.json"), `${JSON.stringify(report.roster.events, null, 2)}\n`, "utf8");
      writeFileSync(join(dir, "window.json"), `${JSON.stringify(report.window.events, null, 2)}\n`, "utf8");
      info(`Saved the Ticketmaster bodies to ${relative(ROOT, dir)} (git-ignored).`);
    }

    if (args.writeProbe) {
      const before = readFileSync(args.config, "utf8");
      let rewritten: ReturnType<typeof rewriteProbeConfig>;
      try {
        rewritten = rewriteProbeConfig(before, {
          key: args.probeKey,
          venue: report.venue,
          venueQuery,
          spotifyIds: report.roster.spotifyIds,
          rosterCount: report.roster.events.length,
          asOf: args.asOf,
          retrieved: today,
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        return 2;
      }
      writeFileSync(args.config, rewritten.text, "utf8");
      try {
        loadConfig(args.config);
      } catch (err) {
        writeFileSync(args.config, before, "utf8");
        console.error(`${err instanceof Error ? err.message : String(err)}\nThe previous config was put back.`);
        return 2;
      }
      info("");
      info(`Wrote venues.${args.probeKey} and roster (${report.roster.spotifyIds.length} Spotify ids) to ${relative(ROOT, args.config)}.`);
      for (const n of rewritten.notes) info(n);
      info("Next: npm run probe -- --only=2");
    }

    const used = (await tm.usage()).used;
    info(`Ticketmaster requests: ${used}.`);
    return 0;
  } catch (err) {
    if (err instanceof TmError) {
      console.error(err.message);
      return 3;
    }
    throw err;
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
