// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers for the Signal connector. Kept free of subprocess spawning,
 * `node:sqlite`, and any other Node I/O so they can be unit-tested in
 * isolation against literal row fixtures (see parsers.test.ts) — mirrors
 * the domain-logic/IO split `slack/parsers.ts` established (see that
 * file's own module doc). index.ts does the subprocess/SQLite I/O and
 * calls into these functions.
 *
 * Row shapes here are what `index.ts` reads out of the plaintext SQLite
 * database `sigtop export-database` produces (a real, regular SQLite file
 * — verified directly against sigtop's Go source,
 * github.com/tbvdm/sigtop/signal/{message,recipient,reaction}.go — not
 * `sigtop query-database`, whose `-o outfile` output is unescaped
 * pipe-delimited text unsafe for free-text columns like a message body).
 *
 * Signal Desktop's `messages` table exposes only a handful of flat SQL
 * columns reliably across schema versions (`id`, `conversationId`, `type`,
 * `body`, `sent_at`); `hasAttachments`, `isEdited`/edit history, and
 * reactions are NOT flat columns — Signal Desktop nests them inside the
 * message row's own `json` TEXT column (Signal Desktop's `messageJSON`
 * shape: `{ attachments: [...], reactions: [...], editHistory: [...] }`).
 * `parseMessageJson` below decodes exactly that shape. This mirrors
 * sigtop's own `attachmentsFromJSON`/`parseReactionJSON` (signal/
 * attachment.go, signal/reaction.go), reimplemented here in TypeScript
 * rather than shelled out to, since sigtop's CLI has no subcommand that
 * emits per-message reaction/attachment-presence data as a flat row.
 */

import type { RecordData } from "../../src/connector-runtime.ts";

/**
 * The subset of Signal Desktop's `messageJSON` shape (Signal-Desktop repo:
 * ts/model-types.d.ts) this connector needs. Every field is optional/absent
 * in older schema-version rows — Signal Desktop has shipped this JSON
 * envelope's contents incrementally over many releases, so a message row
 * captured by an older Signal Desktop version may simply lack `reactions`
 * or `editHistory` altogether. Absence is normal, not corruption.
 */
export interface SignalMessageJson {
  attachments?: unknown[];
  editHistory?: unknown[];
  reactions?: Array<{
    emoji?: string;
    fromId?: string;
    targetTimestamp?: number;
  }>;
}

/**
 * Parses a message row's raw `json` column text. Returns an empty object on
 * anything that isn't valid JSON (missing column, corrupt row, a schema
 * version whose `json` column holds something unexpected) rather than
 * throwing — a message with unparseable JSON still has real `id`/`body`/
 * `sent_at` columns worth emitting; only the JSON-derived fields
 * (has_attachments, is_edited, reactions) degrade to their empty defaults.
 */
export function parseMessageJson(raw: string | null | undefined): SignalMessageJson {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SignalMessageJson) : {};
  } catch {
    return {};
  }
}

export interface SignalMessageRow {
  body: string | null;
  conversationId: string;
  id: string;
  json: string | null;
  receivedAtMs: number | null;
  sentAt: number | null;
  sourceServiceId: string | null;
  type: string | null;
}

export interface SignalConversationRow {
  e164: string | null;
  groupId: string | null;
  id: string;
  name: string | null;
  serviceId: string | null;
  type: string | null;
}

/**
 * Signal's own timestamps (`sentAt`, `receivedAtMs`) are epoch
 * milliseconds — unlike iMessage's Apple-epoch/nanosecond quirks, no
 * offset or unit heuristic is needed. A missing/zero/non-finite value is
 * absence, not 1970-01-01: callers must skip the row rather than fabricate
 * a cursor position (same null-date-skip-not-fabricate rule as imessage's
 * appleDateToIso — see index.ts's emitMessageRows for where that happens).
 */
export function signalEpochMsToIso(raw: number | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return new Date(n).toISOString();
}

export interface BuiltMessage {
  record: RecordData;
  /** Epoch-ms cursor value this row would advance the `sent_at` cursor to, or null if unusable. */
  sentAtMs: number | null;
}

/**
 * Signal message `id` is the row's own UUID; `conversation_id` is Signal's
 * conversation UUID. `sender` is the row's `sourceServiceId` column as
 * already resolved by index.ts's SQL: `LEFT JOIN conversations AS c ON
 * m.sourceServiceId = c.serviceId`, selecting `c.id` — the sender's own
 * canonical `conversations` row id, matching sigtop's own schema-version-88+
 * sender resolution (signal/message.go) rather than the raw ACI/PNI
 * `sourceServiceId` UUID, so `sender` foreign-keys against this connector's
 * own `conversations.id` (see index.ts's `messagesSelect` doc for why).
 * `sent_at` is the record's cursor field: prefer
 * `sentAt` (the originating client's send timestamp) and fall back to
 * `receivedAtMs` only when `sentAt` is unusable, so a message with a
 * genuine send time never cursors off a later receive time.
 * `has_attachments`/`is_edited` are derived from the row's `json` blob
 * (see `parseMessageJson`) since Signal Desktop does not expose either as
 * a flat SQL column.
 */
export function buildMessageRecord(row: SignalMessageRow): BuiltMessage {
  const json = parseMessageJson(row.json);
  const sentAtMs = row.sentAt && row.sentAt > 0 ? row.sentAt : (row.receivedAtMs ?? null);
  const sentAtIso = signalEpochMsToIso(row.sentAt) ?? signalEpochMsToIso(row.receivedAtMs);
  return {
    record: {
      id: row.id,
      conversation_id: row.conversationId,
      sender: row.sourceServiceId ?? null,
      sent_at: sentAtIso,
      body: row.body ?? null,
      type: row.type ?? null,
      has_attachments: Array.isArray(json.attachments) && json.attachments.length > 0,
      is_edited: Array.isArray(json.editHistory) && json.editHistory.length > 0,
    },
    sentAtMs: sentAtIso === null ? null : sentAtMs,
  };
}

/**
 * Signal conversation `id` is the row's own UUID (private) or group id
 * (group). `type` is Signal's own `private`/`group` discriminator.
 * `title` prefers the conversation's own `name` (set for groups and
 * user-renamed direct chats); falls back to `null` rather than guessing a
 * contact display name from profile fields sigtop itself only assembles
 * for its own text-export formatting, not something this connector
 * reimplements. `member_count` is always null: Signal Desktop's own schema
 * (verified against sigtop's recipient/conversation model, which this
 * connector's SQL access mirrors) exposes no flat member-count column or
 * field for group conversations — sigtop's own CLI never derives one
 * either. Standing entity, no natural per-row date bound — same reasoning
 * imessage applies to `participants`: full resnapshot every run, no
 * incremental cursor.
 */
export function buildConversationRecord(row: SignalConversationRow): RecordData {
  const type = row.type === "private" || row.type === "group" ? row.type : null;
  return {
    id: row.id,
    type,
    title: row.name ?? null,
    member_count: null,
  };
}

export interface SignalReactionInput {
  emoji: string;
  fromId: string;
  messageId: string;
}

/**
 * Composite id `message_id:emoji:sender`, matching slack.reactions'
 * `message_id:emoji:user_id` shape exactly (see slack/parsers.ts's
 * buildReactionRecords). `sender` (`fromId`) is whatever recipient
 * identifier Signal Desktop's own reaction JSON recorded — a conversation
 * id, phone number, or service-id-shaped string depending on schema
 * version (see sigtop's `recipientFromReactionID`, which itself branches
 * on exactly this ambiguity) — so it is treated as an opaque bounded
 * string, not assumed to be a UUID.
 */
export function buildReactionRecord(row: SignalReactionInput): RecordData {
  return {
    id: `${row.messageId}:${row.emoji}:${row.fromId}`,
    message_id: row.messageId,
    emoji: row.emoji,
    sender: row.fromId,
  };
}

/**
 * Extracts every reaction embedded in a message row's `json` column,
 * paired with the owning message's id — this is how index.ts fans a
 * single `messages` row out into zero or more `reactions` records (Signal
 * Desktop has no standalone `reactions` table; sigtop's own
 * `parseReactionJSON` reads the identical `json.reactions` array).
 * Reactions with a missing/empty emoji or fromId are dropped rather than
 * emitted with a fabricated placeholder — both are required to build the
 * composite id.
 */
export function extractReactionsFromMessageJson(messageId: string, json: SignalMessageJson): SignalReactionInput[] {
  if (!Array.isArray(json.reactions)) {
    return [];
  }
  const out: SignalReactionInput[] = [];
  for (const r of json.reactions) {
    if (r && typeof r.emoji === "string" && r.emoji.length > 0 && typeof r.fromId === "string" && r.fromId.length > 0) {
      out.push({ emoji: r.emoji, fromId: r.fromId, messageId });
    }
  }
  return out;
}
