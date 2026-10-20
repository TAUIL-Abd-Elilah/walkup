/**
 * The compact view of a finished sheet that the revise interpreter reads:
 * the show, the settings the tools can change, the areas on the sheet and the
 * place types (with how many of each the sheet holds). No partner names, no
 * ledger, no contact details.
 */
import type { LiftTile, StreetSheet } from "@walkup/contracts";
import { DEFAULT_BAR_CATEGORIES, LIFT_DEFAULTS } from "@walkup/engine";
import type { ReviseArea, ReviseCategory, ReviseSummary } from "@walkup/narrator";
import { DEFAULT_PARTNER_CATEGORIES, PREPOST_CATEGORIES, WIDEN_CATEGORIES } from "../tags";

/** The areas a sheet calls out: lift tiles at or above the lift floor, in card order (the low-lift contrast tiles are left out). */
export function sheetAreas(sheet: StreetSheet): LiftTile[] {
  return sheet.cards.liftMap.results.tiles.filter((t) => t.lift >= LIFT_DEFAULTS.minLift);
}

function agePolicy(legal: boolean | null): ReviseSummary["show"]["agePolicy"] {
  return legal === true ? "21+" : legal === false ? "all ages" : "not listed";
}

export function reviseSummary(sheet: StreetSheet): ReviseSummary {
  const partners = sheet.cards.partners.results;
  const spots = sheet.cards.prePost.results;

  const areas: ReviseArea[] = [];
  const byGh = new Map<string, ReviseArea>();
  const add = (geohash: string, name: string | null) => {
    if (byGh.has(geohash)) return;
    const a: ReviseArea = { name, geohash, partners: 0 };
    byGh.set(geohash, a);
    areas.push(a);
  };
  for (const t of sheetAreas(sheet)) add(t.geohash, t.name ?? null);
  for (const p of partners) if (p.tileGeohash) add(p.tileGeohash, p.tileName ?? null);
  for (const p of partners) {
    const a = p.tileGeohash ? byGh.get(p.tileGeohash) : undefined;
    if (a) a.partners++;
  }

  const counts = new Map<string, ReviseCategory>();
  const cat = (key: string) => {
    let c = counts.get(key);
    if (!c) {
      c = { key, partners: 0, spots: 0 };
      counts.set(key, c);
    }
    return c;
  };
  for (const p of partners) cat(p.category).partners++;
  for (const s of spots) if (s.category) cat(s.category).spots++;
  // The keys the run searches or can drop, even when none is on the sheet now.
  for (const k of [...DEFAULT_PARTNER_CATEGORIES, ...WIDEN_CATEGORIES, ...PREPOST_CATEGORIES, ...DEFAULT_BAR_CATEGORIES]) cat(k);
  counts.delete("other");

  const op = sheet.operator;
  return {
    show: {
      acts: sheet.bill.acts.map((a) => a.name),
      venue: sheet.bill.venue.name,
      city: sheet.bill.venue.city,
      date: sheet.bill.date,
      weekday: sheet.bill.weekday,
      agePolicy: agePolicy(sheet.bill.legalAgeEnforced),
    },
    settings: {
      allAges: op.allAges === true,
      streetTeamDays: [...op.streetTeamDays],
      radiusKm: op.radiusKm,
      excludeCategories: [...(op.excludeCategories ?? [])],
      excludeAreas: [...(op.excludeAreas ?? [])],
    },
    areas,
    categories: [...counts.values()],
    partners: partners.length,
    spots: spots.length,
  };
}
