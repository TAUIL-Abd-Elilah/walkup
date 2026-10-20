/** All probes and their run order: groups 1-3 (the gates) first, then the rest by number. */

import { probe4, probe5, probe6, probe7, probe8 } from "./probes-entities.js";
import { probe1, probe2, probe3 } from "./probes-gates.js";
import {
  probe9,
  probe10,
  probe11,
  probe12,
  probe13,
  probe14,
  probe15,
  probe16,
  probe17,
  probe18,
  probe19,
  probe20,
} from "./probes-params.js";
import type { ProbeDef } from "./types.js";

export const PROBES: readonly ProbeDef[] = [
  probe1,
  probe2,
  probe3,
  probe4,
  probe5,
  probe6,
  probe7,
  probe8,
  probe9,
  probe10,
  probe11,
  probe12,
  probe13,
  probe14,
  probe15,
  probe16,
  probe17,
  probe18,
  probe19,
  probe20,
];

export function runOrder(only?: readonly number[] | null): ProbeDef[] {
  const selected = only && only.length > 0 ? PROBES.filter((p) => only.includes(p.id)) : [...PROBES];
  return selected.sort((a, b) => (a.group ?? 99) - (b.group ?? 99) || a.id - b.id);
}

/** Parses "1,2,3" or "1-3,9" into probe numbers; throws on anything else. */
export function parseOnly(value: string): number[] {
  const out = new Set<number>();
  for (const part of value.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad --only item "${part}"`);
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      if (!PROBES.some((p) => p.id === i)) throw new Error(`no probe #${i}`);
      out.add(i);
    }
  }
  if (out.size === 0) throw new Error("--only needs at least one probe number");
  return [...out].sort((x, y) => x - y);
}
