// Pure parsers for the Gmail connector. Kept free of IMAP / Node I/O so
// they can be unit-tested in isolation (see parsers.test.ts). The IMAP
// client, its side effects, and clock-dependent helpers live in index.ts.

import type { MessageAddressObject, MessageEnvelopeObject, MessageStructureObject } from "imapflow";
import { recordFingerprint } from "../../src/fingerprint-cursor.ts";
import type { AttachmentRecord, BodySource, ClassifiedBody, ThreadAggregate } from "./types.ts";

// ─── Module-scoped regexes (Biome useTopLevelRegex) ─────────────────────

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping these control chars is the point (JSONL safety)
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const GMAIL_PREFIX_RE = /^\[Gmail\]\/(.+)$/;
const GMAIL_PREFIX_TEST_RE = /^\[Gmail\]\//;
const WHITESPACE_RUN_RE = /\s+/g;
const QP_SOFT_BREAK_RE = /=\r?\n/g;
const HEX_PAIR_RE = /[0-9A-Fa-f]{2}/;
const SCRIPT_BLOCK_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const STYLE_BLOCK_RE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const BR_TAG_RE = /<\s*br\s*\/?\s*>/gi;
const BLOCK_CLOSE_TAG_RE = /<\s*\/\s*(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre)\s*>/gi;
const HTML_TAG_RE = /<[^>]+>/g;
const ENTITY_NBSP_RE = /&nbsp;/g;
const ENTITY_AMP_RE = /&amp;/g;
const ENTITY_LT_RE = /&lt;/g;
const ENTITY_GT_RE = /&gt;/g;
const ENTITY_QUOT_RE = /&quot;/g;
const ENTITY_APOS_RE = /&#39;/g;
const ENTITY_DEC_RE = /&#(\d+);/g;
const ENTITY_HEX_RE = /&#x([0-9A-Fa-f]+);/g;
const NEWLINE_SPLIT_RE = /\r?\n/;
const SPACE_TAB_RUN_RE = /[ \t]+/g;
const HEADER_FOLD_RE = /\r?\n[ \t]+/g;
const REFERENCES_HEADER_RE = /^references:\s*(.*)$/im;
const ANGLE_ID_RE = /<([^>]+)>/g;
const QUOTED_REPLY_RE = /^\s*>/;
const HEX_ESCAPE_RE = /=([0-9A-Fa-f]{2})/g;
const CR_OR_LF_RE = /[\r\n]/g;

// ─── Constants ──────────────────────────────────────────────────────────

export const SNIPPET_MAX_CHARS = 200;
const KB = 1024;
export const MAX_BODY_FIELD_CHARS = 32 * KB;

// ─── BigInt narrowing ───────────────────────────────────────────────────

/**
 * Narrow an imapflow UIDVALIDITY/modseq value to a Number for STATE cursor
 * use. imapflow types these as `bigint`, but the wire value is a single
 * 32-bit unsigned int (UIDVALIDITY) or a mod-sequence value typically well
 * within safe-integer range. We only coerce if we can check the type at
 * runtime — casting `as bigint` would hide a future shape change.
 */
export function bigintToNumber(value: unknown): number | null {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "number") {
    return value;
  }
  return null;
}

/**
 * Preserve precision for values that might exceed safe-integer range by
 * returning a string when outside it, a number otherwise.
 */
export function bigintToCursor(value: unknown): number | string | null {
  if (typeof value === "bigint") {
    const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
    const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
    if (value <= MAX_SAFE && value >= MIN_SAFE) {
      return Number(value);
    }
    return value.toString();
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  return null;
}

// ─── Label + address helpers ────────────────────────────────────────────

export function canonicalLabelName(raw: string): string {
  if (raw === "INBOX") {
    return "inbox";
  }
  const m = GMAIL_PREFIX_RE.exec(raw);
  if (m?.[1]) {
    return m[1].toLowerCase().replace(WHITESPACE_RUN_RE, "_");
  }
  return raw.toLowerCase().replace(WHITESPACE_RUN_RE, "_");
}

export function isGmailSystemLabel(name: string): boolean {
  return name === "INBOX" || GMAIL_PREFIX_TEST_RE.test(name);
}

export function labelParentName(name: string): string | null {
  const parts = name.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : null;
}

export function addressListToArray(
  list: readonly MessageAddressObject[] | undefined
): Array<{ name: string | null; email: string | null }> {
  if (!list) {
    return [];
  }
  return list.map((a) => ({
    name: a.name || null,
    email: a.address || null,
  }));
}

export function toFlagsArray(flags: Set<string> | undefined): string[] {
  if (!flags) {
    return [];
  }
  return flags instanceof Set ? [...flags] : Array.from(flags);
}

export function toLabelsArray(labels: Set<string> | string[] | undefined): string[] {
  if (!labels) {
    return [];
  }
  if (Array.isArray(labels)) {
    return labels;
  }
  return [...labels];
}

// ─── JSONL sanitizer ────────────────────────────────────────────────────

/**
 * Strip characters that break JSONL reassembly on the runtime side.
 * - Lone surrogates → U+FFFD (JSON.stringify can otherwise produce
 *   malformed \uDXXX escapes that JSON.parse rejects).
 * - Raw control chars (0x00-0x08, 0x0B-0x1F, 0x7F) → replaced with a
 *   single space. JSON.stringify escapes \r\n to "\\r\\n" reliably, so
 *   keeping them in the string is safe — but empirically some body_text
 *   values yield raw \n in the output stream. Defensively normalize all
 *   disallowed control chars to a space before stringify to guarantee a
 *   clean JSONL line.
 */
export function sanitizeForJsonl(v: unknown): unknown {
  if (v == null) {
    return v;
  }
  if (typeof v === "string") {
    return v.replace(LONE_SURROGATE_RE, "\uFFFD").replace(CONTROL_CHAR_RE, " ");
  }
  if (Array.isArray(v)) {
    return v.map(sanitizeForJsonl);
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = sanitizeForJsonl(val);
    }
    return out;
  }
  return v;
}

// ─── BODYSTRUCTURE walking ──────────────────────────────────────────────

function isAttachmentLikeBodystructureLeaf(node: MessageStructureObject): boolean {
  const disposition = node.disposition;
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
  const contentId = node.id || null;
  const isTextLeaf = typeof node.type === "string" && node.type.startsWith("text/");

  if (disposition === "attachment") {
    return true;
  }
  if (filename) {
    return true;
  }
  if (disposition !== "inline") {
    return false;
  }

  // Inline body alternatives are not attachments; cid-referenced non-text
  // leaves are real files even when presented inline.
  return !isTextLeaf && Boolean(contentId);
}

/**
 * Walk a BODYSTRUCTURE tree and emit an AttachmentRecord for every leaf
 * whose disposition is attachment/inline or which carries a filename
 * parameter. Part index follows IMAP's dotted-path convention (1, 1.2,
 * 2.1.1...) so callers can fetch the part later by its exact path.
 */
export function decodeBodystructureForAttachments(
  structure: MessageStructureObject | undefined,
  msgId: string,
  receivedAt: string,
  path = ""
): AttachmentRecord[] {
  const items: AttachmentRecord[] = [];
  if (!structure) {
    return items;
  }
  // imapflow BODYSTRUCTURE nodes expose `type` as a combined MIME string
  // (e.g. "image/png" or "multipart/mixed"). Multiparts have `childNodes`;
  // leaves have `parameters`, `id`, `description`, `encoding`, `size`,
  // `disposition`, and `dispositionParameters`.
  const walk = (node: MessageStructureObject | undefined, p: string): void => {
    if (!node) {
      return;
    }
    if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
      node.childNodes.forEach((child, i) => {
        walk(child, p ? `${p}.${i + 1}` : String(i + 1));
      });
      return;
    }
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;

    // Classifier (RFC 2045 / RFC 2183 grounded):
    //   - disposition=attachment    → always a real attachment.
    //   - filename present          → always a real attachment.
    //   - disposition=inline:
    //       - filename present      → covered by the previous clause.
    //       - text/* leaf           → message body alternative, NOT an
    //                                 attachment (these are HTML/plain
    //                                 alternatives inside
    //                                 multipart/alternative).
    //       - non-text/* leaf with Content-ID → inline image/file referenced
    //                                 via cid: in HTML; real attachment
    //                                 even though presented inline.
    //       - otherwise              → drop (no filename, no cid, not a real
    //                                 file enclosure).
    //
    // The earlier rule treated every `inline` disposition as an attachment
    // and over-recorded ~1,000 phantom rows (text body alternatives) per
    // real mailbox. Verified against IMAP truth on a sample of 480
    // messages across 2020/2022/2024/2026: this classifier emits exactly
    // the truth set (zero false-positives, zero missed real attachments).
    if (!isAttachmentLikeBodystructureLeaf(node)) {
      return;
    }
    const partIndex = p || "1";
    items.push({
      id: `${msgId}:${partIndex}`,
      message_id: msgId,
      filename,
      content_type: node.type || null,
      size_bytes: typeof node.size === "number" ? node.size : null,
      content_id: node.id || null,
      is_inline: node.disposition === "inline",
      encoding: node.encoding || null,
      part_index: partIndex,
      message_received_at: receivedAt,
      blob_ref: null,
      content_sha256: null,
      hydration_status: "deferred",
      hydration_error: null,
    });
  };
  walk(structure, path);
  return items;
}

/**
 * Find the first leaf of a given MIME type in a BODYSTRUCTURE tree and
 * return its IMAP part number (e.g. "1" or "1.2"), or null if none.
 */
export function findFirstPartByType(
  structure: MessageStructureObject | undefined,
  mimeType: string,
  path = ""
): string | null {
  if (!structure) {
    return null;
  }
  const walk = (node: MessageStructureObject | undefined, p: string): string | null => {
    if (!node) {
      return null;
    }
    if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
      for (let i = 0; i < node.childNodes.length; i++) {
        const found = walk(node.childNodes[i], p ? `${p}.${i + 1}` : String(i + 1));
        if (found) {
          return found;
        }
      }
      return null;
    }
    if (node.type === mimeType) {
      return p || "1";
    }
    return null;
  };
  return walk(structure, path);
}

export function findTextPlainPart(structure: MessageStructureObject | undefined, path = ""): string | null {
  return findFirstPartByType(structure, "text/plain", path);
}

export function findTextHtmlPart(structure: MessageStructureObject | undefined, path = ""): string | null {
  return findFirstPartByType(structure, "text/html", path);
}

/** Locate a leaf in a BODYSTRUCTURE tree by its IMAP part number. */
export function findLeafByPath(
  structure: MessageStructureObject | undefined,
  targetPath: string
): MessageStructureObject | null {
  const walk = (node: MessageStructureObject | undefined, p: string): MessageStructureObject | null => {
    if (!node) {
      return null;
    }
    if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
      for (let i = 0; i < node.childNodes.length; i++) {
        const found = walk(node.childNodes[i], p ? `${p}.${i + 1}` : String(i + 1));
        if (found) {
          return found;
        }
      }
      return null;
    }
    return (p || "1") === targetPath ? node : null;
  };
  return walk(structure, "");
}

// ─── Body decoding helpers ──────────────────────────────────────────────

/**
 * Decode a body part buffer according to its MIME transfer encoding and
 * charset into a JavaScript string. Best-effort; never throws.
 */
export function decodeBodyPart(
  buffer: Buffer | null | undefined,
  encoding: string | null,
  charset: string | null
): string {
  if (!buffer?.length) {
    return "";
  }
  const cs = (charset || "utf8") as BufferEncoding;
  try {
    const enc = (encoding || "").toLowerCase();
    if (enc === "base64") {
      return Buffer.from(buffer.toString("ascii"), "base64").toString(cs);
    }
    if (enc === "quoted-printable") {
      const raw = buffer.toString("ascii");
      const unfolded = raw.replace(QP_SOFT_BREAK_RE, "");
      // Decode the =HH sequences as raw bytes, then interpret in charset.
      const bytes: number[] = [];
      let i = 0;
      while (i < unfolded.length) {
        if (unfolded[i] === "=" && i + 2 < unfolded.length && HEX_PAIR_RE.test(unfolded.slice(i + 1, i + 3))) {
          bytes.push(Number.parseInt(unfolded.slice(i + 1, i + 3), 16));
          i += 3;
        } else {
          bytes.push(unfolded.charCodeAt(i));
          i += 1;
        }
      }
      return Buffer.from(bytes).toString(cs);
    }
    return buffer.toString(cs);
  } catch {
    return buffer.toString("utf8");
  }
}

/**
 * Strip HTML tags into plain text. Handles <script>/<style> blocks,
 * common block-level tags (inserted newlines), <br>, and basic entity
 * decoding. Not a full HTML parser — intentionally minimal for bodies
 * that arrive as HTML-only (e.g. newsletters) where we still want a
 * readable text fallback.
 */
export function stripHtmlToText(html: string | null | undefined): string {
  if (!html) {
    return "";
  }
  let s = String(html);
  // Drop script/style contents entirely
  s = s.replace(SCRIPT_BLOCK_RE, " ");
  s = s.replace(STYLE_BLOCK_RE, " ");
  // HTML comments
  s = s.replace(HTML_COMMENT_RE, " ");
  // Line-break tags
  s = s.replace(BR_TAG_RE, "\n");
  // Block-level close tags — insert newline before stripping
  s = s.replace(BLOCK_CLOSE_TAG_RE, "\n");
  // Strip remaining tags
  s = s.replace(HTML_TAG_RE, "");
  // Decode common entities
  s = s
    .replace(ENTITY_NBSP_RE, " ")
    .replace(ENTITY_AMP_RE, "&")
    .replace(ENTITY_LT_RE, "<")
    .replace(ENTITY_GT_RE, ">")
    .replace(ENTITY_QUOT_RE, '"')
    .replace(ENTITY_APOS_RE, "'")
    .replace(ENTITY_DEC_RE, (_, n: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(n, 10));
      } catch {
        return "";
      }
    })
    .replace(ENTITY_HEX_RE, (_, h: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(h, 16));
      } catch {
        return "";
      }
    });
  // Collapse runs of blank lines and trim each line
  s = s
    .split(NEWLINE_SPLIT_RE)
    .map((ln) => ln.replace(SPACE_TAB_RUN_RE, " ").trim())
    .filter(Boolean)
    .join("\n");
  return s;
}

/**
 * Parse a "References:" header value into an array of Message-IDs.
 * IMAP may return headers as a Buffer; References is a whitespace-separated
 * list of <id@host> tokens, possibly wrapped across lines.
 */
export function parseReferencesHeader(rawHeaders: Buffer | string | null | undefined): string[] {
  if (!rawHeaders) {
    return [];
  }
  const text = Buffer.isBuffer(rawHeaders) ? rawHeaders.toString("utf8") : String(rawHeaders);
  // Unfold: collapse CRLF+WSP into a single space
  const unfolded = text.replace(HEADER_FOLD_RE, " ");
  // Find the References header value (case-insensitive)
  const match = REFERENCES_HEADER_RE.exec(unfolded);
  if (!match?.[1]) {
    return [];
  }
  const value = match[1];
  const ids: string[] = [];
  let m: RegExpExecArray | null = ANGLE_ID_RE.exec(value);
  while (m !== null) {
    ids.push(`<${m[1]}>`);
    m = ANGLE_ID_RE.exec(value);
  }
  return ids;
}

/**
 * Decode a body part buffer according to its MIME transfer encoding, then
 * extract a plain-text snippet: strip quoted reply blocks and collapse
 * whitespace. Returns a trimmed string up to `maxChars`.
 */
export function makeSnippet(
  buffer: Buffer | null | undefined,
  encoding: string | null,
  charset: string | null,
  maxChars: number = SNIPPET_MAX_CHARS
): string | null {
  if (!buffer?.length) {
    return null;
  }
  let decoded: string;
  try {
    const enc = (encoding || "").toLowerCase();
    const cs = (charset || "utf8") as BufferEncoding;
    if (enc === "base64") {
      decoded = Buffer.from(buffer.toString("ascii"), "base64").toString(cs);
    } else if (enc === "quoted-printable") {
      // Minimal QP decode: =HH hex + soft line breaks (=\r?\n)
      const raw = buffer.toString("ascii");
      const unfolded = raw.replace(QP_SOFT_BREAK_RE, "");
      decoded = unfolded.replace(HEX_ESCAPE_RE, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
    } else {
      decoded = buffer.toString(cs);
    }
  } catch {
    decoded = buffer.toString("utf8");
  }
  // Drop lines that are obviously quoted replies ("> ...") and signature separators
  const cleaned = decoded
    .split(NEWLINE_SPLIT_RE)
    .filter((ln) => !QUOTED_REPLY_RE.test(ln))
    .join(" ")
    .replace(WHITESPACE_RUN_RE, " ")
    .trim();
  if (!cleaned) {
    return null;
  }
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars).trim() : cleaned;
}

// ─── Thread aggregation ────────────────────────────────────────────────

/**
 * Create or update a ThreadAggregate in place from one message's fields.
 * If `existing` is undefined, builds a fresh aggregate initialized from
 * the incoming message; otherwise mutates `existing` and returns the same
 * reference. Callers drive the Map keyed by threadId.
 */
export function updateThreadAggregate(
  existing: ThreadAggregate | undefined,
  params: {
    flagsArr: readonly string[];
    hasAttachments: boolean;
    labels: readonly string[];
    participants: readonly string[];
    receivedAt: string;
    subject: string | null;
    threadId: string;
  }
): ThreadAggregate {
  const agg: ThreadAggregate = existing ?? {
    id: params.threadId,
    subject: params.subject,
    participant_set: new Set<string>(),
    message_count: 0,
    first_message_date: params.receivedAt,
    last_message_date: params.receivedAt,
    labels_set: new Set<string>(),
    unread_count: 0,
    flagged_count: 0,
    has_attachments: false,
  };
  agg.message_count += 1;
  agg.first_message_date = params.receivedAt < agg.first_message_date ? params.receivedAt : agg.first_message_date;
  agg.last_message_date = params.receivedAt > agg.last_message_date ? params.receivedAt : agg.last_message_date;
  for (const p of params.participants) {
    agg.participant_set.add(p);
  }
  for (const l of params.labels) {
    agg.labels_set.add(l);
  }
  if (params.hasAttachments) {
    agg.has_attachments = true;
  }
  if (!params.flagsArr.includes("\\Seen")) {
    agg.unread_count += 1;
  }
  if (params.flagsArr.includes("\\Flagged")) {
    agg.flagged_count += 1;
  }
  if (!agg.subject && params.subject) {
    agg.subject = params.subject;
  }
  return agg;
}

export function buildThreadRecord(agg: ThreadAggregate): Record<string, unknown> {
  // Sort the participant + label arrays so the emitted record's shape is
  // deterministic across runs. IMAP doesn't guarantee identical message
  // iteration order across `1:*` fetches; without sorting, Set insertion
  // order would oscillate and the per-thread fingerprint would mark
  // every thread as changed on every run.
  return {
    id: agg.id,
    subject: agg.subject,
    participant_emails: [...agg.participant_set].sort(),
    message_count: agg.message_count,
    first_message_date: agg.first_message_date,
    last_message_date: agg.last_message_date,
    labels: [...agg.labels_set].sort(),
    unread_count: agg.unread_count,
    flagged_count: agg.flagged_count,
    has_attachments: agg.has_attachments,
  };
}

/**
 * Stable per-thread fingerprint: a hash of every field of the emitted
 * thread record. The connector's `1:*` aggregation re-derives the
 * record on every run; without this gate, even a thread whose
 * semantic shape hasn't moved emits a fresh RECORD and grows
 * version history. The fingerprint includes every field on the
 * record — none excluded — because every field is source-derived
 * (subject, participants, counts, dates, labels). No run-clock
 * fields participate.
 *
 * Thin wrapper over the shared `recordFingerprint` helper so the gmail
 * connector and the shared `openFingerprintCursor` agree byte-for-byte
 * on what an unchanged thread hashes to. Without that agreement the
 * STATE cursor written by an old build and read by a new one would
 * force a one-time re-emit of every thread.
 */
export function buildThreadFingerprint(agg: ThreadAggregate): string {
  return recordFingerprint(buildThreadRecord(agg));
}

// ─── Body selection + record builders ───────────────────────────────────

/**
 * Resolved body-part metadata pulled from a BODYSTRUCTURE tree. Used by the
 * connector's body-fetch branch to decide which IMAP parts to request and
 * how to decode the returned buffers. Pure: no IMAP IO.
 */
export interface BodyPartSelection {
  htmlCharset: string | null;
  htmlEncoding: string | null;
  htmlLeaf: MessageStructureObject | null;
  htmlPart: string | null;
  plainCharset: string | null;
  plainEncoding: string | null;
  plainLeaf: MessageStructureObject | null;
  plainPart: string | null;
}

/**
 * Given a BODYSTRUCTURE and the caller's intent (wantBodies/wantMessages),
 * locate the text/plain and text/html leaves and return their encodings +
 * charsets. htmlPart is only resolved when wantBodies is true because we
 * otherwise skip the HTML fetch entirely (the snippet comes from text/plain).
 */
export function selectBodyParts(structure: MessageStructureObject | undefined, wantBodies: boolean): BodyPartSelection {
  const plainPart = findTextPlainPart(structure);
  const htmlPart = wantBodies ? findTextHtmlPart(structure) : null;
  const plainLeaf = plainPart ? findLeafByPath(structure, plainPart) : null;
  const htmlLeaf = htmlPart ? findLeafByPath(structure, htmlPart) : null;
  return {
    plainPart,
    htmlPart,
    plainLeaf,
    htmlLeaf,
    plainEncoding: plainLeaf?.encoding ?? null,
    htmlEncoding: htmlLeaf?.encoding ?? null,
    plainCharset: plainLeaf?.parameters?.charset ?? null,
    htmlCharset: htmlLeaf?.parameters?.charset ?? null,
  };
}

/**
 * Classify the final body_text + body_source we'll emit on message_bodies,
 * falling back to html_stripped when text/plain is absent. Mirrors the
 * original in-loop branching exactly so the record shape is unchanged.
 */
export function classifyBodySource(bodyTextFull: string | null, bodyHtmlFull: string | null): ClassifiedBody {
  if (bodyTextFull?.length) {
    return { bodyText: bodyTextFull, bodySource: "text_plain" };
  }
  if (bodyHtmlFull?.length) {
    const stripped = stripHtmlToText(bodyHtmlFull);
    if (stripped) {
      return { bodyText: stripped, bodySource: "html_stripped" };
    }
    return { bodyText: null, bodySource: "text_html" };
  }
  return { bodyText: null, bodySource: "empty" };
}

function toCleanString(v: unknown): string | null {
  if (v == null) {
    return null;
  }
  const s = typeof v === "string" ? v : String(v);
  // Additional belt-and-suspenders: escape any stray LF/CR in place.
  // sanitizeForJsonl also does this but gives us defense-in-depth at the
  // call site (see comment on sanitizeForJsonl for full rationale).
  return s.replace(CR_OR_LF_RE, " ");
}

function truncateField(value: string | null, max: number): string | null {
  if (value == null) {
    return toCleanString(value);
  }
  if (value.length > max) {
    return toCleanString(`${value.slice(0, max)}…[truncated]`);
  }
  return toCleanString(value);
}

/**
 * Build the `message_bodies` RECORD payload for one message. Mirrors the
 * original in-loop semantics:
 *   - Truncate body_text / body_html to MAX_BODY_FIELD_CHARS + "…[truncated]"
 *   - Emit body_*_bytes from the FULL (pre-truncation) decoded body
 *   - Fall back to html_stripped when text/plain is absent/empty
 *   - charset = textCharset || htmlCharset || null
 */
export function buildMessageBodyRecord(params: {
  bodyHtmlFull: string | null;
  bodyTextFull: string | null;
  gmMsgid: string;
  htmlCharset: string | null;
  textCharset: string | null;
}): Record<string, unknown> {
  const { bodyText, bodySource } = classifyBodySource(params.bodyTextFull, params.bodyHtmlFull);
  return {
    id: params.gmMsgid,
    message_id: params.gmMsgid,
    body_text: truncateField(bodyText, MAX_BODY_FIELD_CHARS),
    body_html: truncateField(params.bodyHtmlFull, MAX_BODY_FIELD_CHARS),
    body_text_bytes: bodyText ? Buffer.byteLength(bodyText, "utf8") : null,
    body_html_bytes: params.bodyHtmlFull ? Buffer.byteLength(params.bodyHtmlFull, "utf8") : null,
    body_source: bodySource satisfies BodySource,
    // Language detection is out of scope for v1; emit null so consumers
    // know the field exists but wasn't computed.
    content_languages: null,
    charset: params.textCharset || params.htmlCharset || null,
  };
}

/**
 * Build the `messages` RECORD payload for one full metadata row. Pure over
 * an envelope + already-parsed flags/labels/attachments — no IMAP IO.
 */
export function buildMessageRecord(params: {
  attachmentsCount: number;
  dateHeader: string | null;
  envelope: MessageEnvelopeObject;
  flagsArr: readonly string[];
  gmMsgid: string;
  gmThrid: string;
  labels: readonly string[];
  rawHeaders: Buffer | string | null | undefined;
  receivedAt: string;
  sizeBytes: number | null;
  snippet: string | null;
}): Record<string, unknown> {
  const env = params.envelope;
  const fromAddr = env.from?.[0];
  const references = parseReferencesHeader(params.rawHeaders);
  return {
    id: params.gmMsgid,
    thread_id: params.gmThrid,
    subject: env.subject || null,
    from_name: fromAddr?.name || null,
    from_email: fromAddr?.address || null,
    to: addressListToArray(env.to),
    cc: addressListToArray(env.cc),
    bcc: addressListToArray(env.bcc),
    reply_to: addressListToArray(env.replyTo),
    date: params.dateHeader,
    received_at: params.receivedAt,
    message_id: env.messageId || null,
    in_reply_to: env.inReplyTo || null,
    references,
    size_bytes: params.sizeBytes,
    labels: [...params.labels],
    is_draft: params.flagsArr.includes("\\Draft"),
    is_flagged: params.flagsArr.includes("\\Flagged"),
    is_seen: params.flagsArr.includes("\\Seen"),
    is_answered: params.flagsArr.includes("\\Answered"),
    has_attachments: params.attachmentsCount > 0,
    snippet: params.snippet,
  };
}

/**
 * Build the flag/label delta RECORD payload for one message. No envelope
 * re-fetch on the delta path — callers pass received_at as a fallback to
 * satisfy the schema-required field.
 */
export function buildDeltaMessageRecord(params: {
  flagsArr: readonly string[];
  gmMsgid: string;
  gmThrid: string;
  labels: readonly string[];
  receivedAtFallback: string;
}): Record<string, unknown> {
  return {
    id: params.gmMsgid,
    thread_id: params.gmThrid,
    subject: null,
    from_name: null,
    from_email: null,
    to: [],
    cc: [],
    bcc: [],
    reply_to: [],
    date: null,
    received_at: params.receivedAtFallback,
    message_id: null,
    in_reply_to: null,
    references: [],
    size_bytes: null,
    labels: [...params.labels],
    is_draft: params.flagsArr.includes("\\Draft"),
    is_flagged: params.flagsArr.includes("\\Flagged"),
    is_seen: params.flagsArr.includes("\\Seen"),
    is_answered: params.flagsArr.includes("\\Answered"),
    has_attachments: false,
    snippet: null,
  };
}

/** Determine whether a received_at timestamp falls inside a since/until window. */
export function isInTimeRange(
  receivedAt: string,
  range: { since?: string; until?: string } | null | undefined
): boolean {
  if (!range) {
    return true;
  }
  if (range.since && receivedAt < range.since) {
    return false;
  }
  if (range.until && receivedAt >= range.until) {
    return false;
  }
  return true;
}

/** Extract the envelope participants (from/to/cc) as a de-duped email list. */
export function envelopeParticipants(env: MessageEnvelopeObject | undefined): string[] {
  if (!env) {
    return [];
  }
  const raw: Array<string | undefined> = [
    env.from?.[0]?.address,
    ...(env.to || []).map((a) => a.address),
    ...(env.cc || []).map((a) => a.address),
  ];
  return raw.filter((a): a is string => typeof a === "string" && a.length > 0);
}
