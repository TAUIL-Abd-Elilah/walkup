/**
 * A partner's website as the sheet shows it: kept only when the link plainly belongs to the place.
 *
 * Kept:
 *  - the place's own domain: a word of its name (4+ letters, not a generic word such as "restaurant" or
 *    "kitchen"), or its words run together, appears in the host ("stabledc.com" for "Stable DC",
 *    "stores.barnesandnoble.com" for "Barnes & Noble"), or the host's name appears in the place's name
 *    run together ("bowlero.com" for "Bowlero Bethesda");
 *  - a page on a social or listing site (Facebook, Instagram, Yelp, Google Maps, Tripadvisor, OpenTable, Resy,
 *    Toast, Linktree and the like) when it points at a page, not the site's front door.
 * Dropped: anything else (an agency's or developer's server with the place in a sub-path, a staging copy, a
 * bare IP address), links that are not http(s), and malformed URLs.
 * Tracking parameters (utm_*, also when percent-encoded into the path) are removed from what is kept.
 */

const LISTING_HOSTS = [
  "facebook.com",
  "fb.com",
  "instagram.com",
  "yelp.com",
  "google.com",
  "goo.gl",
  "g.page",
  "tripadvisor.com",
  "opentable.com",
  "resy.com",
  "toasttab.com",
  "square.site",
  "linktr.ee",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "doordash.com",
  "ubereats.com",
  "grubhub.com",
  "squarespace.com",
  "wixsite.com",
];

/** Words too common in place names to tie a domain to one place. */
const GENERIC = new Set([
  "the",
  "and",
  "bar",
  "grill",
  "restaurant",
  "kitchen",
  "cafe",
  "coffee",
  "house",
  "lounge",
  "pub",
  "tavern",
  "club",
  "bakery",
  "bistro",
  "shop",
  "store",
  "company",
  "food",
  "foods",
  "market",
  "street",
  "place",
  "room",
  "eatery",
  "pizza",
  "tacos",
  "sushi",
  "wine",
  "beer",
  "brewing",
  "brewery",
  "studio",
  "salon",
  "books",
  "records",
  "music",
  "hall",
  "center",
  "centre",
  "city",
  "north",
  "south",
  "east",
  "west",
  "new",
  "old",
  "home",
  "inn",
]);

function words(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

function isListing(host: string): boolean {
  return LISTING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** True when the host plainly belongs to the place named `name` (see the module comment). */
export function hostMatchesName(host: string, name: string): boolean {
  const labels = host.split(".");
  // Every label but the top-level domain ("animaxtechnology.in" -> "animaxtechnology"; "stores.barnesandnoble.com" -> both).
  const parts = labels.length > 1 ? labels.slice(0, -1) : labels;
  const hostText = parts.join("");
  const w = words(name);
  if (w.length === 0) return false;
  const joined = w.join("");
  const specific = w.filter((x) => x.length >= 4 && !GENERIC.has(x));
  if (joined.length >= 4 && hostText.includes(joined)) return true;
  if (specific.some((x) => hostText.includes(x))) return true;
  // The first two words run together ("salsitaliankitchen" for "Sal's Italian Kitchen": "sals" + "italian").
  if (w.length >= 2 && (w[0] as string).length + (w[1] as string).length >= 5 && hostText.includes(`${w[0]}${w[1]}`)) return true;
  // The host's own name inside the place's name ("bowlero" in "bowlerobethesda").
  return parts.some((p) => p.length >= 4 && joined.includes(p.replace(/-/g, "")));
}

/** The link without tracking parameters (utm_*, fbclid, gclid), as written when there were none. */
function stripTracking(url: URL, original: string): string {
  const keys = [...url.searchParams.keys()].filter((k) => /^(utm_|fbclid$|gclid$|y_source$)/i.test(k));
  // "...laurel%3Futm_medium%3Dorganic..." : a query string percent-encoded into the path.
  const encoded = /%3Futm_/i.test(url.pathname);
  if (keys.length === 0 && !encoded) return original;
  for (const k of keys) url.searchParams.delete(k);
  url.pathname = url.pathname.replace(/%3Futm_.*$/i, "");
  let out = url.toString();
  if (url.search === "" && out.endsWith("?")) out = out.slice(0, -1);
  return out;
}

/** The website to show for a place, or null when it plainly isn't the place's own (see the module comment). */
export function cleanWebsite(raw: string | null | undefined, name: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  // "mailto:", "tel:" and other schemes are not web pages ("host:8080" without a scheme still is).
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) && !/^https?:\/\//i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = hostOf(url);
  if (!host.includes(".") || /^\d+(\.\d+){3}$/.test(host) || /^\[/.test(url.hostname)) return null;
  if (isListing(host)) {
    const path = url.pathname.replace(/\/+$/, "");
    const pointsSomewhere = path !== "" || url.searchParams.has("q") || url.searchParams.has("cid") || url.searchParams.has("place_id");
    return pointsSomewhere ? stripTracking(url, text) : null;
  }
  if (!name || !hostMatchesName(host, name)) return null;
  return stripTracking(url, text);
}
