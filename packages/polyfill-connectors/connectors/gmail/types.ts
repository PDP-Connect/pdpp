// Shapes for the Gmail connector. Extracted from index.ts so parsers.ts
// and tests can import them without pulling in the IMAP runtime entry.

import type { DetailCoverageMessage } from "../../src/connector-runtime.ts";

export interface StreamRequest {
  name: string;
  resources?: readonly string[];
  time_range?: { since?: string; until?: string };
}

export interface StartMessage {
  scope?: { streams?: readonly StreamRequest[] };
  state?: Record<string, unknown>;
  streamsToBackfill?: readonly string[];
  type: "START";
}

export interface InteractionResponse {
  data?: Record<string, unknown>;
  request_id: string;
  status: "success" | "cancelled" | "error";
  type: "INTERACTION_RESPONSE";
}

export interface InteractionMessage {
  kind: "credentials" | "otp" | "manual_action";
  message: string;
  request_id: string;
  schema?: Record<string, unknown>;
  timeout_seconds?: number;
  type: "INTERACTION";
}

export interface ProgressMessage {
  count?: number;
  message: string;
  stream?: string;
  total?: number;
  type: "PROGRESS";
}

export interface StateMessage {
  cursor: unknown;
  stream: string;
  type: "STATE";
}

export interface RecordMessage {
  data: Record<string, unknown>;
  emitted_at: string;
  key: string | number;
  stream: string;
  type: "RECORD";
}

export interface DoneMessage {
  error?: { message: string; retryable: boolean };
  records_emitted: number;
  status: "succeeded" | "failed";
  type: "DONE";
}

export interface SkipResultMessage {
  diagnostics?: unknown;
  message: string;
  reason: string;
  stream: string;
  type: "SKIP_RESULT";
}

export type EmittedMessage =
  | ProgressMessage
  | StateMessage
  | RecordMessage
  | DoneMessage
  | InteractionMessage
  | SkipResultMessage
  // Reference-only per-run detail-coverage report. The runtime already
  // understands DETAIL_COVERAGE (see connector-runtime-protocol.ts); adding it
  // to the local union lets `emit()` carry the attachments coverage report
  // without widening the durable protocol surface.
  | DetailCoverageMessage;

export interface AttachmentRecord {
  blob_ref: BlobRef | null;
  content_id: string | null;
  content_sha256: string | null;
  content_type: string | null;
  encoding: string | null;
  filename: string | null;
  hydration_error: string | null;
  hydration_status: AttachmentHydrationStatus;
  id: string;
  is_inline: boolean;
  message_id: string;
  message_received_at: string;
  part_index: string;
  size_bytes: number | null;
}

export type AttachmentHydrationStatus = "deferred" | "failed" | "hydrated" | "too_large";

export interface BlobRef {
  blob_id: string;
  mime_type: string;
  sha256: string;
  size_bytes: number;
}

export interface AllMailCursor {
  highest_modseq?: number | string | null;
  uidnext?: number;
  uidvalidity?: number;
}

export interface PriorMessagesState {
  all_mail?: AllMailCursor;
}

export interface AttachmentAllMailCursor {
  backfilled_through_uid?: number;
  completed_at?: string | null;
  uidvalidity?: number;
}

export interface PriorAttachmentsState {
  all_mail?: AttachmentAllMailCursor;
}

export interface ThreadAggregate {
  first_message_date: string;
  flagged_count: number;
  has_attachments: boolean;
  id: string;
  labels_set: Set<string>;
  last_message_date: string;
  message_count: number;
  participant_set: Set<string>;
  subject: string | null;
  unread_count: number;
}

/**
 * Per-thread fingerprint persisted in the `threads` STATE cursor across
 * runs. Used solely by the connector to skip emitting a thread RECORD
 * whose semantic shape hasn't moved since the last run. Opaque to the
 * runtime — only the connector interprets it.
 */
export interface ThreadFingerprint {
  fingerprint: string;
}

export interface PriorThreadsState {
  thread_fingerprints?: Record<string, unknown>;
}

export type BodySource = "text_plain" | "html_stripped" | "text_html" | "empty";

export interface ClassifiedBody {
  bodySource: BodySource;
  bodyText: string | null;
}
