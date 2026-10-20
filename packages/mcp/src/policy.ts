/**
 * Input policy shared by every tool: what a caller may send, checked before
 * anything runs. The server only ever receives what the operator typed: event
 * text or a Ticketmaster link, partner names and what-if numbers.
 */
import { looksPolitical } from "@walkup/engine";

/**
 * Political candidates and campaigns are out of scope. The word list lives in
 * @walkup/engine so the web API and MCP refuse the same inputs.
 */
export { looksPolitical };

/** Anything that looks like an email address. Contacts are added only in the web app's confirm dialog. */
const EMAIL_RE = /[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[a-z]{2,}/i;

export function containsEmail(text: string): boolean {
  return EMAIL_RE.test(text);
}

export type InputProblem = { field: string; reason: string };

/** First policy problem in the caller's free text, or null. */
export function inputProblem(fields: { field: string; value: string | undefined }[]): InputProblem | null {
  for (const { field, value } of fields) {
    if (!value) continue;
    if (containsEmail(value)) {
      return {
        field,
        reason: `${field} contains an email address. Walkup takes no contact details here; recipients are added only in the web app's confirm dialog.`,
      };
    }
    if (looksPolitical(value)) {
      return { field, reason: "Political candidates and campaigns are out of scope for Walkup." };
    }
  }
  return null;
}
