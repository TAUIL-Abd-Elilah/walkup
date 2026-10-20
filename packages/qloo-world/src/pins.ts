/**
 * Tag pins for the fixture world. Live runs read pins from config/tags.json
 * (all unpinned until the key-day lookup); the world answers to these
 * synthetic URNs so the whole pipeline can run. They are labelled as such.
 */
import { categoryTagId, PLACE_CATEGORIES } from "./catalog-tags";

export interface WorldTagPins {
  source: string;
  /** Category key -> pinned tag URN. */
  categories: Record<string, string>;
  /** Sponsor exclusion key -> brand tag URN (alcohol, tobacco, gambling). */
  sponsorExclusions: Record<string, string>;
  /** Tags that mark a person as a comedian. */
  comedianTags: string[];
  /** Lower-cased Ticketmaster genre (or "default") -> tag URN for the tag baseline. */
  baselineTags: Record<string, string>;
  /** Generic foot-traffic heatmap signal (Q6). */
  genericHeatTag: string | null;
}

export const WORLD_TAG_PINS: WorldTagPins = {
  source: "fixture world (synthetic pins; live runs read config/tags.json)",
  categories: Object.fromEntries(PLACE_CATEGORIES.map((c) => [c, categoryTagId(c)])),
  sponsorExclusions: {
    alcohol: "urn:tag:genre:brand:alcohol",
    tobacco: "urn:tag:genre:brand:tobacco",
    gambling: "urn:tag:genre:brand:gambling",
  },
  comedianTags: ["urn:tag:genre:person:comedian"],
  baselineTags: {
    comedy: "urn:tag:genre:media:comedy",
    country: "urn:tag:genre:music:country",
    folk: "urn:tag:genre:music:folk",
    rock: "urn:tag:genre:music:alternative_rock",
    pop: "urn:tag:genre:music:indie_pop",
    "r&b": "urn:tag:genre:music:r_and_b",
    "hip-hop/rap": "urn:tag:genre:music:hip_hop",
    latin: "urn:tag:genre:music:latin_pop",
    jazz: "urn:tag:genre:music:jazz",
    default: "urn:tag:genre:music:alternative_rock",
  },
  genericHeatTag: categoryTagId("restaurant"),
};
