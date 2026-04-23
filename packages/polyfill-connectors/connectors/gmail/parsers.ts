// Pure parsers for the Gmail connector. Kept free of IMAP / Node I/O so
// they can be unit-tested in isolation. The IMAP client, its side effects,
// and clock-dependent helpers live in index.ts.

import type {
  MessageAddressObject,
  MessageStructureObject,
  // biome-ignore lint/correctness/noUnresolvedImports: imapflow is declared in package.json; Biome's resolver doesn't see it here
} from "imapflow";
import type { AttachmentRecord, ThreadAggregate } from "./types.ts";

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

// ─── Constants ──────────────────────────────────────────────────────────

export const SNIPPET_MAX_CHARS = 200;

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
    const disposition = node.disposition;
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
    const isAttachmentLike = disposition === "attachment" || disposition === "inline" || Boolean(filename);
    if (!isAttachmentLike) {
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
      is_inline: disposition === "inline",
      encoding: node.encoding || null,
      part_index: partIndex,
      message_received_at: receivedAt,
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
  return {
    id: agg.id,
    subject: agg.subject,
    participant_emails: [...agg.participant_set],
    message_count: agg.message_count,
    first_message_date: agg.first_message_date,
    last_message_date: agg.last_message_date,
    labels: [...agg.labels_set],
    unread_count: agg.unread_count,
    flagged_count: agg.flagged_count,
    has_attachments: agg.has_attachments,
  };
}
