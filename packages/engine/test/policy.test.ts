import { describe, expect, it } from "vitest";
import { DENIED_TAG_KEYWORDS, DENIED_TAG_PREFIXES, type QlooEntity } from "@walkup/contracts";
import {
  buildCopyAllowlist,
  containsDeniedTerm,
  findAlcoholTerm,
  DENIED_TERMS,
  findDeniedTerm,
  isDeniedTag,
  isSensitiveTag,
  isPersonEntity,
  looksPolitical,
  normalizeForMatch,
  sanitizeEntityTags,
  stripPersonTags,
} from "../src/policy";
import { tag } from "./helpers";

describe("isDeniedTag: namespaces", () => {
  it("blocks every contract prefix", () => {
    for (const p of DENIED_TAG_PREFIXES) {
      expect(isDeniedTag(`${p}${p.endsWith(":") ? "" : ":"}something`)).toBe(true);
      expect(isDeniedTag({ id: `${p}${p.endsWith(":") ? "" : ":"}x`, name: "Harmless" })).toBe(true);
    }
  });
  it("is case-insensitive and also checks the tag type", () => {
    expect(isDeniedTag("URN:TAG:ETHNICITY:QLOO:SOMETHING")).toBe(true);
    expect(isDeniedTag({ id: "urn:tag:x:y", name: "Harmless", type: "urn:tag:ethnicity" })).toBe(true);
    expect(isDeniedTag({ id: "urn:tag:x:y", name: "Harmless", type: "urn:tag:religion:qloo" })).toBe(true);
  });
  it("covers spec namespaces and engine additions", () => {
    expect(isDeniedTag("urn:tag:wikipedia_category:wikidata:Q1")).toBe(true);
    expect(isDeniedTag("urn:tag:inclusivity:qloo:lgbtq_friendly")).toBe(true);
    expect(isDeniedTag("urn:tag:credit_card:place:amex")).toBe(true);
    expect(isDeniedTag("urn:tag:hotel_rating:qloo:4")).toBe(true);
    expect(isDeniedTag("urn:tag:cost_description:place:cheap")).toBe(true);
    expect(isDeniedTag("urn:tag:politics:anything")).toBe(true);
    expect(isDeniedTag("urn:tag:political_affiliation:x")).toBe(true);
  });
  it("allows ordinary music, theme and ambience tags", () => {
    for (const id of [
      "urn:tag:genre:music:americana",
      "urn:tag:genre:music:soul",
      "urn:tag:theme:qloo:road_trip",
      "urn:tag:keyword:media:storytelling",
      "urn:tag:ambience:place:cozy",
      "urn:tag:good_for:place:groups",
      "urn:tag:category:place:record_store",
      "urn:tag:audience:qloo:college_students",
    ]) {
      expect(isDeniedTag(id), id).toBe(false);
    }
    expect(isDeniedTag(null)).toBe(false);
    expect(isDeniedTag("")).toBe(false);
  });
});

describe("denied keywords: substring and whole-word rules", () => {
  it("every contract keyword is enforced", () => {
    for (const k of DENIED_TAG_KEYWORDS) {
      expect(containsDeniedTerm(`urn:tag:keyword:media:${k}`), k).toBe(true);
      expect(containsDeniedTerm(`Some ${k.toUpperCase()} thing`), k).toBe(true);
    }
    expect(DENIED_TERMS.length).toBeGreaterThan(DENIED_TAG_KEYWORDS.length);
  });
  it("substring keywords match anywhere", () => {
    expect(containsDeniedTerm("Religious music")).toBe(true);
    expect(containsDeniedTerm("urn:tag:genre:music:christian_rock")).toBe(true);
    expect(containsDeniedTerm("Democratic primary")).toBe(true);
    expect(containsDeniedTerm("LGBTQ+ nights")).toBe(true);
    expect(containsDeniedTerm("Ethnicity")).toBe(true);
    expect(containsDeniedTerm("politically engaged")).toBe(true);
    expect(containsDeniedTerm("Relig\u00edous")).toBe(true); // accent stripped
  });
  it("substring keywords also match inside words (contract semantics)", () => {
    expect(containsDeniedTerm("apolitical")).toBe(true);
    expect(containsDeniedTerm("multiethnic")).toBe(true);
    expect(containsDeniedTerm("irreligious")).toBe(true);
    expect(containsDeniedTerm("biracial")).toBe(true);
    expect(containsDeniedTerm("bipartisan")).toBe(true);
  });
  it('"race" and "gay" are whole words only', () => {
    expect(containsDeniedTerm("race")).toBe(true);
    expect(containsDeniedTerm("Race relations")).toBe(true);
    expect(containsDeniedTerm("urn:tag:keyword:media:race_relations")).toBe(true);
    expect(containsDeniedTerm("Races")).toBe(true);
    expect(containsDeniedTerm("racecar")).toBe(false);
    expect(containsDeniedTerm("Grace")).toBe(false);
    expect(containsDeniedTerm("terrace seating")).toBe(false);
    expect(containsDeniedTerm("embrace")).toBe(false);
    expect(containsDeniedTerm("Horse racing")).toBe(false);
    expect(containsDeniedTerm("gay bar")).toBe(true);
    expect(containsDeniedTerm("Gaylord Opryland")).toBe(false);
    expect(containsDeniedTerm("Marvin Gaye")).toBe(false);
  });
  it("engine additions", () => {
    expect(containsDeniedTerm("racial")).toBe(true);
    expect(containsDeniedTerm("Islamic art")).toBe(true);
    expect(containsDeniedTerm("Islamorada")).toBe(false);
    expect(containsDeniedTerm("Hindustani classical")).toBe(false);
    expect(containsDeniedTerm("sexual orientation")).toBe(true);
    expect(containsDeniedTerm("urn:tag:x:sexual_orientation")).toBe(true);
  });
  it("conservative by design: a word containing a keyword is blocked", () => {
    expect(findDeniedTerm("Christiana Mall")).toBe("christian");
  });
  it("null-safe and returns the matched term", () => {
    expect(findDeniedTerm(null)).toBeNull();
    expect(findDeniedTerm("")).toBeNull();
    expect(findDeniedTerm("Catholic school")).toBe("catholic");
  });
  it("normalizeForMatch pads and collapses separators", () => {
    expect(normalizeForMatch("urn:tag:Race_Relations")).toBe(" urn tag race relations ");
  });
});

describe("buildCopyAllowlist", () => {
  it("filters denied tags, de-duplicates and counts distinct denied ids", () => {
    const tags = [
      tag("urn:tag:genre:music:americana", "Americana"),
      tag("urn:tag:ethnicity:qloo:x", "Some Group"),
      tag("urn:tag:ethnicity:qloo:x", "Some Group"),
      tag("urn:tag:keyword:media:religious_music", "Religious music"),
      tag("urn:tag:genre:music:americana", "Americana"),
      tag("urn:tag:theme:qloo:road_trip", "Road trip"),
      tag("urn:tag:theme:qloo:road_trip_2", "road TRIP"),
      { id: "", name: "empty" },
      null,
    ];
    const a = buildCopyAllowlist(tags);
    expect([...a.allowed]).toEqual(["urn:tag:genre:music:americana", "urn:tag:theme:qloo:road_trip", "urn:tag:theme:qloo:road_trip_2"]);
    expect(a.tags.map((t) => t.id)).toEqual([...a.allowed]);
    expect(a.names).toEqual(["Americana", "Road trip"]);
    expect(a.deniedCount).toBe(2);
    expect(a.deniedNames).toEqual(["Some Group", "Religious music"]);
  });
  it("empty input", () => {
    const a = buildCopyAllowlist([]);
    expect(a.allowed.size).toBe(0);
    expect(a.deniedCount).toBe(0);
  });
  it("keeps extra fields of compare tags", () => {
    const a = buildCopyAllowlist([{ id: "urn:tag:genre:music:soul", name: "Soul", score: 0.7 }]);
    expect(a.tags[0]?.score).toBe(0.7);
  });
});

describe("person tags", () => {
  const person: QlooEntity = {
    entityId: "E-person",
    name: "A Comedian",
    subtype: "urn:entity:person",
    popularity: 0.9,
    affinity: null,
    tags: [tag("urn:tag:genre:person:comedian"), tag("urn:tag:ethnicity:qloo:x")],
    properties: {},
  };
  const venue: QlooEntity = {
    entityId: "E-place",
    name: "A Bar",
    subtype: "urn:entity:place",
    popularity: 0.5,
    affinity: 0.5,
    tags: [tag("urn:tag:category:place:bar"), tag("urn:tag:inclusivity:place:x")],
    properties: {},
  };
  it("strips all tags from persons only", () => {
    expect(isPersonEntity(person)).toBe(true);
    expect(stripPersonTags(person).tags).toEqual([]);
    expect(person.tags).toHaveLength(2); // input untouched
    expect(stripPersonTags(venue)).toBe(venue);
    expect(stripPersonTags({ ...venue, subtype: "urn:entity:artist" }, ["urn:entity:person", "urn:entity:artist"]).tags).toEqual([]);
  });
  it("sanitizeEntityTags also removes denied tags from non-persons", () => {
    expect(sanitizeEntityTags(person).tags).toEqual([]);
    expect(sanitizeEntityTags(venue).tags.map((t) => t.id)).toEqual(["urn:tag:category:place:bar"]);
    const clean = { ...venue, tags: [tag("urn:tag:category:place:bar")] };
    expect(sanitizeEntityTags(clean)).toBe(clean);
  });
});

describe("alcohol terms and identity namespaces", () => {
  it("findAlcoholTerm: whole words, plurals, phrases and 21+", () => {
    expect(findAlcoholTerm("Two-for-one beers after the show")).toBe("beer");
    expect(findAlcoholTerm("Happy hour on Main")).toBe("happy hour");
    expect(findAlcoholTerm("A 21+ night")).toBe("21+");
    expect(findAlcoholTerm("Room for 210+ fans")).toBeNull();
    expect(findAlcoholTerm("Beerbohm Books")).toBeNull();
    expect(findAlcoholTerm("Record stores and coffee")).toBeNull();
    expect(findAlcoholTerm(null)).toBeNull();
  });
  it("customer identity tags are denied", () => {
    expect(isDeniedTag("urn:tag:customer_identity:place:anything")).toBe(true);
  });
});

describe("sensitive vs commercial denials", () => {
  it("isSensitiveTag separates identity namespaces and keywords from commercial ones", () => {
    expect(isSensitiveTag("urn:tag:ethnicity:qloo:x")).toBe(true);
    expect(isSensitiveTag({ id: "urn:tag:keyword:media:x", name: "Religious music" })).toBe(true);
    expect(isSensitiveTag({ id: "urn:tag:cost_description:place:moderate", name: "Moderate" })).toBe(false);
    expect(isSensitiveTag({ id: "urn:tag:wikipedia_category:wikidata:Q1", name: "Music" })).toBe(false);
    expect(isSensitiveTag({ id: "urn:tag:wikipedia_category:wikidata:Q2", name: "Catholic schools" })).toBe(true);
    expect(isSensitiveTag("urn:tag:genre:music:soul")).toBe(false);
    expect(isSensitiveTag(null)).toBe(false);
  });
  it("deniedNames carries only sensitive names, deniedCount counts all", () => {
    const a = buildCopyAllowlist([
      { id: "urn:tag:cost_description:place:moderate", name: "Moderate" },
      { id: "urn:tag:wikipedia_category:wikidata:Q1", name: "Music" },
      { id: "urn:tag:ethnicity:qloo:x", name: "Some Group" },
    ]);
    expect(a.deniedCount).toBe(3);
    expect(a.deniedNames).toEqual(["Some Group"]);
  });
});

describe("regressions: identity and health terms outside the denied namespaces", () => {
  it("media keyword tags naming ethnicity, religion or health are denied", () => {
    for (const [id, name] of [
      ["urn:tag:keyword:media:african_american", "African American"],
      ["urn:tag:keyword:media:african-american_culture", "African-American culture"],
      ["urn:tag:keyword:media:hispanic", "Hispanic"],
      ["urn:tag:keyword:media:latinos", "Latinos"],
      ["urn:tag:keyword:media:black_owned", "Black-owned"],
      ["urn:tag:keyword:media:judaism", "Judaism"],
      ["urn:tag:keyword:media:baptist_church", "Baptist church"],
      ["urn:tag:keyword:media:mental_illness", "Mental illness"],
      ["urn:tag:keyword:media:disability", "Disability"],
    ] as const) {
      expect(isDeniedTag({ id, name }), name).toBe(true);
      expect(isSensitiveTag({ id, name }), name).toBe(true);
    }
  });
  it("genre words that merely share letters stay allowed", () => {
    for (const [id, name] of [
      ["urn:tag:keyword:media:black_comedy", "Black comedy"],
      ["urn:tag:genre:music:latin", "Latin"],
      ["urn:tag:genre:music:black_metal", "Black metal"],
      ["urn:tag:genre:music:gospel", "Gospel"],
      ["urn:tag:category:place:barber_shop", "Barber shop"],
    ] as const) {
      expect(isDeniedTag({ id, name }), name).toBe(false);
    }
  });
  it("findAlcoholTerm covers drinking venues as whole words only", () => {
    expect(findAlcoholTerm("Meet at the sports bar")).toBe("bar");
    expect(findAlcoholTerm("Pubs and taprooms")).not.toBeNull();
    expect(findAlcoholTerm("Barbershops and barbecue")).toBeNull();
  });
});

describe("looksPolitical", () => {
  it("refuses candidate and campaign text, not ordinary events", () => {
    expect(looksPolitical("Campaign rally @ Hampton Coliseum")).toBe(true);
    expect(looksPolitical("Jane Doe for Senate @ The Truth")).toBe(true);
    expect(looksPolitical("Super PAC benefit night")).toBe(true);
    expect(looksPolitical("Monster Truck Rally @ Hampton Coliseum")).toBe(false);
    expect(looksPolitical("")).toBe(false);
    expect(looksPolitical(null)).toBe(false);
  });
});
