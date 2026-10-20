/**
 * Synthetic entity ids. All are UUID-shaped and start with "0000" so they can
 * never be mistaken for a recorded Qloo id. Generated places use a reversible
 * layout (their geohash-5 cell and index live in the last group) so any place
 * id can be looked up again without a registry.
 */
import { hexOf } from "./rng";

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Id of a hand-written catalog entity. */
export function catalogId(key: string): string {
  const h = hexOf(`catalog:${key}`, 26);
  return `0000${h.slice(0, 4)}-${h.slice(4, 8)}-4${h.slice(8, 11)}-8${h.slice(11, 14)}-${h.slice(14, 26)}`;
}

function gh5ToHex(gh5: string): string {
  let bits = 0;
  for (const c of gh5) bits = bits * 32 + BASE32.indexOf(c);
  return bits.toString(16).padStart(7, "0");
}

function hexToGh5(hex: string): string {
  let bits = parseInt(hex, 16);
  let out = "";
  for (let i = 0; i < 5; i++) {
    out = (BASE32[bits % 32] ?? "0") + out;
    bits = Math.floor(bits / 32);
  }
  return out;
}

/** Id of the `index`-th generated place in a geohash-5 cell. */
export function generatedPlaceId(gh5: string, index: number): string {
  const h = hexOf(`place:${gh5}:${index}`, 14);
  const idx = index.toString(16).padStart(3, "0");
  return `0000${h.slice(0, 4)}-${h.slice(4, 8)}-4${h.slice(8, 11)}-a${h.slice(11, 14)}-f${gh5ToHex(gh5)}${idx}1`;
}

const GENERATED_RE = /^0000[0-9a-f]{4}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-f([0-9a-f]{7})([0-9a-f]{3})1$/;

/** The cell and index of a generated place id, or null for any other id. */
export function parseGeneratedPlaceId(id: string): { gh5: string; index: number } | null {
  const m = GENERATED_RE.exec(id);
  if (!m) return null;
  const gh5 = hexToGh5(m[1] as string);
  const index = parseInt(m[2] as string, 16);
  return generatedPlaceId(gh5, index) === id ? { gh5, index } : null;
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A 22-character Spotify-shaped id that starts with "0Syn" (synthetic). */
export function syntheticSpotifyId(key: string): string {
  const h = hexOf(`spotify:${key}`, 36);
  let out = "0Syn";
  for (let i = 0; out.length < 22; i += 2) out += B62[parseInt(h.slice(i, i + 2), 16) % 62];
  return out;
}

/** Ticketmaster-style id for synthetic events and attractions. */
export function tmId(kind: "ev" | "att" | "ven", key: string): string {
  return `syn-tm-${kind}-${key}`;
}
