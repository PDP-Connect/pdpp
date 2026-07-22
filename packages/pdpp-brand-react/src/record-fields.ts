// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Record type system — pure functions.
 *
 * Ported from the Recordroom design (`rr-record.jsx`) and rebound to the REAL
 * record shape the resource server emits:
 *
 *   { id, object: "record", stream, data: Record<string, unknown>,
 *     emitted_at, display_name?, connection_id? }
 *
 * ALL real fields live in `data` — the design's flat `rec.fields` mock shape
 * does not exist here. Money is declaration-only (a connector manifest declares
 * a field `x_pdpp_type: "currency"`, surfaced as `field_capabilities[f].type`);
 * the canonical `formatDeclaredAmount` does the ÷100, never a magnitude guess.
 *
 * These functions are deliberately free of React and `server-only` imports so
 * the console's `node --test` harness can unit-test them directly (mirroring
 * `record-fields-display.ts`).
 *
 * VOICE: human label = grotesk, wire key = mono. Every field row shows BOTH —
 * a client literally receives the wire key, so it never hides.
 */
import { formatDeclaredAmount } from "@pdpp/brand/record-format";

// ─── Declared-type map ────────────────────────────────────────────
//
// Maps a field's wire key → its declared presentation type (from
// `field_capabilities[field].type`). Pass the empty object when the stream
// declares no types — money detection then degrades to "no money".
export type DeclaredFieldTypes = Record<string, string>;

// ─── Lexicon: wire key → human label ──────────────────────────────
//
// A small curated set of common keys; everything else is prettified from
// snake_case. Kept data-driven so leaf views can extend it trivially.
const FIELD_LABELS: Record<string, string> = {
  employer: "Employer",
  period_start: "Period start",
  period_end: "Period end",
  gross_pay: "Gross pay",
  net_pay: "Net pay",
  taxes_withheld: "Taxes withheld",
  benefits_detail: "Benefits",
  bank_routing: "Deposited to",
  date: "Date",
  amount: "Amount",
  merchant: "Merchant",
  category: "Category",
  account_ref: "Account",
  memo: "Memo",
  track: "Track",
  artist: "Artist",
  played_at: "Played",
  device: "Device",
  playlist_ref: "Playlist",
  from: "From",
  subject: "Subject",
  received: "Received",
  size: "Size",
  label: "Label",
  participants: "Participants",
  messages: "Messages",
  role: "Role",
  session: "Session",
  chars: "Length",
  content: "Message",
  model: "Model",
  charset: "Encoding",
  bytes: "Size",
  message_ref: "Message",
  text: "Body",
  repo: "Repository",
  visibility: "Visibility",
  pushed: "Last push",
  open_prs: "Open PRs",
  commits: "Commits",
  prs_opened: "PRs opened",
  reviews: "Reviews",
  title: "Title",
  started: "Started",
  prompt: "Prompt",
  turns: "Turns",
  filename: "File",
  content_type: "Type",
  doc_type: "Document",
  tax_year: "Tax year",
  current_activity: "Activity",
};

const UNDERSCORE_RE = /_/g;
const REF_WORD_RE = /\bref\b/;
const FIRST_WORD_RE = /^\w/;

/** Prettify a snake_case wire key into a human label. */
export function prettify(key: string): string {
  return key
    .replace(UNDERSCORE_RE, " ")
    .replace(REF_WORD_RE, "")
    .trim()
    .replace(FIRST_WORD_RE, (c) => c.toUpperCase());
}

/** Human label for a wire key — curated lexicon first, prettified fallback. */
export function labelFor(key: string): string {
  return FIELD_LABELS[key] ?? prettify(key);
}

// ─── Stream noun ──────────────────────────────────────────────────

const STREAM_NOUN: Record<string, string> = {
  messages: "message",
  message_bodies: "message body",
  threads: "thread",
  attachments: "attachment",
  sessions: "session",
  function_calls: "tool call",
  conversations: "conversation",
  repositories: "repository",
  user_stats: "stats snapshot",
  pay_statements: "pay statement",
  transactions: "transaction",
  listening_history: "play",
  tax_docs: "document",
  employment: "record",
  balances: "balance",
  statements: "statement",
  current_activity: "transaction",
  skills: "skill",
  user: "record",
};

/** Singular human noun for a stream, e.g. `pay_statements` → "pay statement". */
export function nounFor(stream: string): string {
  return STREAM_NOUN[stream] ?? "record";
}

// ─── Image heuristic (LAST-RESORT fallback) ───────────────────────
//
// The AUTHORITATIVE image signal is the server-declared blob capability
// (`field_capabilities.type === "blob"` → operator-ui `buildBlobAffordance`),
// which callers thread into `RecordBody` as `blobAffordance`. This heuristic is
// ONLY a fallback for callers with no declared capability: it derives an image
// field from `data` — the first field whose value is a string that looks like
// an image URL or data URI. If nothing matches we omit the slot — never fake one.
const IMAGE_URL_RE = /^(https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?\S*)?|data:image\/[a-z+]+;base64,)/i;

/** True when a value looks like an inline-renderable image reference. */
export function isImageVal(value: unknown): value is string {
  return typeof value === "string" && IMAGE_URL_RE.test(value.trim());
}

/** First `[key, url]` in `data` whose value looks like an image, or null. */
export function findImageField(data: Record<string, unknown>): [string, string] | null {
  for (const [k, v] of Object.entries(data)) {
    if (isImageVal(v)) {
      return [k, v];
    }
  }
  return null;
}

// ─── Long-text reading region ─────────────────────────────────────

const LONG_TEXT_KEYS = new Set(["text", "content", "body", "message", "prompt", "memo"]);
const LONG_TEXT_MIN = 56;

/** True when this field should render as a reading region rather than a row. */
export function isLongVal(key: string, value: unknown): value is string {
  return LONG_TEXT_KEYS.has(key) && typeof value === "string" && value.length > LONG_TEXT_MIN;
}

// ─── Kind dispatch ────────────────────────────────────────────────
//
// By field SIGNATURE, not stream name — a "messages" stream is Gmail email from
// one connector but an agent turn from another, so the body must be chosen from
// what the data actually contains.
export type RecordKind = "money" | "media" | "attachment" | "body" | "agent" | "email" | "code" | "generic";

/**
 * Classify a record by the keys present in its `data` plus declared types.
 * `declaredTypes` lets a declared-currency field force the `money` kind even
 * when the key isn't in the heuristic set.
 */
export function kindOf(data: Record<string, unknown>, declaredTypes: DeclaredFieldTypes = {}): RecordKind {
  const keys = new Set(Object.keys(data));
  const hasDeclaredMoney = Object.entries(declaredTypes).some(
    ([k, t]) => keys.has(k) && formatDeclaredAmount(data[k], t) !== null
  );
  if (findImageField(data) || keys.has("filename") || keys.has("content_type")) {
    return "attachment";
  }
  if (hasDeclaredMoney || keys.has("amount") || keys.has("gross_pay") || keys.has("net_pay")) {
    return "money";
  }
  if (keys.has("track") || keys.has("artist")) {
    return "media";
  }
  if (keys.has("charset") && keys.has("text")) {
    return "body";
  }
  if (keys.has("role")) {
    return "agent";
  }
  if (keys.has("from") || keys.has("subject") || keys.has("participants")) {
    return "email";
  }
  if (keys.has("repo") || keys.has("commits")) {
    return "code";
  }
  return "generic";
}

// ─── Derived title ────────────────────────────────────────────────
//
// One grammar for a record's title. A record carries a server-provided
// `display_name` when it has one; otherwise we derive a quiet kicker + a fact
// from `data`. Never "no X" — the kicker names the absence honestly, the
// primary states a fact.
export interface DisplayTitle {
  /** Quiet uppercase kicker, e.g. "untitled message"; null when titled. */
  kicker: string | null;
  /** The primary line — the display name or a derived fact. */
  primary: string;
}

const BYTES_DIGITS_RE = /[^\d]/g;

/** Derive a title for a record, given its `data`, `stream`, and `display_name`. */
export function displayTitle(record: {
  data: Record<string, unknown>;
  display_name?: string;
  stream: string;
}): DisplayTitle {
  const named = record.display_name?.trim();
  if (named) {
    return { primary: named, kicker: null };
  }
  const f = record.data;
  const noun = nounFor(record.stream);
  let hint = "";
  if (typeof f.from === "string") {
    hint = `from ${f.from}`;
  } else if (typeof f.role === "string") {
    hint = `${f.role} turn`;
  } else if (f.bytes != null || typeof f.charset === "string") {
    const kb = f.bytes == null ? "" : `${Math.round(Number(String(f.bytes).replace(BYTES_DIGITS_RE, "")) / 1024)} KB`;
    hint = [typeof f.charset === "string" ? f.charset : "", kb].filter(Boolean).join(" · ");
  } else if (typeof f.date === "string") {
    hint = f.date;
  }
  return { primary: hint || noun, kicker: `untitled ${noun}` };
}

// ─── Per-field render resolution ──────────────────────────────────
//
// Resolves a single `data` value to display text + presentation flags, honoring
// the declared type for money. Mirrors `record-fields-display.ts`'s contract so
// both surfaces agree, but returns a slightly richer shape for the Ink Carbon
// dual-key row (which needs the money/empty flags to pick CSS classes).
export interface ResolvedFieldValue {
  /** No content: null / undefined / empty string. */
  empty: boolean;
  /** Formatted as a declared monetary amount. */
  money: boolean;
  /** Negative monetary amount (drives a subtle sign treatment). */
  negative: boolean;
  /** Display text. */
  text: string;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Resolve a single record field value for display. */
export function resolveFieldValue(value: unknown, declaredType: string | undefined): ResolvedFieldValue {
  if (value === null || value === undefined) {
    return { text: value === null ? "null" : "—", empty: true, money: false, negative: false };
  }
  const amount = formatDeclaredAmount(value, declaredType);
  if (amount) {
    return { text: amount.text, empty: false, money: true, negative: !amount.positive };
  }
  if (typeof value === "string" && value.length === 0) {
    return { text: "empty", empty: true, money: false, negative: false };
  }
  return { text: stringifyValue(value), empty: false, money: false, negative: false };
}
