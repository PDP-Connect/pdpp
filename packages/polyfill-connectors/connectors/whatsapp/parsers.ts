// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  hasZipLocalFileSignature,
  readZipEntries,
  readZipEntriesFromFile,
  type ZipEntry,
  ZipPolicyViolationError,
  type ZipReadPolicy,
  zipBasename,
} from "../../src/bounded-zip-archive.ts";

const GIB = 1024 * 1024 * 1024;

// maxEntryUncompressedBytes is the decompression-bomb gate — it bounds how
// much any ONE zip entry can inflate to, regardless of its declared size
// (see bounded-zip-archive.ts). It is NOT the same concern as "how large can
// a legitimate archive be": a single WhatsApp media attachment (photo,
// video, voice note) is never legitimately more than a few GiB, so this stays
// a real per-entry ratio guard.
//
// maxTotalUncompressedBytes is a SEPARATE, much larger ceiling on the sum
// across the whole archive — a real "export chat with media" covering years
// of history can legitimately contain many GiB of attachments. Conflating
// this with the per-entry bomb cap (as a single 1 GiB constant previously
// did) meant a real multi-GB export with ordinary-sized individual photos/
// videos was rejected outright, even though no single entry was suspicious.
// Configurable via WHATSAPP_MAX_ARCHIVE_BYTES so an operator can raise it for
// their deployment without a code change; defaults to a generous but bounded
// 20 GiB.
function resolveMaxTotalUncompressedBytes(): number {
  const raw = process.env.WHATSAPP_MAX_ARCHIVE_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20 * GIB;
}

function whatsappZipPolicy(): ZipReadPolicy {
  return {
    maxEntries: 20_000,
    maxEntryUncompressedBytes: 2 * GIB,
    maxTotalUncompressedBytes: resolveMaxTotalUncompressedBytes(),
  };
}

// The chat .txt entry itself (as opposed to media attachments) is parsed as
// one in-memory string — even a chat spanning a decade of daily messaging is
// realistically tens of MB, nowhere near the multi-GiB media policy above.
// Capping it far below maxEntryUncompressedBytes means a zip whose ".txt"
// entry is itself huge (e.g. a decompression-bomb candidate disguised with a
// .txt name, or genuinely corrupt metadata) does not get a multi-GB text
// buffer materialized just to run the chat-format sniff against it.
const MAX_CHAT_TEXT_BYTES = 200 * 1024 * 1024;

// MAX_CHAT_TEXT_BYTES bounds the RAW TEXT size of a zip's chat entry, but a
// genuinely large plain .txt upload (not zip-bounded at all) or a
// pathologically message-dense chat.txt can still build an unboundedly
// large parsed message ARRAY -- the parse RESULT, not raw text, and a
// completely separate memory cost. ~500 bytes/message measured for a
// realistic ParsedWhatsAppMessage object; 2,000,000 messages caps that
// array's overhead at roughly 1 GiB, comfortably below a default Node heap
// (~4.3 GiB) even alongside other server load, while remaining far beyond
// any real conversation (2M messages is 100+ years at 50 messages/day).
// Enforced as a real, catchable rejection DURING accumulation (see
// WhatsAppChatLineAccumulator.pushLine) rather than discovered only after
// the array has already grown past a safe size -- the whole point is to
// turn an uncontrolled V8 heap-OOM (which aborts the process, bypassing
// try/catch) into a normal thrown error the existing validation/collection
// error paths already handle. Configurable via WHATSAPP_MAX_MESSAGE_COUNT
// (same override pattern as WHATSAPP_MAX_ARCHIVE_BYTES above) so tests can
// exercise the real rejection path without writing millions of lines.
function resolveMaxMessageCount(): number {
  const raw = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2_000_000;
}

/**
 * Thrown by WhatsAppChatLineAccumulator.pushLine once the message-count
 * policy is exceeded -- a real, catchable JS exception, not a crash. Mirrors
 * WhatsAppZipPolicyRejection's role: distinguishes "this is a real (or
 * plausibly real) export that tripped a resource policy" from "this isn't a
 * recognizable export at all," so callers report it as too_large, not
 * unsupported.
 */
export class WhatsAppMessageLimitExceededError extends Error {
  constructor(messageCount: number, maxMessageCount: number) {
    super(`WhatsApp export exceeds the maximum supported message count (${messageCount} > ${maxMessageCount})`);
    this.name = "WhatsAppMessageLimitExceededError";
  }
}

export interface ParsedWhatsAppMessage {
  author: string;
  content: string;
  has_attachment?: boolean;
  id: string;
  sent_at: string;
}

/**
 * A media attachment's bytes are read LAZILY via `data()`, never eagerly
 * materialized into this object. A "with media" export can legitimately
 * contain many GiB of attachments; holding every attachment's inflated bytes
 * in one array simultaneously (the previous shape: `{ bytes: Buffer }`)
 * meant total attachment memory scaled with archive size even though only
 * one attachment is ever being uploaded at a time. Callers must call
 * `data()` at most once and let the bytes go out of scope (e.g. immediately
 * after handing them to the blob uploader) before moving to the next
 * attachment.
 */
export interface ParsedWhatsAppAttachment {
  data: () => Buffer;
  filename: string;
}

/**
 * Aggregate-only summary of a chat export: everything validation.ts and
 * index.ts's chat-identity resolution need to know WITHOUT holding every
 * message in memory at once. Produced by a single streaming pass
 * (scanWhatsAppChatIdentity) that maintains only bounded running state
 * (a Set of participant names, min/max timestamps, a few counters, and a
 * fixed-size reservoir sample of message fingerprints for
 * openChatIdentityCursor's overlap check) — never an array sized by
 * message count. Emitting actual message RECORDS is a SEPARATE streaming
 * pass (streamWhatsAppChatMessages) driven only after this summary's
 * chatId has been resolved through the persisted reconciliation cursor.
 */
export interface WhatsAppChatSummary {
  attachmentMessageCount: number;
  /** Provisional chatId, derived directly from identityKey with no salt —
   *  the caller (index.ts) MUST resolve this through its persisted
   *  reconciliation-alias cursor (index.ts's openChatIdentityCursor) before
   *  treating it as final and driving streamWhatsAppChatMessages with it. */
  chatId: string;
  firstSentAt: string | null;
  /** Best-effort reconciliation lookup key — see deriveChatIdentityKey. */
  identityKey: string;
  lastSentAt: string | null;
  messageCount: number;
  /** Fixed-size UNIFORM RANDOM sample of message content fingerprints
   *  (reservoir sampling, not fixed-stride) — see scanWhatsAppChatIdentity's
   *  doc comment for why stride sampling was replaced. */
  messageFingerprintSample: string[];
  participants: string[];
  title: string;
}

// WhatsApp export line formats:
//   iOS: [M/D/YY, H:MM:SS AM] Author: Message
//   iOS: [YYYY-MM-DD, HH:MM:SS] Author: Message
//   Android: M/D/YY, H:MM - Author: Message
//   Android: DD/MM/YYYY, HH:MM - Author: Message
const LINE_RE =
  /^\s*(?:\[)?(\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)(?:\])?\s*[-–]?\s*([^:]+?):\s?(.*)$/;
export const WHATSAPP_ATTACHMENT_RE =
  /<attached: |<Media omitted>|image omitted|video omitted|audio omitted|document omitted/i;
const TXT_EXT_RE = /\.txt$/i;
export const ZIP_EXT_RE = /\.zip$/i;
const WHATSAPP_TITLE_PREFIX_RE = /^WhatsApp Chat - /;
const WHATSAPP_LINE_SPLIT_RE = /\r?\n/;
const WHATSAPP_EXPORT_PROBE_RE = /\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}.*(?:-|]).*?:/;
const basename = zipBasename;
const WHATSAPP_TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([APap][Mm]))?$/;

// WhatsApp .txt/.zip exports carry NO native, durable chat identifier at
// all — not in the file format, not in the filename (which the OS/WhatsApp
// itself mutate on re-export: "(1)" suffixes, date suffixes, to avoid
// overwriting). Every available signal is imperfect:
//   - filename: changes on every re-export, so it cannot be the id itself.
//   - participant set: the most stable content signal across re-exports of
//     THE SAME chat (date-range/history differences don't change who's in
//     it), but it is NOT a unique key — two different group chats can
//     legitimately share an identical member list (e.g. a group is left and
//     an unrelated new group is created with the same people), membership
//     can change over the chat's life (an export spanning a membership
//     change may show different participant sets for different date
//     windows of the SAME chat), and a export bounded to a narrower date
//     range than the full chat history could in principle omit a
//     participant who only spoke outside that window (WhatsApp's own export
//     is not known to truncate by date, but this module does not assume
//     that as a hard guarantee).
//
// Given no fact in the file is a defensible unique key, this module does
// NOT claim one. It derives a best-effort IDENTITY KEY (this function) from
// the strongest available signal (sorted participant set) -- but this key
// is a LOOKUP key, not the final chatId, and it is NOT assumed unique: two
// distinct chats can share an identical participant list. Resolving it to
// an actual chatId, and detecting (rather than silently merging) that
// same-participants-different-chat case, is index.ts's job -- see its
// chatIdentityCursor / openChatIdentityCursor doc comment for the full
// alias + content-overlap design. This module only guarantees: the SAME
// identityKey for the SAME participant set, deterministically, across any
// number of parses -- nothing about uniqueness. `deriveChatIdentityKey` is
// exported so index.ts's reconciliation layer and tests can reason about it
// directly.
const CHAT_ID_HASH_LENGTH = 16;
const MESSAGE_ID_HASH_LENGTH = 16;

/**
 * Best-effort identity LOOKUP key — NOT a claimed unique id (see the
 * module-level comment above). Two distinct chats with identical
 * participant sets produce the SAME identityKey; that is expected and
 * handled by index.ts's alias-based reconciliation cursor, which uses
 * message CONTENT overlap (not this key alone) to decide whether two
 * exports sharing a key are the same chat (reuse) or genuinely distinct
 * chats (kept separate, surfaced as ambiguous) — see
 * openChatIdentityCursor's doc comment for the full design. This function
 * only guarantees the key itself is deterministic for a given participant
 * set; it makes no uniqueness claim and must not be used as if it did.
 */
export function deriveChatIdentityKey(participants: readonly string[]): string {
  const key = [...participants].sort().join("");
  return createHash("sha256").update(key).digest("hex").slice(0, CHAT_ID_HASH_LENGTH);
}

/** Mint a fresh chatId for an identity key seen for the first time. Never
 *  called directly by parseWhatsAppChatFile — see index.ts's reconciliation
 *  cursor, which looks up an existing mapping before minting a new one. */
export function mintChatId(identityKey: string, salt: string): string {
  return createHash("sha256").update(`${identityKey}${salt}`).digest("hex").slice(0, CHAT_ID_HASH_LENGTH);
}

/**
 * Content-addressed message identity: hash of author+sent_at+content, NOT
 * array position. Index-based ids shift on any reordering or prepended
 * history in a re-export (common — WhatsApp exports aren't guaranteed
 * stable-ordered across exports), which makes the fingerprint cursor treat
 * unchanged messages as new. A duplicate consecutive message (same author,
 * same minute, same text) collides by design — see occurrenceIndex below,
 * which disambiguates true duplicates without reintroducing position-based
 * fragility for the common (non-duplicate) case.
 */
/**
 * The chat-independent content fingerprint used as BOTH the message id's
 * suffix (see deriveMessageId) AND, separately, the overlap-detection
 * signal the reconciliation-alias system (index.ts) uses to decide whether
 * two exports sharing an identityKey are the SAME chat (their message
 * fingerprints overlap) or two DISTINCT chats that merely share a
 * participant list (zero overlap). Exported so index.ts never needs to
 * recompute it or reach into message.id's string shape.
 */
export function messageContentFingerprint(
  message: Pick<ParsedWhatsAppMessage, "author" | "content" | "sent_at">,
  occurrenceIndex: number
): string {
  const key = `${message.author}${message.sent_at}${message.content}${occurrenceIndex}`;
  return createHash("sha256").update(key).digest("hex").slice(0, MESSAGE_ID_HASH_LENGTH);
}

function deriveMessageId(
  chatId: string,
  message: Pick<ParsedWhatsAppMessage, "author" | "content" | "sent_at">,
  occurrenceIndex: number
): string {
  return `${chatId}:${messageContentFingerprint(message, occurrenceIndex)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

function parseWhatsAppDateParts(dateStr: string): { day: number; month: number; year: number } | null {
  let separator = ".";
  if (dateStr.includes("/")) {
    separator = "/";
  } else if (dateStr.includes("-")) {
    separator = "-";
  }
  const parts = dateStr.split(separator);
  if (parts.length !== 3) {
    return null;
  }
  const [firstRaw, secondRaw, thirdRaw] = parts;
  const first = Number(firstRaw);
  const second = Number(secondRaw);
  const third = Number(thirdRaw);
  if (![first, second, third].every(Number.isInteger)) {
    return null;
  }

  let day: number;
  let month: number;
  let year: number;
  if ((firstRaw?.length ?? 0) === 4) {
    year = first;
    month = second;
    day = third;
  } else {
    year = third;
    if (third >= 70 && third < 100) {
      year = 1900 + third;
    } else if (third < 70) {
      year = 2000 + third;
    }
    if (first > 12 && second <= 12) {
      day = first;
      month = second;
    } else {
      month = first;
      day = second;
    }
  }

  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return { day, month, year };
}

function parseWhatsAppTimeParts(timeStr: string): { hour: number; minute: number; second: number } | null {
  const match = WHATSAPP_TIME_RE.exec(timeStr.trim());
  if (!match) {
    return null;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  const meridiem = match[4]?.toLowerCase();
  if (!(Number.isInteger(hour) && Number.isInteger(minute) && Number.isInteger(second))) {
    return null;
  }
  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    if (meridiem === "pm" && hour !== 12) {
      hour += 12;
    } else if (meridiem === "am" && hour === 12) {
      hour = 0;
    }
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null;
  }
  return { hour, minute, second };
}

export function parseWhatsAppDateTime(dateStr: string, timeStr: string): string | null {
  const dateParts = parseWhatsAppDateParts(dateStr);
  const timeParts = parseWhatsAppTimeParts(timeStr);
  if (!(dateParts && timeParts)) {
    return null;
  }
  const date = new Date(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    timeParts.hour,
    timeParts.minute,
    timeParts.second
  );
  if (
    date.getFullYear() === dateParts.year &&
    date.getMonth() === dateParts.month - 1 &&
    date.getDate() === dateParts.day &&
    date.getHours() === timeParts.hour &&
    date.getMinutes() === timeParts.minute &&
    date.getSeconds() === timeParts.second
  ) {
    return date.toISOString();
  }
  return null;
}

/** Splits an already-in-memory chat-text string (e.g. a zip's bounded
 *  chat.txt entry, already read once) into lines for the sync scan/stream
 *  APIs below. Only ever used against text already known to be bounded
 *  (MAX_CHAT_TEXT_BYTES or smaller) -- never against a raw .txt upload,
 *  which uses the async file-streamed APIs instead. */
export function splitWhatsAppChatLines(content: string): string[] {
  return content.split(WHATSAPP_LINE_SPLIT_RE);
}

export function whatsappChatTitleFromFilename(filename: string): string {
  return filename.replace(TXT_EXT_RE, "").replace(WHATSAPP_TITLE_PREFIX_RE, "");
}

export function looksLikeWhatsAppChatExport(text: string): boolean {
  return WHATSAPP_EXPORT_PROBE_RE.test(text);
}

export type WhatsAppChatArtifactFormat = "whatsapp_chat_export" | "whatsapp_chat_export_zip";

export interface ExtractedWhatsAppChatArtifact {
  chatFileName: string;
  format: WhatsAppChatArtifactFormat;
  mediaFileCount: number;
  mediaFiles: ParsedWhatsAppAttachment[];
  /**
   * Media entries present in the zip's central directory but withheld from
   * mediaFiles because extracting them would violate WHATSAPP_ZIP_POLICY
   * (oversized, or the shared decompression budget was exhausted). Nonzero
   * means real attachment coverage is missing from this parse — the caller
   * MUST surface this (see index.ts), not treat mediaFiles.length as the
   * true attachment count.
   */
  skippedMediaCount: number;
  text: string;
}

function isProbablyMediaEntry(name: string): boolean {
  const clean = name.replaceAll("\\", "/");
  if (!clean || clean.endsWith("/") || clean.startsWith("__MACOSX/") || clean.includes("/__MACOSX/")) {
    return false;
  }
  return !TXT_EXT_RE.test(clean);
}

/**
 * Thrown instead of returning null when the zip archive itself (not a media
 * entry inside it) violates WHATSAPP_ZIP_POLICY — e.g. too many entries, or
 * the shared decompression budget is exhausted before any chat text can even
 * be located. Distinguishes "this is a real export that's too large to
 * safely process" from extractWhatsAppChatArtifact returning null, which
 * means "this isn't a recognizable WhatsApp export at all." Callers
 * (validation.ts) MUST preserve this distinction — collapsing both into
 * "unsupported" hides an actionable signal from the owner.
 */
export class WhatsAppZipPolicyRejection extends Error {
  readonly code: InstanceType<typeof ZipPolicyViolationError>["code"];
  constructor(cause: InstanceType<typeof ZipPolicyViolationError>) {
    super(cause.message, { cause });
    this.name = "WhatsAppZipPolicyRejection";
    this.code = cause.code;
  }
}

/**
 * Builds the lazy media-attachment list from zip entries WITHOUT calling
 * `data()` on any of them. Whether a "media" entry is actually extractable
 * (not oversized, not corrupt) is only known once `data()` is called — a
 * caller that only wants the count (mediaFileCount) or is skipping
 * attachments entirely (e.g. the `attachments` stream was not requested)
 * never pays the inflation cost for entries it never reads.
 */
function lazyMediaFiles(entries: readonly ZipEntry[]): ParsedWhatsAppAttachment[] {
  return entries
    .filter((e) => isProbablyMediaEntry(e.name))
    .map((entry) => ({
      data: entry.data,
      filename: basename(entry.name),
    }));
}

function findChatTextEntry(
  entries: readonly ZipEntry[],
  mediaFiles: ParsedWhatsAppAttachment[]
): ExtractedWhatsAppChatArtifact | null {
  const textEntries = entries.filter((entry) => TXT_EXT_RE.test(entry.name));
  for (const entry of textEntries) {
    if (entry.uncompressedSize > MAX_CHAT_TEXT_BYTES) {
      // Declared size is untrusted for bomb defense (see
      // bounded-zip-archive.ts), but here it is only a fast-skip for an
      // implausible chat-text entry -- if it's a lying declaration, data()
      // below would still be bounded by the shared archive policy and would
      // simply fail this candidate the normal way.
      continue;
    }
    let text: string;
    try {
      text = entry.data().toString("utf8");
    } catch {
      continue;
    }
    if (looksLikeWhatsAppChatExport(text)) {
      return {
        chatFileName: basename(entry.name),
        format: "whatsapp_chat_export_zip",
        mediaFileCount: mediaFiles.length,
        mediaFiles,
        // skippedMediaCount is no longer knowable up front now that
        // attachment extraction is lazy — a media entry that will fail
        // policy/corruption checks only reveals that when its OWN data() is
        // called, which the caller (index.ts) does per-attachment during
        // emission. See emitAttachmentRecords' own skip accounting.
        skippedMediaCount: 0,
        text,
      };
    }
  }
  return null;
}

// Both the buffer-backed and file-backed entrypoints throw
// ZipPolicyViolationError the same way (their shared readZipEntries* core),
// so both funnel through this: convert that into WhatsAppZipPolicyRejection
// (a real export that tripped the policy — MUST propagate) and swallow any
// other error into `null` (not a zip this parser recognizes).
function extractEntriesOrNull(readEntries: () => ZipEntry[]): ZipEntry[] | null {
  try {
    return readEntries();
  } catch (err) {
    if (err instanceof ZipPolicyViolationError) {
      // biome-ignore lint/style/useErrorCause: cause IS passed — WhatsAppZipPolicyRejection's constructor forwards it via super(cause.message, { cause }); the linter doesn't see through the wrapper class.
      throw new WhatsAppZipPolicyRejection(err);
    }
    return null;
  }
}

function extractFromZip(bytes: Buffer): ExtractedWhatsAppChatArtifact | null {
  const entries = extractEntriesOrNull(() => readZipEntries(bytes, whatsappZipPolicy()));
  return entries ? findChatTextEntry(entries, lazyMediaFiles(entries)) : null;
}

/**
 * File-backed variant of {@link extractWhatsAppChatArtifact}'s zip path: the
 * archive is never buffered whole in memory. `fd` is caller-owned (this
 * function neither opens nor closes it). Use this for staged manual-upload
 * artifacts, where the archive already exists as a file on disk and there is
 * no reason to also hold it as a Buffer.
 */
export function extractWhatsAppChatArtifactFromFile(
  fd: number,
  fileSize: number
): ExtractedWhatsAppChatArtifact | null {
  const entries = extractEntriesOrNull(() => readZipEntriesFromFile(fd, fileSize, whatsappZipPolicy()));
  return entries ? findChatTextEntry(entries, lazyMediaFiles(entries)) : null;
}

export function extractWhatsAppChatArtifact(
  filename: string,
  input: Buffer | Uint8Array | string
): ExtractedWhatsAppChatArtifact | null {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (ZIP_EXT_RE.test(filename) || hasZipLocalFileSignature(bytes)) {
    return extractFromZip(bytes);
  }
  const text = bytes.toString("utf8");
  return looksLikeWhatsAppChatExport(text)
    ? {
        chatFileName: filename,
        format: "whatsapp_chat_export",
        mediaFileCount: 0,
        mediaFiles: [],
        skippedMediaCount: 0,
        text,
      }
    : null;
}

/**
 * A message with its `id` still unassigned -- `id` depends on the final,
 * reconciled chatId (see WhatsAppChatSummary.chatId's doc comment), which
 * is only known after a full pass has completed. Both streaming passes
 * (scanWhatsAppChatIdentity, streamWhatsAppChatMessages) drive the SAME
 * `RawWhatsAppLineReader` core so the message-boundary/continuation-line
 * logic is defined in exactly one place; only the per-message ACTION
 * differs (summarize vs. assign-id-and-emit).
 */
interface RawWhatsAppMessage {
  author: string;
  content: string;
  has_attachment: boolean;
  sent_at: string;
}

/**
 * Incremental line-consumption core: recognizes message boundaries
 * (timestamped lines) vs. continuation lines (folded into the current
 * message's content), and calls `onMessage` once a message is fully known
 * -- either because the NEXT timestamped line started (mid-stream) or EOF
 * was reached (finish). Holds at most ONE pending message at a time, plus
 * whatever bounded state `onMessage`'s caller chooses to keep across calls
 * -- never an array sized by message count. `onMessage` may throw (e.g.
 * WhatsAppMessageLimitExceededError); the reader does not catch it.
 */
class RawWhatsAppLineReader {
  private current: RawWhatsAppMessage | null = null;
  private readonly onMessage: (message: RawWhatsAppMessage) => void;
  readonly participants = new Set<string>();

  constructor(onMessage: (message: RawWhatsAppMessage) => void) {
    this.onMessage = onMessage;
  }

  pushLine(line: string): void {
    const match = LINE_RE.exec(line);
    // A line can match LINE_RE's shape yet carry an impossible date (31/02,
    // year < 1970). Stamping nowIso() there would date the message to the
    // run -- non-deterministic, and `sent_at` is the manifest's semantic-time
    // source. Fold it into the preceding message instead, exactly as a
    // non-matching continuation line: the text survives, no date is invented.
    const sentAt = match ? parseWhatsAppDateTime(match[1] ?? "", match[2] ?? "") : null;
    if (match && sentAt) {
      if (this.current) {
        this.onMessage(this.current);
      }
      const author = (match[3] ?? "").trim();
      this.participants.add(author);
      this.current = { author, content: match[4] || "", has_attachment: false, sent_at: sentAt };
    } else if (this.current && line.trim()) {
      this.current.content += `\n${line}`;
    }
  }

  finish(): void {
    if (this.current) {
      this.onMessage(this.current);
      this.current = null;
    }
  }
}

/** Reservoir sampling (Algorithm R): maintains a fixed-size UNIFORM RANDOM
 *  sample of an arbitrarily long stream, seen exactly once, without ever
 *  holding more than `capacity` items. Replaces the previous fixed-STRIDE
 *  sampling (evenly spaced indices across the full array), which required
 *  the full array to exist first (incompatible with streaming) and, per an
 *  independent review, could systematically miss a genuine overlap window
 *  narrower than the stride on a multi-million-message chat -- reservoir
 *  sampling has no such blind spot: every item seen so far has an equal
 *  probability of being in the final sample, regardless of where in the
 *  stream it appeared. */
class ReservoirSampler<T> {
  private seen = 0;
  private readonly items: T[] = [];
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(item: T): void {
    this.seen += 1;
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return;
    }
    const replaceIndex = Math.floor(Math.random() * this.seen);
    if (replaceIndex < this.capacity) {
      this.items[replaceIndex] = item;
    }
  }

  toArray(): T[] {
    return [...this.items];
  }
}

const MESSAGE_FINGERPRINT_SAMPLE_SIZE = 40;

/**
 * One-shot uniform-random sample of an already-in-memory (small) array down
 * to `capacity` items, via the same reservoir-sampling algorithm as the
 * streaming scanner above. Exported for index.ts's chat-identity
 * reconciliation cursor, which needs to re-sample a GROWN fingerprint set
 * (this run's sample plus a previously-persisted alias's sample, both
 * already <= MESSAGE_FINGERPRINT_SAMPLE_SIZE) back down to the cap -- using
 * the same unbiased algorithm here, not a fixed-stride shortcut, avoids
 * reintroducing the exact narrow-overlap-window blind spot the streaming
 * scanner's reservoir sampling was built to close.
 */
export function sampleUniform<T>(items: readonly T[], capacity: number): T[] {
  const sampler = new ReservoirSampler<T>(capacity);
  for (const item of items) {
    sampler.push(item);
  }
  return sampler.toArray();
}

/**
 * Pass 1 of 2: a single streaming read that determines chat identity and
 * summary aggregates WITHOUT holding every message in memory. Bounded
 * state only: a Set of participant names (realistically a few hundred
 * entries at most, even for a large group), a running min/max timestamp,
 * a few counters, and a fixed-size reservoir sample of message
 * fingerprints. The message-count policy cap (WhatsAppMessageLimitExceededError)
 * is enforced here too, since this pass already visits every message.
 *
 * Message ids assigned during this pass use the PROVISIONAL chatId (see
 * WhatsAppChatSummary.chatId) -- fine for fingerprinting (the fingerprint
 * itself does not depend on chatId), but the real per-message ids used for
 * actual record emission are assigned fresh in pass 2
 * (streamWhatsAppChatMessages), which is only ever driven with the FINAL,
 * reconciled chatId.
 */
/** Shared bounded-state accumulator for pass 1, driven by both the sync
 *  and async wrappers below so the aggregate-tracking logic (min/max
 *  timestamps, counters, reservoir sample) exists in exactly one place. */
class ChatIdentityAccumulator {
  private readonly maxMessageCount = resolveMaxMessageCount();
  private readonly occurrenceSeen = new Map<string, number>();
  private readonly fingerprintSampler = new ReservoirSampler<string>(MESSAGE_FINGERPRINT_SAMPLE_SIZE);
  private messageCount = 0;
  private attachmentMessageCount = 0;
  private firstSentAt: string | null = null;
  private lastSentAt: string | null = null;

  onMessage = (message: RawWhatsAppMessage): void => {
    this.messageCount += 1;
    if (this.messageCount > this.maxMessageCount) {
      throw new WhatsAppMessageLimitExceededError(this.messageCount, this.maxMessageCount);
    }
    if (WHATSAPP_ATTACHMENT_RE.test(message.content)) {
      this.attachmentMessageCount += 1;
    }
    if (this.firstSentAt === null || message.sent_at < this.firstSentAt) {
      this.firstSentAt = message.sent_at;
    }
    if (this.lastSentAt === null || message.sent_at > this.lastSentAt) {
      this.lastSentAt = message.sent_at;
    }
    const dedupeKey = `${message.author}${message.sent_at}${message.content}`;
    const occurrenceIndex = this.occurrenceSeen.get(dedupeKey) ?? 0;
    this.occurrenceSeen.set(dedupeKey, occurrenceIndex + 1);
    this.fingerprintSampler.push(messageContentFingerprint(message, occurrenceIndex));
  };

  toSummary(filename: string, participants: readonly string[]): WhatsAppChatSummary {
    const identityKey = deriveChatIdentityKey(participants);
    return {
      attachmentMessageCount: this.attachmentMessageCount,
      chatId: mintChatId(identityKey, ""),
      firstSentAt: this.firstSentAt,
      identityKey,
      lastSentAt: this.lastSentAt,
      messageCount: this.messageCount,
      messageFingerprintSample: this.fingerprintSampler.toArray(),
      participants: [...participants],
      title: whatsappChatTitleFromFilename(filename),
    };
  }
}

/**
 * Pass 1 of 2: a single streaming read that determines chat identity and
 * summary aggregates WITHOUT holding every message in memory. Bounded
 * state only (see ChatIdentityAccumulator): a Set of participant names
 * (realistically a few hundred entries at most, even for a large group), a
 * running min/max timestamp, a few counters, and a fixed-size reservoir
 * sample of message fingerprints. The message-count policy cap
 * (WhatsAppMessageLimitExceededError) is enforced here too, since this
 * pass already visits every message.
 *
 * Message ids assigned during this pass use the PROVISIONAL chatId (see
 * WhatsAppChatSummary.chatId) -- fine for fingerprinting (the fingerprint
 * itself does not depend on chatId), but the real per-message ids used for
 * actual record emission are assigned fresh in pass 2
 * (streamWhatsAppChatMessages), which is only ever driven with the FINAL,
 * reconciled chatId.
 */
export function scanWhatsAppChatIdentity(filename: string, lines: Iterable<string>): WhatsAppChatSummary {
  const accumulator = new ChatIdentityAccumulator();
  const reader = new RawWhatsAppLineReader(accumulator.onMessage);
  for (const line of lines) {
    reader.pushLine(line);
  }
  reader.finish();
  return accumulator.toSummary(filename, [...reader.participants]);
}

/**
 * Async-iterable variant of scanWhatsAppChatIdentity, for a file-backed
 * line source (e.g. node:readline over fs.createReadStream) instead of a
 * pre-materialized string's lines. Shares ChatIdentityAccumulator with the
 * sync variant above -- only the loop's iteration protocol differs.
 */
export async function scanWhatsAppChatIdentityStream(
  filename: string,
  lines: AsyncIterable<string>
): Promise<WhatsAppChatSummary> {
  const accumulator = new ChatIdentityAccumulator();
  const reader = new RawWhatsAppLineReader(accumulator.onMessage);
  for await (const line of lines) {
    reader.pushLine(line);
  }
  reader.finish();
  return accumulator.toSummary(filename, [...reader.participants]);
}

/**
 * Pass 2 of 2: re-streams the SAME chat text, now with the FINAL, already-
 * reconciled chatId (see WhatsAppChatSummary.chatId's doc comment), and
 * calls `onMessage` once per message with its real content-addressed id
 * assigned -- never materializing a message array. `onMessage` is called
 * synchronously in file order; a caller needing async work per message
 * (e.g. emitRecord) should await inside its own loop after collecting
 * each callback's message via a one-slot handoff, or use
 * streamWhatsAppChatMessagesAsync below.
 *
 * Re-enforces WHATSAPP_MAX_MESSAGE_COUNT independently of pass 1, mirroring
 * streamWhatsAppChatMessagesAsync's identical guard (see that function's
 * doc comment for why). Not on any production call path today (index.ts
 * only drives the async variant below) but kept in lockstep so a future
 * caller of this sync variant does not silently inherit an unbounded pass.
 */
export function streamWhatsAppChatMessages(
  lines: Iterable<string>,
  chatId: string,
  onMessage: (message: ParsedWhatsAppMessage) => void
): void {
  const maxMessageCount = resolveMaxMessageCount();
  let messageCount = 0;
  const occurrenceSeen = new Map<string, number>();
  const reader = new RawWhatsAppLineReader((raw) => {
    messageCount += 1;
    if (messageCount > maxMessageCount) {
      throw new WhatsAppMessageLimitExceededError(messageCount, maxMessageCount);
    }
    const hasAttachment = WHATSAPP_ATTACHMENT_RE.test(raw.content);
    const dedupeKey = `${raw.author}${raw.sent_at}${raw.content}`;
    const occurrenceIndex = occurrenceSeen.get(dedupeKey) ?? 0;
    occurrenceSeen.set(dedupeKey, occurrenceIndex + 1);
    onMessage({
      author: raw.author,
      content: raw.content,
      has_attachment: hasAttachment,
      id: deriveMessageId(chatId, raw, occurrenceIndex),
      sent_at: raw.sent_at,
    });
  });
  for (const line of lines) {
    reader.pushLine(line);
  }
  reader.finish();
}

/**
 * Async variant of streamWhatsAppChatMessages: `onMessage` may return a
 * Promise (e.g. to await emitRecord before the next message is parsed),
 * and is awaited in strict file order -- at most one message's emission is
 * ever in flight, which is what keeps this bounded rather than racing
 * ahead and buffering results.
 *
 * Re-enforces WHATSAPP_MAX_MESSAGE_COUNT independently of pass 1
 * (ChatIdentityAccumulator.onMessage). Pass 1 and pass 2 read the file
 * separately; normally that's harmless because pass 2 re-reads the exact
 * same already-validated bytes pass 1 scanned, but a caller whose two
 * passes are NOT provably reading the same content (e.g. a source that
 * changed between passes) would otherwise let pass 2's message count grow
 * unbounded with no policy backstop of its own -- a silent bypass of a cap
 * that is supposed to be memory-bounding, not merely a pass-1 formality.
 */
export async function streamWhatsAppChatMessagesAsync(
  lines: AsyncIterable<string> | Iterable<string>,
  chatId: string,
  onMessage: (message: ParsedWhatsAppMessage) => Promise<void> | void
): Promise<void> {
  const maxMessageCount = resolveMaxMessageCount();
  let messageCount = 0;
  const occurrenceSeen = new Map<string, number>();
  let pending: Promise<void> | void | undefined;
  const reader = new RawWhatsAppLineReader((raw) => {
    messageCount += 1;
    if (messageCount > maxMessageCount) {
      throw new WhatsAppMessageLimitExceededError(messageCount, maxMessageCount);
    }
    const hasAttachment = WHATSAPP_ATTACHMENT_RE.test(raw.content);
    const dedupeKey = `${raw.author}${raw.sent_at}${raw.content}`;
    const occurrenceIndex = occurrenceSeen.get(dedupeKey) ?? 0;
    occurrenceSeen.set(dedupeKey, occurrenceIndex + 1);
    pending = onMessage({
      author: raw.author,
      content: raw.content,
      has_attachment: hasAttachment,
      id: deriveMessageId(chatId, raw, occurrenceIndex),
      sent_at: raw.sent_at,
    });
  });
  for await (const line of lines) {
    reader.pushLine(line);
    // pushLine only calls onMessage when a NEW message boundary starts
    // (the just-finished message is what's pending) -- awaiting here, not
    // after the loop, is what keeps at most one emission in flight rather
    // than racing ahead through the whole file first.
    if (pending) {
      await pending;
      pending = undefined;
    }
  }
  reader.finish();
  if (pending) {
    await pending;
  }
}
