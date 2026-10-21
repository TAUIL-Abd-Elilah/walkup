/**
 * The data-quality rules on a whole run. The fixture world's places are tidy, so this test makes its Qloo answers
 * look like live ones (same ids, same order): junk tags on places (an age band, a payment method, a card brand,
 * the bare "Place" tag), a restaurant that also carries a bar tag, a bookstore with a cafe, a shopping plaza, an
 * adult-themed sports bar, and a compare answer that repeats tags and lists a country and an instrument. Then it
 * checks what the sheet shows.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { CompareTag, StreetSheet } from "@walkup/contracts";
import { isTasteTag, tagNameKey } from "@walkup/engine";
import { createWorld, type World } from "@walkup/qloo-world";
import { dedupeShared } from "../src/steps/profile";
import { deps, runPreset, sheetOf } from "./helpers";

type RawTag = { id: string; name: string; type: string; weight?: null };
type RawPlace = { entity_id?: string; name?: string; tags?: RawTag[]; properties?: Record<string, unknown> };

function hash(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

const JUNK: RawTag[] = [
  { id: "urn:tag:age_range:qloo:35_44", name: "35 44", type: "urn:tag:age_range:qloo" },
  { id: "urn:tag:payments:place:credit_cards", name: "Credit cards", type: "urn:tag:payments:place" },
  { id: "urn:tag:endorsement:qloo:american_express", name: "American Express", type: "urn:tag:endorsement:qloo" },
  { id: "urn:tag:genre:place", name: "Place", type: "urn:tag:genre:place" },
];
const t = (ns: string, key: string, name: string): RawTag => ({ id: `${ns}:${key}`, name, type: ns });

/** What each touched place became, by id. */
const KIND = new Map<string, "plaza" | "adult" | "restaurantBar" | "bookCafe">();

function liveLike(world: World): World {
  const qlooFetch: World["qlooFetch"] = async (url, init) => {
    const res = await world.qlooFetch(url, init);
    const u = new URL(url);
    if (!res.ok) return res;
    if (u.pathname === "/v2/analysis/compare") {
      const body = (await res.json()) as { results?: { tags?: Record<string, unknown>[]; a?: Record<string, unknown>[]; b?: Record<string, unknown>[] } };
      const r = body.results ?? {};
      const row = (id: string, name: string, subtype: string) => ({ tag_id: id, name, type: "urn:tag", subtype, query: { score: 0.9 } });
      // Each shared tag three times (once per seed), plus a country and an instrument; the instrument again on side a.
      r.tags = [...(r.tags ?? []).flatMap((x) => [x, x, x]), row("urn:tag:region:qloo:united_states", "United States", "urn:tag:region:qloo"), row("urn:tag:instrument:music:banjo", "Banjo", "urn:tag:instrument:music")];
      r.a = [...(r.a ?? []), row("urn:tag:instrument:qloo:banjo", "Banjo", "urn:tag:instrument:qloo"), row("urn:tag:artist:qloo:versatile", "VERSATILE", "urn:tag:artist:qloo"), row("urn:tag:music:qloo:versatile", "Versatile", "urn:tag:music:qloo")];
      r.b = [...(r.b ?? []), row("urn:tag:endorsement:qloo:american_express", "American Express", "urn:tag:endorsement:qloo"), row("urn:tag:nationality:qloo:american", "American", "urn:tag:nationality:qloo")];
      return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
    }
    if (u.pathname !== "/v2/insights" || u.searchParams.get("filter.type") !== "urn:entity:place") return res;
    const body = (await res.json()) as { results?: { entities?: RawPlace[] } };
    for (const e of body.results?.entities ?? []) {
      if (!e.entity_id) continue;
      const tags = (e.tags ??= []);
      const cat = tags.find((x) => x.id.startsWith("urn:tag:category:place:"))?.id.split(":").pop();
      tags.push(...JUNK);
      const h = hash(e.entity_id) % 12;
      if (h === 0) {
        KIND.set(e.entity_id, "plaza");
        e.name = `${e.name} Plaza`;
        tags.push(t("urn:tag:category:place", "shopping_mall", "Shopping mall"), t("urn:tag:category:place", "food_court", "Food court"));
      } else if (h === 1) {
        KIND.set(e.entity_id, "adult");
        e.properties = { ...(e.properties ?? {}), short_description: "Sports bar known for wings and female servers in themed uniforms." };
      } else if (cat === "restaurant") {
        KIND.set(e.entity_id, "restaurantBar");
        tags.push(t("urn:tag:category:place", "bar", "Bar"), t("urn:tag:category:place", "vietnamese_restaurant", "Vietnamese restaurant"));
      } else if (cat === "book_store") {
        KIND.set(e.entity_id, "bookCafe");
        tags.unshift(t("urn:tag:genre:place", "restaurant", "Restaurant"), t("urn:tag:category:place", "cafe", "Cafe"));
      }
    }
    return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
  };
  return { ...world, qlooFetch };
}

let sheet: StreetSheet;

beforeAll(async () => {
  sheet = sheetOf((await runPreset("g1-a", deps({ world: liveLike(createWorld()) }))).final);
}, 60_000);

const ids = (s: StreetSheet) => [...s.cards.partners.results.map((p) => p.entity.entityId), ...s.cards.prePost.results.map((x) => x.entity.entityId)];

describe("data quality on a live-like run", () => {
  it("never lists a plaza or an adult-themed place, and says how many it left out", () => {
    expect(ids(sheet).some((id) => KIND.get(id) === "plaza" || KIND.get(id) === "adult")).toBe(false);
    expect([...KIND.values()].filter((k) => k === "plaza").length).toBeGreaterThan(0);
    expect(`${sheet.cards.partners.summary} ${sheet.cards.prePost.summary}`).toMatch(/aren't businesses|isn't a business/);
    expect(`${sheet.cards.partners.summary} ${sheet.cards.prePost.summary}`).toMatch(/adult-themed/);
  });

  it("labels a restaurant with a bar a restaurant, and a bookstore with a cafe a bookstore", () => {
    const rows = [...sheet.cards.partners.results, ...sheet.cards.prePost.results];
    const rb = rows.filter((r) => KIND.get(r.entity.entityId) === "restaurantBar");
    const bc = rows.filter((r) => KIND.get(r.entity.entityId) === "bookCafe");
    expect(rb.length + bc.length).toBeGreaterThan(0);
    for (const r of rb) expect(r.category, r.entity.name).toBe("restaurant");
    for (const r of bc) expect(r.category, r.entity.name).toBe("book_store");
  });

  it("shows only taste tags in 'why this place' and in copy", () => {
    const shown = sheet.cards.partners.results.flatMap((p) => p.explain?.tags ?? []);
    expect(shown.length).toBeGreaterThan(0);
    for (const tg of shown) expect(isTasteTag(tg), tg.name).toBe(true);
    for (const h of sheet.cards.copyHooks.results) {
      expect(h.text).not.toMatch(/35 44|American Express|Credit cards/);
      for (const id of h.tagIds) expect(id).not.toMatch(/age_range|payments|endorsement|genre:place/);
    }
  });

  it("lists each tag once in 'what's different', with no country, card brand or nationality", () => {
    const w = sheet.cards.whatsDifferent.results;
    const all = [...w.shared, ...w.a, ...w.b];
    const keys = all.map((x) => tagNameKey(x.name));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("united states");
    expect(keys).not.toContain("american express");
    expect(keys).not.toContain("american");
    expect(w.a.map((x) => x.name)).not.toContain("Banjo");
    expect(w.shared.map((x) => x.name)).toContain("Banjo");
    expect(w.a.filter((x) => x.name === "Versatile")).toHaveLength(1);
    expect(sheet.cards.whatsDifferent.summary).toContain(`${w.a.length} `);
  });
});

describe("dedupeShared", () => {
  const tg = (id: string, name: string): CompareTag => ({ id, name });
  it("drops repeats by id and by name, moves a tag on both sides to shared, and keeps shared tags off both sides", () => {
    const out = dedupeShared({
      shared: [tg("s:drums", "Drums"), tg("s:drums", "Drums"), tg("s:blues", "Blues"), tg("s:blues", "Blues")],
      a: [tg("a:guitar", "Guitar"), tg("a:drums", "Drums"), tg("a:soulful", "Soulful"), tg("a2:soulful", "Soulful"), tg("a:authentic", "Authentic")],
      b: [tg("b:authentic", "Authentic"), tg("b:guitar2", "guitar"), tg("b:joyful", "Joyful")],
      fromTagDiff: false,
    });
    expect(out.shared.map((x) => x.name)).toEqual(["Drums", "Blues", "Guitar", "Authentic"]);
    expect(out.a.map((x) => x.name)).toEqual(["Soulful"]);
    expect(out.b.map((x) => x.name)).toEqual(["Joyful"]);
  });
});
