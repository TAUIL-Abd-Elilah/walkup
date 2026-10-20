/**
 * SYNTHETIC test bodies. Hand-written to mirror the field names of live Qloo
 * responses (shape audit, Oct 15: field paths and types only, no values copied).
 * Not Qloo data: ids are fake UUIDs, names and numbers are invented, and every
 * body says synthetic: true.
 *
 * Live field placement these bodies follow:
 *  - /search and /entities rows: `types[]`, external ids under `properties.external.<ns> = {id}`,
 *    tag refs `{tag_id, name, type, value}`, places `location {lat, lon}` (no geohash, no query.distance).
 *  - insights entity rows: `type`/`subtype`, top-level `external.<ns> = [{id, ...}]`, tag refs
 *    `{id, name, type, weight: null}`, `location {lat, lon, geohash (12 chars)}`, `properties.neighborhood: null`,
 *    `properties.localities[]`, `business_rating` a number, hours `{<weekday>: [{closed, opens, closes}]}`.
 *  - heatmaps: top-level `success`, `results` only; `affinity_rank` a 0-1 fraction.
 *  - 2xx warnings: `warnings: [{type: "not_found", "signal.interests.entities": [ids]}]`.
 *  - 4xx: `{errors: [{message, path}]}`.
 */

export const ID = {
  sidecarPerson: "00000000-0000-4000-8000-000000000101",
  sidecarBand: "00000000-0000-4000-8000-000000000102",
  sidecarMovie: "00000000-0000-4000-8000-000000000103",
  sidecarWeather: "00000000-0000-4000-8000-000000000104",
  beyonce: "00000000-0000-4000-8000-000000000201",
  simonGarfunkel: "00000000-0000-4000-8000-000000000202",
  theChicks: "00000000-0000-4000-8000-000000000203",
  venue: "00000000-0000-4000-8000-000000000301",
  barA: "00000000-0000-4000-8000-000000000401",
  storeB: "00000000-0000-4000-8000-000000000402",
  closedC: "00000000-0000-4000-8000-000000000403",
  actA: "00000000-0000-4000-8000-000000000501",
  actB: "00000000-0000-4000-8000-000000000502",
  houseA: "00000000-0000-4000-8000-000000000601",
  /** A solo entry Qloo lists but has no taste data for (not_found as a signal). */
  wadeSolo: "00000000-0000-4000-8000-000000000801",
  /** The same act's billing name, which Qloo can use. */
  wadeBand: "00000000-0000-4000-8000-000000000802",
  wadeTribute: "00000000-0000-4000-8000-000000000803",
  wadePerson: "00000000-0000-4000-8000-000000000804",
} as const;

export const searchSidecar = {
  synthetic: true,
  results: [
    {
      name: "Sidecar",
      entity_id: ID.sidecarPerson,
      types: ["urn:entity:person"],
      popularity: 0.71,
      properties: { short_description: "Stand-up comedian (synthetic)", external: { wikidata: { id: "Q100000001" } } },
      tags: [
        { tag_id: "urn:tag:genre:person:comedian", name: "Comedian", type: "urn:tag:genre:person", value: "urn:tag:genre:person:comedian" },
        { tag_id: "urn:tag:occupation:person:actor", name: "Actor", type: "urn:tag:occupation", value: "urn:tag:occupation:person:actor" },
      ],
    },
    {
      name: "Sidecar",
      entity_id: ID.sidecarBand,
      types: ["urn:entity:artist"],
      popularity: 0.32,
      properties: { short_description: "Rock band (synthetic)", external: { spotify: { id: "0SyntheticSpotifyId001" } } },
      tags: [{ tag_id: "urn:tag:genre:music:rock", name: "Rock", type: "urn:tag:genre", value: "urn:tag:genre:music:rock" }],
    },
    {
      name: "Sidecar Weather",
      entity_id: ID.sidecarWeather,
      types: ["urn:entity:artist"],
      popularity: 0.12,
      properties: {},
    },
  ],
};

export const searchSidecarMovie = {
  synthetic: true,
  results: [
    {
      name: "Sidecar",
      entity_id: ID.sidecarMovie,
      types: ["urn:entity:movie"],
      popularity: 0.55,
      properties: { release_date: "1987-05-15", short_description: "Road movie (synthetic)", external: { imdb: { id: "tt0000001" } } },
    },
  ],
};

export const searchDiacritics = {
  synthetic: true,
  results: [
    { name: "Beyoncé", entity_id: ID.beyonce, types: ["urn:entity:artist"], popularity: 0.99, properties: {} },
    { name: "Simon & Garfunkel", entity_id: ID.simonGarfunkel, types: ["urn:entity:artist"], popularity: 0.9, properties: {} },
    { name: "The Chicks", entity_id: ID.theChicks, types: ["urn:entity:artist"], popularity: 0.8, properties: {} },
  ],
};

export const searchVenue = {
  synthetic: true,
  results: [
    {
      name: "The Example Hall",
      entity_id: ID.venue,
      types: ["urn:entity:place"],
      popularity: 0.6,
      location: { lat: 36.1612, lon: -86.7785 },
      properties: { address: "1 Example St, Nashville, TN", is_closed: false, external: { google_place: { id: "synthetic-gp-1", place_id: "synthetic-gp-1" } } },
    },
  ],
};

export const placeInsights = {
  synthetic: true,
  success: true,
  query: {
    explainability: {
      "signal.interests.entities": {
        effect_on_all_recs: [
          { entity_id: ID.actA, avg_score: 0.61 },
          { entity_id: ID.actB, avg_score: 0.39 },
        ],
        effect_on_top3_recs: [
          { entity_id: ID.actA, avg_score: 0.66 },
          { entity_id: ID.actB, avg_score: 0.34 },
        ],
      },
    },
  },
  results: {
    entities: [
      {
        name: "Synthetic Bar A",
        entity_id: ID.barA,
        type: "urn:entity",
        subtype: "urn:entity:place",
        popularity: 0.82,
        disambiguation: "Sampleton, TN (synthetic)",
        location: { lat: 36.1701, lon: -86.7601, geohash: "dn6mb12x4k9q" },
        external: {
          google_place: [{ id: "synthetic-gp-a", place_id: "synthetic-gp-a" }],
          tripadvisor: [{ id: "000001", rating: 4.5, rating_count: 120 }],
        },
        properties: {
          address: "10 Sample Ave",
          neighborhood: null,
          phone: "+1 555 0100",
          website: "https://bar-a.example",
          price_level: 2,
          business_rating: 4.6,
          is_closed: false,
          hours: {
            thursday: [{ closed: false, opens: "T16:00:00", closes: "T02:00:00" }],
            monday: [{ closed: true, opens: null, closes: null }],
          },
          akas: [{ value: "Bar A", language: "en" }],
          menu_url: "https://bar-a.example/menu",
          image: { url: "https://img.example/bar-a.jpg" },
          geocode: { city: "Nashville", admin1_region: "TN", country_code: "US", name: null },
          localities: [
            { name: "Sample City", place: "city", boundary: "administrative", locality_id: "r000001", admin_level: 8 },
            { name: "37999", place: "ZCTA", boundary: "ZCTA", locality_id: "z37999", admin_level: 10 },
          ],
          good_for: [{ id: "urn:tag:genre:place:late_night", name: "Late night", type: "urn:tag:genre:place", weight: null }],
        },
        tags: [
          { id: "urn:tag:category:place:bar", name: "Bar", type: "urn:tag:category:place", weight: null },
          { id: "urn:tag:ambience:qloo:intimate", name: "Intimate", type: "urn:tag:ambience:qloo", weight: null },
        ],
        query: {
          affinity: 0.973,
          distance: 812.4,
          measurements: { audience_growth: 0.42 },
          explainability: {
            "signal.interests.entities": [
              { entity_id: ID.actA, score: 0.71 },
              { entity_id: ID.actB, score: 0.29 },
            ],
          },
        },
      },
      {
        name: "Synthetic Records B",
        entity_id: ID.storeB,
        type: "urn:entity",
        subtype: "urn:entity:place",
        popularity: 0.41,
        location: { lat: 36.172, lon: -86.758 },
        properties: { is_closed: false },
        query: { affinity: 0.951, distance: 1203 },
      },
      { entity_id: "", name: "missing id is skipped" },
    ],
  },
};

/** Live heatmaps carry only `success` and `results`; affinity_rank is a 0-1 fraction. */
export const heatmap = {
  synthetic: true,
  success: true,
  results: {
    heatmap: [
      {
        location: { latitude: 36.16, longitude: -86.78, geohash: "dn6m9p" },
        query: { affinity: 1, affinity_rank: 0.94, popularity: 0.99, entity_artist_affinity: 1, entity_artist_affinity_rank: 0.94 },
      },
      { location: { latitude: 36.2, longitude: -86.7, geohash: "dn6mf0" }, query: { affinity: 0.81, affinity_rank: 0.99, popularity: 0.4 } },
      { location: { geohash: "dn6m9n" }, query: { affinity: 0.5, affinity_rank: 0.2, popularity: 0.3 } },
      { location: { latitude: 1, longitude: 2 }, query: { affinity: 0.4 } },
      { location: { latitude: 36.1, longitude: -86.9, geohash: "dn6m3z" }, query: { affinity: 0.3 } },
    ],
  },
};

export const demographics = {
  synthetic: true,
  results: {
    demographics: [
      {
        entity_id: ID.actA,
        query: {
          age: {
            "24_and_younger": -0.2,
            "25_to_29": 0.43,
            "30_to_34": 0.7,
            "35_to_44": 0.1,
            "45_to_54": -0.53,
            "55_and_older": -0.6,
            "not_a_bucket": 9,
          },
          gender: { male: -0.1, female: 0.12 },
        },
      },
      { entity_id: ID.houseA, query: { age: { "55_and_older": 0.3 } } },
      // A signal tag's block: entity_id holds the tag URN (there is no tag_id).
      { entity_id: "urn:tag:genre:music:country", query: { age: { "24_and_younger": -0.3 }, gender: { male: 0.05, female: -0.05 } } },
      { query: { age: {} } },
    ],
  },
};

/** Compare: no success field; query.count arrives as a string. */
export const compare = {
  synthetic: true,
  duration: 88,
  results: {
    tags: [
      { tag_id: "urn:tag:genre:music:country", name: "Country", type: "urn:tag", subtype: "urn:tag:genre:music", popularity: 0.7, query: { score: 0.91 } },
    ],
    a: [
      { tag_id: "urn:tag:genre:music:americana", name: "Americana", subtype: "urn:tag:genre:music", query: { count: "12" } },
      { tag_id: "urn:tag:theme:qloo:storytelling", name: "Storytelling", subtype: "urn:tag:theme:qloo", query: { count: "7" } },
    ],
    b: [{ tag_id: "urn:tag:genre:music:pop", name: "Pop", subtype: "urn:tag:genre:music", query: { count: "9" } }],
    matchEntities: [],
  },
};

/** filter.type=urn:tag insights. */
export const tagProfile = {
  synthetic: true,
  results: {
    tags: [
      { tag_id: "urn:tag:genre:music:americana", name: "Americana", types: ["urn:entity:artist"], subtype: "urn:tag:genre:music", query: { affinity: 0.992 } },
      { tag_id: "urn:tag:audience:qloo:roots_fans", name: "Roots fans", types: ["urn:entity:artist"], subtype: "urn:tag:audience:qloo", query: { affinity: 0.88 } },
      { name: "no id: skipped" },
    ],
  },
};

/** GET /v2/tags. */
export const tagsSearch = {
  synthetic: true,
  results: {
    tags: [
      { id: "urn:tag:category:place:record_store", name: "Record Store", type: "urn:tag:category:place", parents: [{ type: "urn:entity:place" }], popularity: 0.31 },
      { id: "urn:tag:category:place:vinyl_sign_shop", name: "Vinyl sign shop", type: "urn:tag:category:place", parents: [{ type: "urn:entity:place" }] },
    ],
  },
};

export const audiences = {
  synthetic: true,
  results: {
    audiences: [
      { id: "urn:audience:hobbies_and_interests:live_music", entity_id: "00000000-0000-4000-8000-000000000701", name: "Live music", type: "urn:audience:hobbies_and_interests", parents: [{ type: "urn:audience" }] },
    ],
  },
};

/** /entities rows: `types[]`, external ids under properties.external.<ns> = {id}. */
export const entitiesBySpotify = {
  synthetic: true,
  results: [
    {
      name: "Synthetic Act A",
      entity_id: ID.actA,
      types: ["urn:entity:artist"],
      popularity: 0.77,
      properties: {
        external: {
          spotify: { id: "1SyntheticSpotifyId001" },
          wikidata: { id: "Q100000002" },
          lastfm: { id: "synthetic-act-a", listeners: 1000, scrobbles: 5000 },
        },
      },
      tags: [],
    },
  ],
};

/** /search for a name whose solo entry Qloo cannot use as a signal; the billing name can be used. */
export const searchWade = {
  synthetic: true,
  results: [
    { name: "Wade Corley", entity_id: ID.wadeSolo, types: ["urn:entity:artist"], popularity: 0.81, properties: {} },
    { name: "Wade Corley and The Low Ten", entity_id: ID.wadeBand, types: ["urn:entity:artist"], popularity: 0.79, properties: {} },
    { name: "Wade Corley Tribute Night", entity_id: ID.wadeTribute, types: ["urn:entity:artist"], popularity: 0.1, properties: {} },
  ],
};

/**
 * Live /search for a musician (types artist,person): an artist entry and a person entry under the same
 * exact name, plus the band's billing name. The person carries musician tags.
 */
export const searchMusicianPair = {
  synthetic: true,
  results: [
    { name: "Wade Corley", entity_id: ID.wadeSolo, types: ["urn:entity:artist"], popularity: 0.81, properties: {}, tags: [] },
    {
      name: "Wade Corley",
      entity_id: ID.wadePerson,
      types: ["urn:entity:person"],
      popularity: 0.7,
      properties: { external: { spotify: { id: "2SyntheticSpotifyId002" } } },
      tags: [
        { tag_id: "urn:tag:genre:person:musician", name: "Musician", type: "urn:tag:genre:person", value: "urn:tag:genre:person:musician" },
        { tag_id: "urn:tag:occupation:person:singer", name: "Singer", type: "urn:tag:occupation", value: "urn:tag:occupation:person:singer" },
      ],
    },
    { name: "Wade Corley and The Low Ten", entity_id: ID.wadeBand, types: ["urn:entity:artist"], popularity: 0.79, properties: { external: { spotify: { id: "3SyntheticSpotifyId003" } } }, tags: [] },
    { name: "Wade Corley and The Low Ten", entity_id: ID.wadeBand, types: ["urn:entity:person"], popularity: 0.4, properties: {}, tags: [] },
  ],
};

/** A 200 insights answer that ignored one signal id (top-level warnings, dotted key as a literal). */
export function placeCheckWithWarning(dropped: string[]): Record<string, unknown> {
  return {
    synthetic: true,
    success: true,
    results: { entities: [{ name: "Synthetic Check Place", entity_id: ID.barA, type: "urn:entity", subtype: "urn:entity:place", query: { affinity: 0.95 } }] },
    ...(dropped.length > 0 ? { warnings: [{ type: "not_found", "signal.interests.entities": dropped }] } : {}),
  };
}

/** The 400 body when every signal id was unknown and nothing else ranks (entity insights; a heatmap stays 200). */
export const errorSignalNotFound = {
  synthetic: true,
  errors: [{ message: "No valid signal entity (synthetic message)", path: "signal.interests.entities" }],
};

/** Compare with more rows than `take` asked for (live compare ignores take). */
export const compareLong = {
  synthetic: true,
  duration: 90,
  results: {
    tags: Array.from({ length: 6 }, (_, i) => ({ tag_id: `urn:tag:genre:music:g${i}`, entity_id: `00000000-0000-4000-8000-0000000009${String(i).padStart(2, "0")}`, name: `G${i}`, type: "urn:tag", subtype: "urn:tag:genre:music", popularity: 0.5, query: { score: 0.9 - i / 100 } })),
    a: Array.from({ length: 5 }, (_, i) => ({ tag_id: `urn:tag:theme:qloo:a${i}`, name: `A${i}`, subtype: "urn:tag:theme:qloo", query: { count: String(10 - i) } })),
    b: Array.from({ length: 4 }, (_, i) => ({ tag_id: `urn:tag:theme:qloo:b${i}`, name: `B${i}`, subtype: "urn:tag:theme:qloo", query: { count: String(9 - i) } })),
    matchEntities: [],
  },
};

/** A body whose shape is not one we know. */
export const unknownShape = { synthetic: true, results: { something_else: [1, 2, 3] } };
