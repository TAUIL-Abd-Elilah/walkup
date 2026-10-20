/**
 * The denied-tag receipt: how many distinct tags this run saw that policy keeps
 * out of copy, chips and stored data, grouped by why ("3 tags denied by policy
 * (ethnicity/inclusivity/credit_card)"). Tag names are never repeated.
 */
import { findDeniedTerm, isDeniedTag } from "@walkup/engine";

const NAMESPACE_LABELS: [string, string][] = [
  ["urn:tag:ethnicity:", "ethnicity"],
  ["urn:tag:ethnic", "ethnicity"],
  ["urn:tag:inclusivity:", "inclusivity"],
  ["urn:tag:credit_card:", "credit_card"],
  ["urn:tag:hotel_rating:", "hotel_rating"],
  ["urn:tag:cost_description:", "cost_description"],
  ["urn:tag:wikipedia_category:", "wikipedia_category"],
  ["urn:tag:religio", "religion"],
  ["urn:tag:politic", "politics"],
  ["urn:tag:sexuality:", "sexuality"],
  ["urn:tag:sexual_orientation", "sexuality"],
  ["urn:tag:gender_identity", "gender_identity"],
  ["urn:tag:customer_identity:", "customer_identity"],
];

const TERM_CLASSES: [RegExp, string][] = [
  [/ethnic|racial|race|african american|black american|black owned|black people|black culture|black community|asian american|arab american|native american|indigenous|hispanic|latin[oax]|chican[oa]|caucasian/, "ethnicity"],
  [/religio|christian|muslim|jewish|catholic|islam|hindu|sikh|buddhis|evangelical|atheis|judaism|mormon|protestant|pentecostal|baptist|methodist|congregation|churchgoer/, "religion"],
  [/politic|democrat|republican|partisan/, "politics"],
  [/lgbt|gay|lesbian|transgender|bisexual|homosexual|queer|sexual/, "sexuality"],
  [/binary/, "gender_identity"],
  [/health|illness|disabil|disabled|diabet|cancer|hiv|addiction|pregnan|obesity/, "health"],
];

export function deniedClass(tag: { id: string; name: string }): string {
  const id = tag.id.toLowerCase();
  for (const [prefix, label] of NAMESPACE_LABELS) if (id.startsWith(prefix)) return label;
  const term = findDeniedTerm(`${tag.id} ${tag.name}`) ?? "";
  for (const [re, label] of TERM_CLASSES) if (re.test(term)) return label;
  return "other";
}

export interface DeniedReceipt {
  count: number;
  byClass: Record<string, number>;
  /** "3 tags denied by policy (ethnicity/inclusivity/credit_card)", or null when none. */
  line: string | null;
}

const CLASS_ORDER = ["ethnicity", "inclusivity", "credit_card", "religion", "politics", "sexuality", "gender_identity", "health", "customer_identity", "hotel_rating", "cost_description", "wikipedia_category", "other"];

export function deniedReceipt(tags: readonly { id: string; name: string }[]): DeniedReceipt {
  const seen = new Map<string, string>();
  for (const t of tags) {
    if (!t?.id || seen.has(t.id)) continue;
    if (isDeniedTag({ id: t.id, name: t.name ?? "" })) seen.set(t.id, deniedClass({ id: t.id, name: t.name ?? "" }));
  }
  const counts: Record<string, number> = {};
  for (const c of seen.values()) counts[c] = (counts[c] ?? 0) + 1;
  const classes = Object.keys(counts).sort((a, b) => CLASS_ORDER.indexOf(a) - CLASS_ORDER.indexOf(b));
  // Same order as the receipt line, so a consumer can print the classes from the keys.
  const byClass: Record<string, number> = Object.fromEntries(classes.map((c) => [c, counts[c] as number]));
  const count = seen.size;
  return {
    count,
    byClass,
    line: count > 0 ? `${count} ${count === 1 ? "tag" : "tags"} denied by policy (${classes.join("/")})` : null,
  };
}
