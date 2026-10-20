/**
 * @walkup/send: the human-confirmed "Send to street team" action.
 * Two steps (prepareSend, then confirmSend with the token), a test inbox by
 * default, typed addresses only, one A# ledger entry per confirm.
 */
export {
  prepareSend,
  confirmSend,
  getDefaultSendStore,
  type PrepareSendInput,
  type PrepareSendResult,
  type PrepareDeps,
  type ConfirmDeps,
  type SendDeps,
  type SendPreview,
  type PreviewAttachment,
  type ConfirmStatus,
  type ConfirmSendResult,
} from "./send";
export {
  TEST_INBOX,
  MAX_TYPED_RECIPIENTS,
  TOKEN_TTL_MS,
  DEFAULT_DAILY_CAP,
  MIN_SECRET_LENGTH,
  LEDGER_ENDPOINT,
  NOT_AFFILIATED_LINE,
  WHAT_IF_NOTE,
  FIXTURE_NOTE,
  ATTACHMENT_KINDS,
  type AttachmentKind,
} from "./constants";
export { resolveSendConfig, hasMailKeys, fromAddress, SendConfigError, type SendConfig } from "./config";
export {
  checkRecipients,
  isValidEmail,
  canonicalEmail,
  redactRecipient,
  type TypedRecipient,
  type Recipient,
  type RecipientSource,
  type RecipientCheck,
} from "./recipients";
export {
  renderAttachments,
  checkAttachmentKinds,
  attachmentFilename,
  ATTACHMENT_LABELS,
  type SheetExporters,
  type AttachmentFile,
  type AttachmentFailure,
} from "./attachments";
export { defaultExporters } from "./default-exporters";
export { buildMessage, buildSubject, buildFooter, showDate, type BuiltMessage, type MessageOptions } from "./message";
export {
  createMemorySendStore,
  utcDay,
  DEFAULT_MAX_PENDING,
  type SendStore,
  type PendingSend,
  type MaybePromise,
  type MemorySendStoreOptions,
} from "./store";
export { createSheetLedger, actionEntry, type ActionEntryInput } from "./ledger";
export { createResendClient, type MailClient } from "./mail-client";
