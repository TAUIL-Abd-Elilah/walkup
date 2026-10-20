/** Types for scripts/check-no-raw.mjs (so tests can import it under strict TypeScript). */

export declare const FORBIDDEN_DIRS: string[];
export declare const SYNTHETIC_DIR: string;
export declare function forbiddenPathReason(path: string): string | null;
export declare function rawBodyReason(value: unknown): string | null;
export declare function parseJsonish(path: string, text: string): unknown;
export declare function contentReason(path: string, text: string): string | null;
export declare function checkRepo(opts?: { cwd?: string; stagedOnly?: boolean }): {
  violations: { path: string; reason: string }[];
  checked: number;
};
