/**
 * Q7 demographics (one call, one block per entity: bill seeds and the house
 * set) and Q8 bill-versus-house compare with the tag-diff fallback. Age and
 * gender skews are shown only as a bill-versus-house note; they are never used
 * for radio format, alcohol rules or community inference.
 */
import type { CompareResult, CompareTag, DemographicsBlock, StreetSheetCards } from "@walkup/contracts";
import { dedupeTags, displayTagName, isTasteTag, tagNameKey } from "@walkup/engine";
import type { RankedTag } from "@walkup/qloo";
import { envelope, failure, node, plural, seedIds, type HouseSet, type RunContext, type Seed } from "../context";
import { genreBaselinePhrase } from "./heat";

type DemoCard = StreetSheetCards["demographics"];
type DiffCard = StreetSheetCards["whatsDifferent"];

const round = (v: number) => Math.round(v * 1000) / 1000;

function roundBlock(b: DemographicsBlock): DemographicsBlock {
  const age: DemographicsBlock["age"] = {};
  for (const [k, v] of Object.entries(b.age)) if (typeof v === "number") age[k as keyof DemographicsBlock["age"]] = round(v);
  const gender: DemographicsBlock["gender"] = {};
  if (typeof b.gender.male === "number") gender.male = round(b.gender.male);
  if (typeof b.gender.female === "number") gender.female = round(b.gender.female);
  return { entityId: b.entityId, age, gender };
}

export async function runDemographics(ctx: RunContext, seeds: Seed[], house: HouseSet): Promise<DemoCard> {
  const billIds = seedIds(seeds);
  const empty = { bill: [] as DemographicsBlock[], house: [] as DemographicsBlock[] };
  const tags = house.baseline === "tag" && house.tag ? [house.tag] : [];
  node(ctx, "Q7 demographics", "bill");
  try {
    const r = await ctx.qloo.demographics([...billIds, ...house.ids], { signalTags: tags });
    const bill = r.value.filter((b) => billIds.includes(b.entityId)).map(roundBlock);
    const houseBlocks = r.value.filter((b) => house.ids.includes(b.entityId) || tags.includes(b.entityId)).map(roundBlock);
    const missing = seeds.filter((s) => !bill.some((b) => b.entityId === s.entity.entityId));
    const missingPersons = missing.filter((s) => s.entity.subtype === "urn:entity:person");
    const hasProxy = seeds.some((s) => s.kind === "proxy");
    const results = { bill, house: houseBlocks };
    if (bill.length === 0 && houseBlocks.length === 0) {
      return envelope("empty", "No age or gender blocks came back.", results, [r.ledgerRef], "Qloo returned no demographics blocks for these signals.");
    }
    const genre = genreBaselinePhrase(ctx.bill.classification);
    const houseLabel = house.baseline === "tag" ? genre : `${plural(houseBlocks.length, "of the room's usual acts", "of the room's usual acts")}`;
    const summary =
      bill.length > 0
        ? `Age mix for the bill's ${plural(bill.length, "act")} and ${houseLabel}.`
        : `Qloo has no age data for this bill's acts, so only ${houseLabel} ${house.baseline === "tag" ? "is" : "are"} shown.`;
    if (missing.length > 0) {
      void missingPersons;
      const names = missing.map((s) => s.entity.name).join(", ");
      const reason = `Qloo has no age data for ${names}${hasProxy ? "; the stand-ins' data is shown" : ""}.`;
      return envelope("partial", summary, results, [r.ledgerRef], reason, ["Age figures describe whole audiences, never one person."]);
    }
    return envelope("ok", summary, results, [r.ledgerRef], undefined, ["Age figures describe whole audiences, never one person."]);
  } catch (err) {
    return failure(err, empty, "Age mix, this bill and the room's usual crowd");
  }
}

/**
 * Every tag is recorded for the denied-tag receipt; only taste tags are kept (no policy-denied tags, places,
 * nationalities, age bands, payment brands, occupations or words that fit any act: `isTasteTag`), named for display.
 */
function filterDenied(tags: CompareTag[], seen: RunContext["seenTags"]): CompareTag[] {
  for (const t of tags) seen.push({ id: t.id, name: t.name, ...(t.type ? { type: t.type } : {}) });
  return tags.filter((t) => isTasteTag(t)).map((t) => ({ ...t, name: displayTagName(t.name) }));
}

/** Generic results (nothing distinctive): the tag-diff fallback runs. */
function isGeneric(c: CompareResult): boolean {
  return c.a.length === 0 && c.b.length === 0;
}

/** Diffs two ranked tag lists (bill, house) by rank. */
export function tagDiff(bill: RankedTag[], house: RankedTag[], gap = 5): CompareResult {
  const hRank = new Map(house.map((t) => [t.id, t.rank]));
  const bRank = new Map(bill.map((t) => [t.id, t.rank]));
  const toTag = (t: RankedTag): CompareTag => {
    const c: CompareTag = { id: t.id, name: t.name };
    if (t.type) c.type = t.type;
    if (t.affinity !== null) c.score = t.affinity;
    return c;
  };
  const a = bill.filter((t) => (hRank.get(t.id) ?? Infinity) - t.rank >= gap).slice(0, 10).map(toTag);
  const b = house.filter((t) => (bRank.get(t.id) ?? Infinity) - t.rank >= gap).slice(0, 10).map(toTag);
  const shared = bill.filter((t) => hRank.has(t.id) && Math.abs((hRank.get(t.id) as number) - t.rank) < gap).slice(0, 8).map(toTag);
  return { shared, a, b, fromTagDiff: true };
}

/**
 * No tag listed twice: each list without repeats (by id, and by name: Qloo returns "Guitar" under two namespaces and
 * the same tag once per seed), a tag in both lean lists moved to `shared`, and anything in `shared` taken out of the
 * two lean lists.
 */
export function dedupeShared(c: CompareResult): CompareResult {
  const key = (t: CompareTag) => tagNameKey(t.name);
  const a0 = dedupeTags(c.a);
  const b0 = dedupeTags(c.b);
  const inB = new Set(b0.flatMap((t) => [t.id, `name:${key(t)}`]));
  const both = a0.filter((t) => inB.has(t.id) || inB.has(`name:${key(t)}`));
  const shared = dedupeTags([...c.shared, ...both]);
  const taken = new Set(shared.flatMap((t) => [t.id, `name:${key(t)}`]));
  const free = (t: CompareTag) => !taken.has(t.id) && !taken.has(`name:${key(t)}`);
  return { ...c, shared, a: a0.filter(free), b: b0.filter(free) };
}

/** "3 tags rank higher for this bill, 7 for the room's usual crowd, and 8 rank high for both." */
function diffLine(c: CompareResult, against: string): string {
  const verb = (n: number) => (n === 1 ? "ranks" : "rank");
  return `${plural(c.a.length, "tag")} ${verb(c.a.length)} higher for this bill, ${c.b.length.toLocaleString("en-US")} for ${against}, and ${c.shared.length.toLocaleString("en-US")} ${verb(c.shared.length)} high for both.`;
}

export async function runCompare(ctx: RunContext, seeds: Seed[], house: HouseSet): Promise<DiffCard> {
  const billIds = seedIds(seeds);
  const empty: CompareResult = { shared: [], a: [], b: [], fromTagDiff: false };
  const provenance: string[] = [];
  let why = "";
  if (house.baseline === "house" && house.ids.length > 0) {
    node(ctx, "Q8 compare", "bill");
    try {
      const r = await ctx.qloo.compare(billIds, house.ids, 30);
      provenance.push(r.ledgerRef);
      const c = r.value;
      if (!isGeneric(c)) {
        const out = dedupeShared({ shared: filterDenied(c.shared, ctx.seenTags), a: filterDenied(c.a, ctx.seenTags), b: filterDenied(c.b, ctx.seenTags), fromTagDiff: false });
        return envelope("ok", diffLine(out, "the room's usual crowd"), out, provenance);
      }
      why = "Qloo's comparison found no tags that set the two apart";
    } catch (err) {
      const ref = (err as { ledgerRef?: string }).ledgerRef;
      if (ref) provenance.push(ref);
      why = "Qloo's comparison failed";
    }
  } else if (!house.tag) {
    // No roster and no genre baseline (comedy has none): nothing to compare with, so no calls.
    return envelope(
      "empty",
      "There is no usual crowd to compare this bill with.",
      empty,
      provenance,
      "Too few of the room's usual acts matched Qloo, and no genre-wide crowd stands in for this bill.",
    );
  } else {
    why = "There was no usual crowd to compare against";
  }
  // Fallback: two urn:tag calls, diffed by rank.
  try {
    node(ctx, "Q8 fallback: bill tags", "bill");
    const b = await ctx.qloo.tagProfile({ signalEntities: billIds, take: 30 });
    provenance.push(b.ledgerRef);
    node(ctx, "Q8 fallback: house tags", "bill");
    let houseTags: RankedTag[] = [];
    if (house.baseline === "house" && house.ids.length > 0) {
      const h = await ctx.qloo.tagProfile({ signalEntities: house.ids, take: 30 });
      provenance.push(h.ledgerRef);
      houseTags = h.value;
    } else if (house.tag) {
      const h = await ctx.qloo.insights({ "filter.type": "urn:tag", "signal.interests.tags": [house.tag], take: 30 });
      provenance.push(h.ledgerRef);
      houseTags = h.value.tags;
    }
    const diff = tagDiff(b.value, houseTags);
    const out = dedupeShared({ shared: filterDenied(diff.shared, ctx.seenTags), a: filterDenied(diff.a, ctx.seenTags), b: filterDenied(diff.b, ctx.seenTags), fromTagDiff: true });
    const against = house.baseline === "house" ? "the room's usual crowd" : genreBaselinePhrase(ctx.bill.classification);
    const cause = house.baseline === "house" ? `${why}, so this compares the two crowds' top tags by rank.` : "The room's own crowd couldn't be built, so this compares two tag lists.";
    return envelope("degraded", diffLine(out, against), out, provenance, cause);
  } catch (err) {
    const f = failure(err, empty, "How this crowd differs");
    return { ...f, provenance: [...new Set([...provenance, ...f.provenance])] };
  }
}
