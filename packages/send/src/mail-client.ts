/**
 * The one provider call: `resend.emails.send`. The interface is the subset of
 * the Resend SDK this package uses, so tests pass a mock and never touch the network.
 */
import { Resend, type CreateEmailOptions, type CreateEmailRequestOptions, type CreateEmailResponse } from "resend";

export interface MailClient {
  emails: {
    send(payload: CreateEmailOptions, options?: CreateEmailRequestOptions): Promise<CreateEmailResponse>;
  };
}

/** A real Resend client. Only called when RESEND_API_KEY and RESEND_FROM are both set. */
export function createResendClient(apiKey: string): MailClient {
  return new Resend(apiKey);
}
