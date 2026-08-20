// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shapes for the Gmail connector. Extracted from index.ts so parsers.ts
// and tests can import them without pulling in the IMAP runtime entry.

import type { RuntimeContinuationFact } from "@pdpp/connector-protocol/connector-runtime-protocol";
import type {
  AttachmentHydrationFailureOutcomeProgress,
  AttachmentRecoveryOutcomeProgress,
  DetailCoverageMessage,
  DetailGapAttemptedMessage,
  DetailGapMessage,
  DetailGapRecoveredMessage,
  DetailGapStartEntry,
} from "../../src/connector-runtime.ts";

export interface StreamRequest {
  name: string;
  resources?: readonly string[];
  time_range?: { since?: string; until?: string };
}

export interface StartMessage {
  detail_gaps?: readonly DetailGapStartEntry[];
  recovery_only?: boolean;
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

/**
 * The mailbox-wide inventory total the IMAP server declared, reported next to
 * how far this connector's historical walk has actually reached. Carried on
 * PROGRESS rather than folded into `messages` DETAIL_COVERAGE because that
 * coverage fact is per-page by contract (the runtime admits a bounded
 * continuation only on same-page `considered === covered`), so the mailbox
 * total would be the wrong denominator there.
 */
export interface AllMailInventoryProgress {
  /** IMAP `EXISTS` for All Mail: the server's own count of messages present. */
  all_mail_exists: number;
  /** Highest UID the historical backfill has admitted so far. */
  backfilled_through_uid: number;
  /** Whether the historical walk has reached its ceiling. */
  historical_backfill_complete: boolean;
  /** The UID the forward walk resumes at, i.e. the historical walk's ceiling. */
  forward_floor_uid: number;
  /** The UID epoch these numbers describe. Counts are comparable only within one. */
  uidvalidity: number;
}

export interface ProgressMessage {
  all_mail_inventory?: AllMailInventoryProgress;
  attachment_hydration_failure_outcome?: AttachmentHydrationFailureOutcomeProgress;
  attachment_recovery_outcome?: AttachmentRecoveryOutcomeProgress;
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
  key: string | readonly string[];
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
  continuation?: RuntimeContinuationFact;
  diagnostics?: unknown;
  message: string;
  reason: string;
  recovery_hint?: string | { action: string; retryable?: boolean };
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
  | DetailCoverageMessage
  // Reference-only per-record detail gap. A failed attachment hydration both
  // lands in DETAIL_COVERAGE.gap_keys and emits one matching DETAIL_GAP so the
  // host commit-gate can credit the missing key against a durable pending gap
  // (gap_keys alone do not satisfy it). Already a known runtime protocol
  // message; added to the local union so `emit()` can carry it.
  | DetailGapMessage
  // Reference-only recovery acknowledgement for a served pending attachment
  // gap. The Gmail connector emits this only after the matching attachment
  // record actually lands.
  | DetailGapRecoveredMessage
  | DetailGapAttemptedMessage;

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
  /**
   * The IMAP `EXISTS` count this mailbox reported on the run that wrote this
   * cursor — the server's own inventory size for All Mail. Persisted so the
   * next run can detect a DECREASE within the same UIDVALIDITY epoch, which is
   * deletion or a server bug rather than normal growth. Meaningful only
   * alongside the `uidvalidity` in this same cursor: across a re-key the UID
   * space was rebuilt and the counts are not comparable.
   */
  exists?: number;
  /** Forward/new-mail watermark. Kept separate from the historical boundary. */
  forward_uidnext?: number;
  highest_modseq?: number | string | null;
  uidnext?: number;
  uidvalidity?: number;
}

export interface PriorMessagesState {
  all_mail?: AllMailCursor;
  backfill?: MessagesBackfillCursor;
}

export interface MessagesBackfillCursor {
  backfilled_through_uid?: number;
  completed_at?: string | null;
  target_uid?: number;
  uidvalidity?: number;
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
