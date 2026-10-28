/**
 * "Why lift" from the recorded runs (evals/llm-baseline/protocol.md, part 2; pure parts in why-lift-lib.ts).
 *
 *   npx tsx scripts/why-lift.ts [--plans deploy/vercel/plans.json]
 *
 * No Qloo call. For each live bill it reads the bill heatmap and the usual-crowd heatmap its sheet used (the
 * sheet's ledger gives the exact requests) from a copy of that run's private cache:
 *   .cache/llm-baseline/src/anthem/qloo-cache.sqlite    copied from .cache/record-2026-10-21j (The Anthem)
 *   .cache/llm-baseline/src/saltshed/qloo-cache.sqlite  copied from .cache/record-2026-10-21-chicago (The Salt Shed)
 * and writes only numbers to evals/llm-baseline/out/why-lift.json.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { HeatCell, LedgerEntry, StreetSheet } from "@walkup/contracts";
import { computeLiftAll } from "@walkup/engine";
import { annotateTile } from "@walkup/gazetteer";
import { canonicalKey, normalizeHeatmap } from "@walkup/qloo";
import { BASELINE_PLANS } from "./llm-baseline-lib";
import { billVsBill, joinTiles, rawVsHouse, round, sharedAreas, topLiftAreas, topRawAreas, type JoinedTile } from "./why-lift-lib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ROOMS = [
  { key: "anthem", venue: "The Anthem, Washington DC", cache: ".cache/llm-baseline/src/anthem/qloo-cache.sqlite", bills: ["giddens", "flo"] },
  { key: "saltshed", venue: "The Salt Shed, Chicago", cache: ".cache/llm-baseline/src/saltshed/qloo-cache.sqlite", bills: ["greensky", "roots"] },
] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The last request in the ledger whose note names this step, split-half maps left out. */
function heatEntry(ledger: readonly LedgerEntry[], step: "Q4 bill heat" | "Q5 house heat"): LedgerEntry {
  const hits = ledger.filter((e) => (e.note ?? "").includes(step) && !(e.note ?? "").includes("split-half"));
  const last = hits[hits.length - 1];
  if (!last) throw new Error(`no "${step}" request in the ledger`);
  return last;
}

function cellsFor(db: Database.Database, e: LedgerEntry): HeatCell[] {
  const key = canonicalKey({ method: "GET", path: e.endpoint, params: e.params as Record<string, string | number | boolean | string[]> });
  const row = db.prepare<[string], { body: string }>("SELECT body FROM responses WHERE key = ?").get(key);
  if (!row) throw new Error(`not in the recorded cache: ${key.slice(0, 120)}...`);
  return normalizeHeatmap(JSON.parse(row.body) as unknown).value;
}

interface BillHeat {
  key: string;
  radiusM: number;
  tiles: JoinedTile[];
  sheet: StreetSheet;
  liftCheckMaxDiff: number | null;
}

function main(): void {
  const plansPath = resolve(ROOT, arg("--plans") ?? "deploy/vercel/plans.json");
  const plans = JSON.parse(readFileSync(plansPath, "utf8")) as Array<{ planId: string; sheet?: StreetSheet }>;
  const annotate = (t: { lat: number; lon: number }) => {
    const a = annotateTile({ lat: t.lat, lon: t.lon });
    return { zctas: a.zctas ?? [], adultPopulation: a.adultPopulation ?? null };
  };
  const rooms = [];
  for (const room of ROOMS) {
    const db = new Database(join(ROOT, room.cache), { readonly: true, fileMustExist: true });
    const heats: BillHeat[] = [];
    try {
      for (const billKey of room.bills) {
        const planId = BASELINE_PLANS.find((p) => p.key === billKey)!.planId;
        const sheet = plans.find((p) => p.planId === planId)?.sheet;
        if (!sheet) throw new Error(`plan ${planId} not in ${plansPath}`);
        const be = heatEntry(sheet.ledger, "Q4 bill heat");
        const he = heatEntry(sheet.ledger, "Q5 house heat");
        const bill = cellsFor(db, be);
        const house = cellsFor(db, he);
        // Check these are the maps the sheet used: recomputed lift on the sheet's tiles must match.
        const lift = new Map(computeLiftAll(bill, house).map((t) => [t.geohash, t.lift]));
        let maxDiff: number | null = null;
        for (const t of sheet.cards.liftMap.results.tiles) {
          const l = lift.get(t.geohash);
          if (l === undefined) continue;
          maxDiff = Math.max(maxDiff ?? 0, Math.abs(l - t.lift));
        }
        heats.push({ key: billKey, radiusM: Number(be.params["filter.location.radius"]), tiles: joinTiles(bill, house), sheet, liftCheckMaxDiff: maxDiff });
      }
    } finally {
      db.close();
    }
    const [a, b] = heats as [BillHeat, BillHeat];
    const rawA = topRawAreas(a.tiles, annotate);
    const rawB = topRawAreas(b.tiles, annotate);
    const liftA = topLiftAreas(a.sheet.cards.liftMap.results.tiles);
    const liftB = topLiftAreas(b.sheet.cards.liftMap.results.tiles);
    // The same counts on the 40 km circle both runs searched first (FLO's maps were widened to 60 km).
    const within = (tiles: JoinedTile[]) => {
      const v = a.sheet.bill.venue;
      return tiles.filter((t) => Math.hypot((t.lat - v.lat) * 111.32, (t.lon - v.lon) * 111.32 * Math.cos((v.lat * Math.PI) / 180)) <= 40);
    };
    const raw40 = sharedAreas(topRawAreas(within(a.tiles), annotate), topRawAreas(within(b.tiles), annotate));
    for (const [label, list] of [
      [`${a.key} raw`, rawA],
      [`${b.key} raw`, rawB],
    ] as const) {
      console.log(`${label}: ${list.map((t) => annotateTile({ lat: t.lat, lon: t.lon }).name ?? t.geohash).join(", ")}`);
    }
    console.log(`${a.key} lift: ${liftA.map((t) => t.name ?? t.geohash).join(", ")}`);
    console.log(`${b.key} lift: ${liftB.map((t) => t.name ?? t.geohash).join(", ")}`);
    rooms.push({
      room: room.key,
      venue: room.venue,
      bills: heats.map((h) => ({
        bill: h.key,
        radiusKm: h.radiusM / 1000,
        joinedTiles: h.tiles.length,
        rawVsUsualCrowd: { rho: round(rawVsHouse(h.tiles).rho, 4), n: rawVsHouse(h.tiles).n },
        liftRecomputeMaxDiff: round(h.liftCheckMaxDiff, 6),
      })),
      top5: {
        raw: { ...sharedAreas(rawA, rawB), of: Math.min(rawA.length, rawB.length) },
        lift: { ...sharedAreas(liftA, liftB), of: Math.min(liftA.length, liftB.length) },
        rawWithin40km: raw40,
      },
      billVsBillRaw: (() => {
        const r = billVsBill(a.tiles, b.tiles);
        return { rho: round(r.rho, 4), n: r.n };
      })(),
    });
  }
  const out = {
    protocol: "evals/llm-baseline/protocol.md, part 2",
    protocolSha256: createHash("sha256").update(readFileSync(join(ROOT, "evals/llm-baseline/protocol.md"))).digest("hex"),
    computedAt: new Date().toISOString(),
    qlooCalls: 0,
    rooms,
  };
  const file = join(ROOT, "evals/llm-baseline/out/why-lift.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(rooms, null, 2));
}

main();
