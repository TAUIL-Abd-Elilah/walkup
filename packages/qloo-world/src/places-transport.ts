/**
 * Google Places (New) Text Search side of the fixture world:
 * POST /v1/places:searchText. Results come from the same invented businesses
 * Qloo knows, ranked the way a text search ranks (query match, rating, review
 * count, distance), not by taste. Bodies carry "synthetic": true.
 */
import { jsonResponse, bodyText, type FetchLike } from "./http";
import { haversineKm } from "./geo";
import { placesWithin, type WorldPlace } from "./places-gen";
import type { WorldContext } from "./qloo-transport";
import { round, unit } from "./rng";

const KEYWORDS: [RegExp, string[]][] = [
  [/\b(record|records|vinyl)\b/i, ["record_store"]],
  [/\b(book|books|bookstore|bookshop)\b/i, ["book_store"]],
  [/\b(coffee|cafe|café|espresso)\b/i, ["cafe"]],
  [/\bsoul food\b/i, ["soul_food"]],
  [/\b(bar|bars|pub|pubs|tavern|lounge|taproom)\b/i, ["bar", "pub", "sports_bar"]],
  [/\b(barber|barbers|barbershop|barbershops)\b/i, ["barber_shop"]],
  [/\b(salon|salons|beauty|hair)\b/i, ["beauty_salon"]],
  [/\b(clothing|boutique|apparel|vintage|fashion)\b/i, ["clothing_store"]],
  [/\b(restaurant|restaurants|food|diner|kitchen|eatery|dinner|lunch)\b/i, ["restaurant", "soul_food"]],
  [/\b(bakery|bakeries|pastry)\b/i, ["bakery"]],
  [/\b(nightclub|night club|club|clubs|dance)\b/i, ["night_club"]],
];

const GOOGLE_TYPES: Record<string, string[]> = {
  restaurant: ["restaurant", "food"],
  soul_food: ["restaurant", "food"],
  bar: ["bar"],
  pub: ["bar"],
  sports_bar: ["bar", "restaurant"],
  cafe: ["cafe", "food"],
  record_store: ["store"],
  book_store: ["book_store", "store"],
  clothing_store: ["clothing_store", "store"],
  barber_shop: ["hair_care"],
  beauty_salon: ["beauty_salon", "hair_care"],
  night_club: ["night_club", "bar"],
  bakery: ["bakery", "food", "store"],
};

const GOOGLE_DAY: Record<string, number> = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
const ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function hm(s: string): { hour: number; minute: number } {
  const m = /T?(\d{1,2}):(\d{2})/.exec(s);
  return { hour: Number(m?.[1] ?? 0), minute: Number(m?.[2] ?? 0) };
}

function ampm(h: number, m: number): string {
  const suffix = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")} ${suffix}`;
}

function openingHours(p: WorldPlace): Record<string, unknown> {
  const periods: unknown[] = [];
  const descriptions: string[] = [];
  for (const day of ORDER) {
    const slots = p.hours[day] ?? [];
    if (slots.length === 0) {
      descriptions.push(`${day}: Closed`);
      continue;
    }
    const parts: string[] = [];
    for (const s of slots) {
      const o = hm(s.opens);
      const c = hm(s.closes);
      const d = GOOGLE_DAY[day] as number;
      const overnight = c.hour * 60 + c.minute <= o.hour * 60 + o.minute;
      periods.push({ open: { day: d, ...o }, close: { day: overnight ? (d + 1) % 7 : d, ...c } });
      parts.push(`${ampm(o.hour, o.minute)} – ${ampm(c.hour, c.minute)}`);
    }
    descriptions.push(`${day}: ${parts.join(", ")}`);
  }
  return { periods, weekdayDescriptions: descriptions };
}

function categoriesFor(text: string, includedType: string | undefined): string[] | null {
  const out = new Set<string>();
  for (const [re, cats] of KEYWORDS) if (re.test(text)) for (const c of cats) out.add(c);
  if (includedType) {
    for (const [cat, types] of Object.entries(GOOGLE_TYPES)) if (types.includes(includedType)) out.add(cat);
  }
  return out.size > 0 ? [...out] : null;
}

export function googlePlaceId(p: WorldPlace): string {
  return `syn-gp-${p.id.replace(/-/g, "").slice(4, 28)}`;
}

export function createPlacesTransport(ctx: WorldContext): FetchLike {
  return async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    ctx.count("places", u.pathname);
    if (!u.pathname.endsWith("/places:searchText")) {
      return jsonResponse(404, { synthetic: true, error: { status: "NOT_FOUND", message: "no such method" } });
    }
    let req: Record<string, unknown> = {};
    try {
      req = JSON.parse(bodyText(init) ?? "{}") as Record<string, unknown>;
    } catch {
      return jsonResponse(400, { synthetic: true, error: { status: "INVALID_ARGUMENT", message: "body is not JSON" } });
    }
    const textQuery = String(req.textQuery ?? "").trim();
    if (!textQuery) return jsonResponse(400, { synthetic: true, error: { status: "INVALID_ARGUMENT", message: "textQuery is required" } });
    const circle = (req.locationBias as { circle?: { center?: { latitude?: number; longitude?: number }; radius?: number } } | undefined)?.circle;
    const max = Math.max(1, Math.min(20, Number(req.maxResultCount ?? 20) || 20));
    const includedType = typeof req.includedType === "string" ? req.includedType : undefined;
    if (!circle?.center || typeof circle.center.latitude !== "number" || typeof circle.center.longitude !== "number") {
      return jsonResponse(200, { synthetic: true });
    }
    const center = { lat: circle.center.latitude, lon: circle.center.longitude };
    const radiusM = Math.min(Math.max(500, Number(circle.radius ?? 5000) || 5000), 8000);
    const cats = categoriesFor(textQuery, includedType);
    const words = textQuery.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const sc = ctx.scenario();
    const rows = placesWithin(center, radiusM, ctx.seed)
      .filter((p) => !cats || cats.includes(p.category))
      .map((p) => {
        const nameHit = words.some((w) => p.name.toLowerCase().includes(w)) ? 1.3 : 1;
        const d = haversineKm(center, p) * 1000;
        const prominence = p.rating * Math.log10(p.ratingCount + 10) * nameHit * Math.exp(-d / radiusM);
        return { p, s: prominence + 0.01 * unit(`${ctx.seed}|gp|${textQuery}|${p.id}`) };
      })
      .sort((a, b) => b.s - a.s || (a.p.id < b.p.id ? -1 : 1))
      .slice(0, max);
    if (rows.length === 0) return jsonResponse(200, { synthetic: true });
    const places = rows.map(({ p }) => {
      const closed = p.u.closed < sc.closedRate;
      const out: Record<string, unknown> = {
        id: googlePlaceId(p),
        displayName: { text: p.name, languageCode: "en" },
        formattedAddress: `${p.address}, USA`,
        location: { latitude: round(p.lat + 0.00004, 6), longitude: round(p.lon - 0.00004, 6) },
        rating: p.rating,
        userRatingCount: p.ratingCount,
        businessStatus: closed ? "CLOSED_PERMANENTLY" : "OPERATIONAL",
        types: [...(GOOGLE_TYPES[p.category] ?? ["store"]), "point_of_interest", "establishment"],
      };
      if (!(p.u.noHours < sc.noHoursRate)) out.regularOpeningHours = openingHours(p);
      return out;
    });
    return jsonResponse(200, { synthetic: true, places });
  };
}
