import type { EnvelopeStatus, LedgerKind, ResolutionStatus } from "@walkup/contracts";

export const STATUS_LABEL: Record<EnvelopeStatus, string> = {
  ok: "ok",
  empty: "empty",
  needs_input: "needs input",
  partial: "partial",
  degraded: "degraded",
  error: "error",
};

/**
 * The status said beside a section heading, in sentence case. "ok" says nothing:
 * the section's own summary is the status.
 */
export const STATUS_WORD: Record<EnvelopeStatus, string> = {
  ok: "",
  empty: "Nothing found",
  needs_input: "Needs your pick",
  partial: "Partial",
  degraded: "Fell back",
  error: "Failed",
};

/**
 * The word before a decision in "What Walkup decided" when the step isn't ok, said in 600 with a colon:
 * "Fell back: couldn't build the room's usual crowd.". A step that did nothing stays listed as "Skipped".
 */
export const STEP_STATUS_WORD: Record<EnvelopeStatus, string> = {
  ok: "",
  empty: "Skipped",
  needs_input: "Needs your answer",
  partial: "Partial",
  degraded: "Fell back",
  error: "Failed",
};

/** Status words stay in the secondary colour; the ones that need a look are bold. Never a coloured pill. */
export const STATUS_CLASS: Record<EnvelopeStatus, string> = {
  ok: "text-muted",
  empty: "text-muted",
  needs_input: "font-semibold text-ink",
  partial: "text-muted",
  degraded: "font-semibold text-ink",
  error: "font-semibold text-accent",
};

export const RESOLUTION_LABEL: Record<ResolutionStatus, string> = {
  exact: "Matched",
  needs_input: "Needs your pick",
  proxy: "Stand-in",
  unresolved: "Not in catalog",
};

export const RESOLUTION_STATUS_TO_ENVELOPE: Record<ResolutionStatus, EnvelopeStatus> = {
  exact: "ok",
  needs_input: "needs_input",
  proxy: "partial",
  unresolved: "empty",
};

export const ROLE_LABEL: Record<string, string> = {
  headliner: "Headliner",
  co: "Co-bill",
  support: "Support",
  venue: "Venue",
  house: "Usual crowd",
  partner: "Partner",
};

/** `places` appears only in the ledgers of sheets made before Google Places was removed (Oct 20 2026). */
export const LEDGER_KIND_LABEL: Record<LedgerKind, string> = {
  qloo: "Qloo",
  tm: "Ticketmaster",
  places: "Google Places",
  acs: "Census ACS",
  anthropic: "Claude",
  action: "Action",
};

/** Short source names for a section's source line ("6 Qloo requests"). */
export const LEDGER_SOURCE_SHORT: Record<LedgerKind, string> = {
  qloo: "Qloo",
  tm: "Ticketmaster",
  places: "Google Places",
  acs: "Census",
  anthropic: "Claude",
  action: "Walkup",
};

export const CATEGORY_LABEL: Record<string, string> = {
  bar: "Bar",
  restaurant: "Restaurant",
  cafe: "Cafe",
  record_store: "Record store",
  book_store: "Bookstore",
  barber_shop: "Barbershop",
  beauty_salon: "Salon",
  clothing_store: "Clothing",
};

export function categoryLabel(key: string): string {
  return CATEGORY_LABEL[key] ?? key.replace(/_/g, " ");
}

export function subtypeLabel(subtype: string): string {
  const last = subtype.split(":").pop() ?? subtype;
  const map: Record<string, string> = {
    artist: "Artist",
    person: "Person",
    place: "Place",
    movie: "Film",
    tv_show: "TV show",
    podcast: "Podcast",
    brand: "Brand",
    book: "Book",
    video_game: "Video game",
  };
  return map[last] ?? last.replace(/_/g, " ");
}

/** "urn:tag:genre:music:singer_songwriter" -> "Singer songwriter" (fallback when no name is known). */
export function tagFallbackName(id: string): string {
  const last = id.split(":").pop() ?? id;
  const words = last.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Plain names for the run's request labels ("Q4 bill heat" -> "Bill heatmap"), first match wins. */
const NODE_WORDS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^Q4 bill heat, half (\d) \(split-half check\)$/, (m) => `Bill heatmap, half ${m[1]} (map check)`],
  [/^Q4 bill heat \(widened to (\d+) km\)$/, (m) => `Bill heatmap, widened to ${m[1]} km`],
  [/^Q4 bill heat$/, () => "Bill heatmap"],
  [/^Q5 house heat, half (\d) \(split-half check\)$/, (m) => `Usual-crowd heatmap, half ${m[1]} (map check)`],
  [/^Q5 house heat \(tag baseline\)$/, () => "Genre heatmap, standing in for the usual crowd"],
  [/^Q5 house heat$/, () => "Usual-crowd heatmap"],
  [/^Q6 generic heat/, () => "General popularity heatmap"],
  [/^Q7 demographics$/, () => "Age mix"],
  [/^Q8 compare$/, () => "Comparison of the two crowds"],
  [/^Q8 fallback: bill tags$/, () => "This bill's top tags"],
  [/^Q8 fallback: house tags$/, () => "The usual crowd's top tags"],
  [/^Q9 house twin, tile (\d+)/, (m) => `Usual-crowd partner search, area ${m[1]}`],
  [/^Q9 house twin, near venue/, () => "Usual-crowd partner search, near the venue"],
  [/^Q9 partners, tile (\d+)(.*)$/, (m) => `Partner search, area ${m[1]}${m[2] ? m[2].replace("(3,500 m)", "(widened to 3.5 km)").replace("(more categories)", "(more types of place)") : ""}`],
  [/^Q9 partners, near venue(.*)$/, (m) => `Partner search near the venue${m[1] ?? ""}`],
  [/^Q10 house twin/, () => "Usual-crowd spot search"],
  [/^Q10 pre\/post(.*)$/, (m) => `Spots near the venue${m[1] ?? ""}`],
  [/^Q11 declared/, () => "Your list"],
  [/^Q12 podcasts$/, () => "Podcasts"],
  [/^Q13 sponsor$/, () => "Sponsor brand"],
  [/^Q14 copy allowlist$/, () => "Tags for the copy lines"],
  [/^Q3 house roster/, () => "The room's upcoming shows"],
  [/^Q3 house set/, () => "The room's headliners"],
  [/^Q2 venue/, () => "The venue"],
  [/^Q1 proxy seed: (.*)$/, (m) => `Stand-in title (${m[1]?.replace(/_/g, " ")})`],
  [/^Q1 acts? (search|by Spotify id)(.*)$/, () => "The acts"],
  [/^T intake$/, () => "The show listing"],
  // Older sheets only: the comparison list was removed on Oct 20 2026.
  [/^arm F/, () => "Google Places comparison list"],
  [/^narration$/, () => "Summary"],
  [/^revise/, () => "Your change note"],
];

/**
 * A ledger note in plain words: the request's purpose, and any outcome the client added ("HTTP 404: no match",
 * "cache hit"). The node code and the sample-data marker are dropped: the ledger's source line says "sample data" once.
 */
export function ledgerNoteText(note: string | undefined): string {
  if (!note) return "";
  const parts = note.split("; ").map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (/^fixture world/.test(p)) continue;
    const node = /^node (.+)$/.exec(p);
    if (node) {
      const label = node[1] ?? "";
      const hit = NODE_WORDS.map(([re, f]) => {
        const m = re.exec(label);
        return m ? f(m) : null;
      }).find((x) => x !== null);
      out.push(hit ?? label.replace(/^[A-Z]\d*\s+/, ""));
      continue;
    }
    if (/^cache hit/.test(p)) {
      out.push("from the cache");
      continue;
    }
    if (/^HTTP 404: no match$/.test(p)) {
      out.push("no match");
      continue;
    }
    out.push(p);
  }
  const text = out.join(", ");
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "";
}

/** Section headings in stream order (the interactive sheet and the live view share them). */
export const CARD_TITLE: Record<string, string> = {
  resolution: "Acts and venue",
  liftMap: "Where this crowd stands out",
  partners: "Partners",
  declared: "Your list",
  prePost: "Before and after the show",
  media: "Podcasts and a sponsor",
  demographics: "Age mix",
  whatsDifferent: "How this crowd differs",
  copyHooks: "Copy lines",
};

/** "Music / Country (Americana)" -> "Americana"; "Music / Pop" -> "Pop". */
export function genreLabel(classification: string | undefined, fallback: string): string {
  if (!classification) return fallback;
  const paren = /\(([^)]+)\)\s*$/.exec(classification);
  if (paren?.[1]) return paren[1].trim();
  const last = classification.split("/").pop()?.trim();
  return last || fallback;
}

/** The footer's data credit for the runtime mode: sample data, recordings of live runs, or the live services. */
export function dataSourcesLine(mode: "live" | "fixture" | "recorded"): string {
  if (mode === "fixture") return "Sample data shaped like Qloo and Ticketmaster responses; neither service is called.";
  if (mode === "recorded") {
    return "Affinity data from Qloo, events and age rules from Ticketmaster, as recorded on live runs; neither service is called now.";
  }
  return "Affinity data from Qloo. Events and age rules from Ticketmaster.";
}
