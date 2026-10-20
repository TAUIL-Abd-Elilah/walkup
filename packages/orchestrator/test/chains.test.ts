/**
 * The chain rule on the fixture world: the world's invented places are all
 * local, so this test renames some of them to national chains in the Qloo
 * place responses (same ids, same order, same scores) and checks that the
 * chains are listed after the local places, marked, counted on the card and
 * never dropped without a word.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Partner, PrePostSpot, StreetSheet } from "@walkup/contracts";
import { isChain } from "@walkup/engine";
import { createWorld, type World } from "@walkup/qloo-world";
import { CHAIN_LIMIT, CHAINS, chainLine } from "../src/chains";
import { deps, runPreset, sheetOf } from "./helpers";

const CHAIN_NAMES = ["Starbucks Coffee Company", "Hooters", "Panera Bread", "Outback Steakhouse Tysons", "Dunkin'", "Potbelly Sandwich Shop", "Smoothie King"];

/** `quarters` places in four become a chain (one by default), chosen from the id so every response agrees. */
function chainNameFor(id: string, quarters = 1): string | null {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 4 < quarters ? (CHAIN_NAMES[h % CHAIN_NAMES.length] as string) : null;
}

function withChains(world: World, quarters = 1): World {
  const qlooFetch: World["qlooFetch"] = async (url, init) => {
    const res = await world.qlooFetch(url, init);
    const u = new URL(url);
    if (!res.ok || u.pathname !== "/v2/insights" || u.searchParams.get("filter.type") !== "urn:entity:place") return res;
    const body = (await res.json()) as { results?: { entities?: { entity_id?: string; name?: string }[] } };
    for (const e of body.results?.entities ?? []) {
      const name = e.entity_id ? chainNameFor(e.entity_id, quarters) : null;
      if (name) e.name = name;
    }
    return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
  };
  return { ...world, qlooFetch };
}

/** True when no local place follows a chain inside the same group. */
function chainsLast<T extends { chain?: boolean }>(rows: readonly T[], group: (r: T) => string): boolean {
  const seenChain = new Set<string>();
  for (const r of rows) {
    if (r.chain) seenChain.add(group(r));
    else if (seenChain.has(group(r))) return false;
  }
  return true;
}

const step = (s: StreetSheet, id: string) => s.steps?.find((x) => x.id === id);

let base: StreetSheet;
let chained: StreetSheet;
let mostlyChains: StreetSheet;

beforeAll(async () => {
  base = sheetOf((await runPreset("g1-a", deps())).final);
  chained = sheetOf((await runPreset("g1-a", deps({ world: withChains(createWorld()) }))).final);
  mostlyChains = sheetOf((await runPreset("g1-a", deps({ world: withChains(createWorld(), 3) }))).final);
}, 60_000);

describe("chain rule on a run", () => {
  it("leaves a run with no chains as it was: no chain field, line or limit", () => {
    const partners: Partner[] = base.cards.partners.results;
    const spots: PrePostSpot[] = base.cards.prePost.results;
    expect([...partners, ...spots].some((x) => "chain" in x)).toBe(false);
    expect(base.cards.partners.summary).not.toMatch(/National chains/);
    expect(base.cards.partners.limits).not.toContain(CHAIN_LIMIT);
    expect(base.cards.prePost.limits).not.toContain(CHAIN_LIMIT);
  });

  it("lists partner chains after every local place of their area, and marks exactly the chains", () => {
    for (const s of [chained, mostlyChains]) {
      const partners = s.cards.partners.results;
      for (const p of partners) expect(p.chain === true, p.entity.name).toBe(isChain(p.entity.name, CHAINS));
      expect(chainsLast(partners, (p) => p.tileGeohash ?? "near-venue")).toBe(true);
      expect(s.cards.partners.limits).toContain(CHAIN_LIMIT);
    }
    // One place in four is a chain: local places fill every slot.
    expect(chained.cards.partners.results.some((p) => p.chain)).toBe(false);
    // Three in four: chains fill the slots local places can't, at the end of their area.
    expect(mostlyChains.cards.partners.results.some((p) => p.chain)).toBe(true);
    expect(mostlyChains.cards.partners.results.some((p) => !p.chain)).toBe(true);
  });

  it("says on the card and in the steps how many chains moved, and names every one that left the list", () => {
    const card = chained.cards.partners;
    const moved = /National chains are listed after local places \((\d+) moved down/.exec(card.summary);
    expect(moved).not.toBeNull();
    const cause = step(chained, "partners")?.cause ?? "";
    expect(cause).toContain(`Moved ${moved![1]} national chain`);
    // Same ids, same scores: every partner of the plain run is still listed, or named as off the list.
    const kept = new Set(card.results.map((p) => p.entity.entityId));
    for (const p of base.cards.partners.results) {
      if (kept.has(p.entity.entityId)) continue;
      const name = chainNameFor(p.entity.entityId);
      expect(name, p.entity.name).not.toBeNull();
      expect(cause).toContain(name!);
    }
  });

  it("puts pre/post chains after the local spots", () => {
    for (const sheet of [chained, mostlyChains]) {
      const spots = sheet.cards.prePost.results;
      for (const s of spots) expect(s.chain === true, s.entity.name).toBe(isChain(s.entity.name, CHAINS));
      expect(chainsLast(spots, () => "all")).toBe(true);
      expect(sheet.cards.prePost.limits).toContain(CHAIN_LIMIT);
    }
    expect(chained.cards.prePost.summary).toMatch(/National chains are listed after local places \(\d+ moved down/);
    expect(step(chained, "prepost")?.cause).toMatch(/Moved \d+ national chains? below the local spots/);
  });

  it("words the card line plainly", () => {
    expect(chainLine(0, 0)).toBeNull();
    expect(chainLine(3, 0)).toBe("National chains are listed after local places (3 moved down).");
    expect(chainLine(3, 1)).toBe("National chains are listed after local places (3 moved down, 1 of them now off the list).");
    expect(chainLine(1, 1)).toBe("National chains are listed after local places (1 moved down, now off the list).");
    expect(chainLine(2, 2)).toBe("National chains are listed after local places (2 moved down, all now off the list).");
  });
});
