/**
 * The hand-kept list of national chains (config/chains.json), compiled once.
 * The same list for live and fixture runs: it is bundled with the code, not
 * read at runtime, so a sheet never depends on where the server runs.
 */
import { compileChains, type ChainIndex, type ChainList } from "@walkup/engine";
import CHAIN_FILE from "../../../config/chains.json";

export const CHAINS: ChainIndex = compileChains(CHAIN_FILE as ChainList);

/** The card limit when the list matched any candidate. */
export const CHAIN_LIMIT = "National chains are spotted by name from a hand-kept list; a chain not on it is listed like a local place.";

/** The card's one line when the rule moved a chain, e.g. "National chains are listed after local places (3 moved down)." */
export function chainLine(moved: number, offList: number): string | null {
  if (moved <= 0) return null;
  const off = offList > 0 ? `, ${offList === moved ? (moved === 1 ? "now off the list" : "all now off the list") : `${offList} of them now off the list`}` : "";
  return `National chains are listed after local places (${moved.toLocaleString("en-US")} moved down${off}).`;
}
