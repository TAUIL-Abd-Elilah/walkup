/**
 * The hand-kept list of national chains (config/chains.json), compiled once.
 * The same list for live and fixture runs: it is bundled with the code, not
 * read at runtime, so a sheet never depends on where the server runs.
 */
import { compileChains, type ChainIndex, type ChainList } from "@walkup/engine";
import CHAIN_FILE from "../../../config/chains.json";

export const CHAINS: ChainIndex = compileChains(CHAIN_FILE as ChainList);
