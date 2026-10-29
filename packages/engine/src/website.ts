/**
 * A partner's website as the sheet shows it: kept only when the link plainly belongs to the place.
 *
 * Kept:
 *  - the place's own domain: a word of its name (4+ letters, not a generic word such as "restaurant" or
 *    "kitchen"), or its words run together, appears in the host with its hyphens taken out ("stabledc.com" for
 *    "Stable DC", "hagan-s-tavern.com" for "Hagan's Tavern", "stores.barnesandnoble.com" for "Barnes & Noble"),
 *    or the host's name appears in the place's name run together ("bowlero.com" for "Bowlero Bethesda"); or the
 *    site's own name starts with the initials the name gives in brackets ("alkchicago.com" for "About Last Knife
 *    (ALK)"), or is spelled from the start of every word of the name in order ("avealehouse.com" for "Avenue Ale
 *    House", "qtwbbq.com" for "QS Tips and Wings BBQ");
 *  - a page on a social or listing site (Facebook, Instagram, Yelp, Google Maps, Tripadvisor, OpenTable, Resy,
 *    Toast, Linktree and the like) when it points at a page, not the site's front door.
 * Dropped: anything else (an agency's or developer's server with the place in a sub-path, a staging copy, a
 * bare IP address), a site or page on the dead list (DEAD_SITES), links that are not http(s), and malformed URLs.
 * Tracking parameters (utm_*, also when percent-encoded into the path) are removed from what is kept.
 */

/**
 * Partner sites that no longer work, each checked by hand with one plain GET on the date given. A link to one of
 * these hosts is dropped like a link that isn't the place's own; nothing here calls the network. An entry with a
 * `path` names one page on the host (a chain's location page) and leaves the rest of the host alone. Add an entry
 * only after checking it, and take it off once the site works again.
 */
export const DEAD_SITES: readonly { host: string; path?: string; checked: string; found: string }[] = [
  { host: "tortugadc.com", checked: "2026-10-29", found: "redirects to https, whose certificate has expired" },
  { host: "sweetlobby.com", checked: "2026-10-29", found: "redirects to thesweetlobby.com, which answers 404" },
  { host: "mcgeesjukeboxlounge.com", checked: "2026-10-29", found: "the https handshake fails" },
  {
    host: "buffalowildwings.com",
    path: "/locations/us/il/chicago/2650-north-narragansett-avenue-c9/sports-bar-1422",
    checked: "2026-10-29",
    found: "the page answers 404",
  },
];

/**
 * True when the host (without "www.") is on DEAD_SITES or under one; for an entry with a `path`, only when the
 * link's path (without a trailing slash) is that page.
 */
export function isDeadSite(host: string, pathname = "/"): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  const path = pathname.replace(/\/+$/, "");
  return DEAD_SITES.some((d) => (h === d.host || h.endsWith(`.${d.host}`)) && (d.path === undefined || path === d.path));
}

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
  // Hyphens out, as the name's apostrophes are: "hagan-s-tavern" for "Hagan's Tavern" reads "haganstavern".
  const hostText = parts.join("").replace(/-/g, "");
  const w = words(name);
  if (w.length === 0) return false;
  const joined = w.join("");
  const specific = w.filter((x) => x.length >= 4 && !GENERIC.has(x));
  if (joined.length >= 4 && hostText.includes(joined)) return true;
  if (specific.some((x) => hostText.includes(x))) return true;
  // The first two words run together ("salsitaliankitchen" for "Sal's Italian Kitchen": "sals" + "italian").
  if (w.length >= 2 && (w[0] as string).length + (w[1] as string).length >= 5 && hostText.includes(`${w[0]}${w[1]}`)) return true;
  // The host's own name inside the place's name ("bowlero" in "bowlerobethesda").
  if (parts.some((p) => p.length >= 4 && joined.includes(p.replace(/-/g, "")))) return true;
  // The site's own name: the label just before the top-level domain ("avealehouse" in "www.avealehouse.com").
  const site = ((labels.length > 1 ? labels[labels.length - 2] : labels[0]) as string).replace(/-/g, "");
  // The initials the name gives in brackets, at the start of the site's name ("alkchicago" for "About Last Knife (ALK)").
  // A bracketed word that is not the initials of the words before it ("Joe's Pizza (NYC)", "Smoke Shack (BBQ)") is not
  // the place's short form, so a site named after it ("nycgo.com", "bbqjoints.com") is not kept for it.
  const short = [...name.toLowerCase().matchAll(/\(([a-z0-9]{3,})\)/g)]
    .filter((m) => m[1] === words(name.slice(0, m.index)).map((x) => x[0]).join(""))
    .map((m) => m[1] as string);
  if (short.some((s) => site.startsWith(s))) return true;
  // The site's name spelled from the start of every word in order, "and" and "the" optional: "avealehouse" (ave + ale +
  // house), "pieropizza" for "Piero's Pizza", "qtwbbq" for "QS Tips and Wings BBQ" (q + t + w + bbq).
  return w.length >= 2 && site.length >= 5 && spelledFromWords(site, w);
}

/** True when `label` is a run of non-empty starts of `ws`, every word used once and in order ("and" and "the" may be skipped). */
function spelledFromWords(label: string, ws: readonly string[], at = 0, i = 0, failed = new Set<string>()): boolean {
  if (i === ws.length) return at === label.length;
  const key = `${at}:${i}`;
  if (failed.has(key)) return false;
  const word = ws[i] as string;
  if ((word === "and" || word === "the") && spelledFromWords(label, ws, at, i + 1, failed)) return true;
  for (let n = Math.min(word.length, label.length - at); n >= 1; n--) {
    if (label.startsWith(word.slice(0, n), at) && spelledFromWords(label, ws, at + n, i + 1, failed)) return true;
  }
  failed.add(key);
  return false;
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
  if (isDeadSite(host, url.pathname)) return null;
  if (isListing(host)) {
    const path = url.pathname.replace(/\/+$/, "");
    const pointsSomewhere = path !== "" || url.searchParams.has("q") || url.searchParams.has("cid") || url.searchParams.has("place_id");
    return pointsSomewhere ? stripTracking(url, text) : null;
  }
  if (!name || !hostMatchesName(host, name)) return null;
  return stripTracking(url, text);
}

/** What partners.csv says, in place of "Website not listed", when the place's record has a link the sheet doesn't show. */
export const WEBSITE_NOT_SHOWN_DEAD = "Website not shown: the listed link doesn't work";
export const WEBSITE_NOT_SHOWN_NOT_OWN = "Website not shown: the listed link doesn't match the place's name";

/**
 * Why a web link in the place's own record is not shown, in words, so a blank cell doesn't read "not listed" when the
 * record lists one: the site is on DEAD_SITES, or the link isn't plainly the place's own ("londonhousechicago.com/
 * rooftop" for "LH Rooftop", a hotel's or a league's page). Null when the record has no web link or the rule keeps it.
 */
export function websiteNotShown(raw: string | null | undefined, name: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text || cleanWebsite(text, name) !== null) return null;
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) && !/^https?:\/\//i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
  return isDeadSite(hostOf(url), url.pathname) ? WEBSITE_NOT_SHOWN_DEAD : WEBSITE_NOT_SHOWN_NOT_OWN;
}
