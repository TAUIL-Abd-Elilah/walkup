/**
 * Ledger helpers: redacted params and copy-as-curl. The key is a header, so it
 * never enters params; redaction is a second line of defence for any value or
 * note that might echo it.
 */
import { cleanParams, encodeQuery } from "./canonical";
import type { LedgerParamValue, QlooRequest } from "./types";

export const KEY_PLACEHOLDER = "$QLOO_API_KEY";
const SECRET_PARAM = /^(x-)?api[-_]?key$|^key$|^apikey$|^token$|^secret$/i;

/** Replaces every occurrence of each secret (length >= 4) with $QLOO_API_KEY. */
export function redactString(s: string, secrets: readonly (string | null | undefined)[]): string {
  let out = s;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join(KEY_PLACEHOLDER);
  }
  return out;
}

export function redactParams(
  params: Record<string, LedgerParamValue>,
  secrets: readonly (string | null | undefined)[],
): Record<string, LedgerParamValue> {
  const out: Record<string, LedgerParamValue> = {};
  for (const [k, v] of Object.entries(params)) {
    if (SECRET_PARAM.test(k)) {
      out[k] = KEY_PLACEHOLDER;
    } else if (typeof v === "string") {
      out[k] = redactString(v, secrets);
    } else if (Array.isArray(v)) {
      out[k] = v.map((x) => redactString(x, secrets));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** The ledger view of a request's params (every Qloo call is a GET). */
export function ledgerParams(req: QlooRequest, secrets: readonly (string | null | undefined)[]): Record<string, LedgerParamValue> {
  const flat: Record<string, LedgerParamValue> = { ...cleanParams(req.params) };
  return redactParams(flat, secrets);
}

/** copy-as-curl with the key as an env var reference. */
export function buildCurl(req: QlooRequest, baseUrl: string, secrets: readonly (string | null | undefined)[] = []): string {
  const keyHeader = `-H "X-Api-Key: ${KEY_PLACEHOLDER}"`;
  const qs = encodeQuery(req.params);
  const cmd = `curl -sS "${baseUrl}${req.path}${qs ? `?${qs}` : ""}" ${keyHeader}`;
  return redactString(cmd, secrets);
}
