// Shapes for the Gmail connector. Extracted from index.ts so parsers.ts
// and tests can import them without pulling in the IMAP runtime entry.

export interface StreamRequest {
  name: string;
  resources?: readonly string[];
  time_range?: { since?: string; until?: string };
}

export interface StartMessage {
  scope?: { streams?: readonly StreamRequest[] };
  state?: Record<string, unknown>;
  type: "START";
}

export interface InteractionResponse {
  data?: Record<string, unknown>;
  request_id: string;
  status: "success" | "cancelled" | "error";
  type: "INTERACTION_RESPONSE";
}

export interface InteractionMessage {
  kind: "credentials" | "otp" | "text_input" | "manual_action";
  message: string;
  request_id: string;
  schema?: Record<string, unknown>;
  timeout_seconds?: number;
  type: "INTERACTION";
}

export interface ProgressMessage {
  message: string;
  stream?: string;
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

export type EmittedMessage = ProgressMessage | StateMessage | RecordMessage | DoneMessage | InteractionMessage;

export interface AttachmentRecord {
  content_id: string | null;
  content_type: string | null;
  encoding: string | null;
  filename: string | null;
  id: string;
  is_inline: boolean;
  message_id: string;
  message_received_at: string;
  part_index: string;
  size_bytes: number | null;
}

export interface AllMailCursor {
  highest_modseq?: number | string | null;
  uidnext?: number;
  uidvalidity?: number;
}

export interface PriorMessagesState {
  all_mail?: AllMailCursor;
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

export type BodySource = "text_plain" | "html_stripped" | "text_html" | "empty";

export interface ClassifiedBody {
  bodySource: BodySource;
  bodyText: string | null;
}
