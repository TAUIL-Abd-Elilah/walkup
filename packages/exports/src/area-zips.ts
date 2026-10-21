/**
 * An area's ZIPs as every file lists them: the 5-digit ZCTAs only, once each, without the ZIPs that are not homes
 * (a P.O. box, one organisation, a campus: `isResidentialZip` from @walkup/gazetteer/zips). The sheet's ZIP lines,
 * the calendar and zips.csv use this one rule, so they list the same ZIPs.
 */
import { isResidentialZip } from "@walkup/gazetteer/zips";

const ZIP_RE = /^\d{5}$/;

/** The residential 5-digit ZIPs in `zctas`, in their order, once each. `keep` replaces the gazetteer's check. */
export function areaZips(zctas: readonly unknown[] | null | undefined, keep: (zip: string) => boolean = isResidentialZip): string[] {
  return [...new Set((zctas ?? []).map((z) => String(z).trim()).filter((z) => ZIP_RE.test(z)))].filter((z) => keep(z));
}
