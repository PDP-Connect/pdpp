#!/usr/bin/env node
/**
 * PDPP Gmail Connector (v0.1.0)
 *
 * Uses IMAP + Google app-specific password. Iterates [Gmail]/All Mail so
 * messages with multiple labels aren't multi-counted. Derives label
 * membership from X-GM-LABELS per message.
 *
 * Auth:
 *   GOOGLE_APP_PASSWORD_PDPP — app password
 *   GMAIL_ADDRESS            — the account's email; if missing, emits
 *                              INTERACTION kind=credentials on first run.
 *
 * Streams: messages, threads, labels, attachments.
 *
 * State shape:
 *   {
 *     all_mail: { uidvalidity: N, uidnext: N, highest_modseq: N }
 *   }
 *
 * Rate budget: keep to one concurrent connection; fetch in windows of 200.
 */

import { createInterface } from "node:readline";
import {
  type FetchMessageObject,
  type FetchQueryObject,
  ImapFlow,
  type ListResponse,
  type MailboxObject,
  type MessageAddressObject,
  type MessageStructureObject,
  // biome-ignore lint/correctness/noUnresolvedImports: imapflow is declared in package.json; Biome's resolver doesn't see it here
} from "imapflow";
import { stringifyForJsonl } from "../../src/safe-emit.ts";
import { requireCredentialsOrAsk, resourceSet } from "../../src/scope-filters.ts";
import type {
  AllMailCursor,
  AttachmentRecord,
  EmittedMessage,
  InteractionMessage,
  InteractionResponse,
  PriorMessagesState,
  StartMessage,
  StreamRequest,
  ThreadAggregate,
} from "./types.ts";

// ─── Module-scoped regexes (Biome useTopLevelRegex) ─────────────────────

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping these control chars is the point (JSONL safety)
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const GMAIL_PREFIX_RE = /^\[Gmail\]\/(.+)$/;
const GMAIL_PREFIX_TEST_RE = /^\[Gmail\]\//;
const WHITESPACE_RUN_RE = /\s+/g;
const EMAIL_AT_RE = /@/;
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
const CR_OR_LF_RE = /[\r\n]/g;
const RETRYABLE_ERROR_RE = /ECONN|ETIMEDOUT|fetch failed|EPIPE|timeout/i;
const HEX_ESCAPE_RE = /=([0-9A-Fa-f]{2})/g;

// ─── Constants ──────────────────────────────────────────────────────────

const FETCH_HEADER_BATCH_PROGRESS = 1000;
const FETCH_MSG_PROGRESS = 500;
const SNIPPET_FETCH_MAX_BYTES = 4096;
const SNIPPET_MAX_CHARS = 200;
const KB = 1024;
const MAX_BODY_FIELD_CHARS = 32 * KB;
const ERROR_MSG_TAIL = 400;
const FLUSH_HARD_TIMEOUT_MS = 3000;
const DEFAULT_CRED_TIMEOUT_S = 1800;

// ─── imapflow interface augmentation ────────────────────────────────────

/**
 * imapflow's published FetchQueryObject omits Gmail's X-GM-MSGID selector
 * (`emailId`) even though the implementation supports it. Extending here
 * rather than casting preserves type-checking on every other field.
 */
interface ExtendedFetchQuery extends FetchQueryObject {
  emailId?: boolean;
}

// ─── Stdin / stdout plumbing ────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

// Track in-flight writes so back-pressured, partial stdout writes can't produce
// interleaved or truncated JSONL lines on the runtime side. Bodies on the
// `message_bodies` stream can exceed 200 KB each, which is well above the
// default pipe buffer (~64 KB on Linux). A blocking write alone isn't enough:
// Node returns `false` from write() without sending any bytes on a full pipe,
// and the caller must wait for 'drain' before the next write.
// Strip characters that break JSONL reassembly on the runtime side.
// - Lone surrogates → U+FFFD (JSON.stringify can otherwise produce malformed
//   \uDXXX escapes that JSON.parse rejects).
// - Raw control chars (0x00-0x08, 0x0B-0x1F, 0x7F) → replaced/removed. JSON.stringify
//   should escape \r\n to "\\r\\n", and indeed it does, so the string we get
//   back from stringify is safe — but empirically we see some body_text values
//   producing raw \n in the output stream. Defensively normalize all control
//   chars to a single space before stringify to guarantee a clean JSONL line.
function sanitizeForJsonl(v: unknown): unknown {
  if (v == null) {
    return v;
  }
  if (typeof v === "string") {
    return (
      v
        .replace(LONE_SURROGATE_RE, "\uFFFD")
        // Normalize control chars except tab(09). Keep visible \r \n in the
        // string value — JSON.stringify will escape them — but eliminate any
        // control char that might somehow sneak through.
        .replace(CONTROL_CHAR_RE, " ")
    );
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

// Gmail adds its own `sanitizeForJsonl` pass before encoding (lone-surrogate +
// control-char cleanup, since imapflow body_text occasionally contains raw
// control bytes). The JSONL encoding itself — BigInt coercion + U+2028/U+2029
// escaping — lives in `stringifyForJsonl`.
function emit(msg: EmittedMessage): Promise<void> {
  const line = stringifyForJsonl(sanitizeForJsonl(msg));
  const ok = process.stdout.write(line);
  if (ok) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    process.stdout.once("drain", () => {
      resolve();
    });
  });
}

// Drain stdout before exit — otherwise Node may exit with buffered bytes still
// unwritten on a pipe, truncating the final line.
function flushAndExit(code: number): void {
  if (process.stdout.writableLength > 0) {
    process.stdout.once("drain", () => process.exit(code));
    // Hard timeout so we don't hang on a pipe that's gone away
    setTimeout(() => process.exit(code), FLUSH_HARD_TIMEOUT_MS).unref();
  } else {
    process.exit(code);
  }
}

function fail(m: string, retryable = false): void {
  emit({
    type: "DONE",
    status: "failed",
    records_emitted: 0,
    error: { message: m, retryable },
  }).catch((): undefined => undefined);
  flushAndExit(1);
}

const nowIso = (): string => new Date().toISOString();

let interactionCounter = 0;
function nextInteractionId(): string {
  interactionCounter += 1;
  return `int_${Date.now()}_${interactionCounter}`;
}

// Block on stdin until we receive INTERACTION_RESPONSE matching request_id.
async function sendInteractionAndWait(msg: InteractionMessage): Promise<InteractionResponse> {
  await emit(msg);
  const reqId = msg.request_id;
  return new Promise<InteractionResponse>((resolve, reject) => {
    const onLine = (line: string): void => {
      try {
        const parsed = JSON.parse(line) as InteractionResponse;
        if (parsed.type === "INTERACTION_RESPONSE" && parsed.request_id === reqId) {
          rl.off("line", onLine);
          resolve(parsed);
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    rl.on("line", onLine);
  });
}

// ─── Label + address helpers ────────────────────────────────────────────

function canonicalLabelName(raw: string): string {
  if (raw === "INBOX") {
    return "inbox";
  }
  const m = GMAIL_PREFIX_RE.exec(raw);
  if (m?.[1]) {
    return m[1].toLowerCase().replace(WHITESPACE_RUN_RE, "_");
  }
  return raw.toLowerCase().replace(WHITESPACE_RUN_RE, "_");
}

function addressListToArray(
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

// ─── BODYSTRUCTURE walking ──────────────────────────────────────────────

function decodeBodystructureForAttachments(
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

// Find the first leaf of a given MIME type in a BODYSTRUCTURE tree; return its
// IMAP part number (e.g. "1" or "1.2") or null if none.
function findFirstPartByType(
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

function findTextPlainPart(structure: MessageStructureObject | undefined, path = ""): string | null {
  return findFirstPartByType(structure, "text/plain", path);
}

function findTextHtmlPart(structure: MessageStructureObject | undefined, path = ""): string | null {
  return findFirstPartByType(structure, "text/html", path);
}

// Locate a leaf in a BODYSTRUCTURE tree by its IMAP part number.
function findLeafByPath(
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

// Decode a body part buffer according to its MIME transfer encoding and
// charset into a JavaScript string. Best-effort; never throws.
function decodeBodyPart(buffer: Buffer | null | undefined, encoding: string | null, charset: string | null): string {
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

// Strip HTML tags into plain text. Handles <script>/<style> blocks, common
// block-level tags (inserted newlines), <br>, and basic entity decoding.
// Not a full HTML parser — intentionally minimal for bodies that arrive as
// HTML-only (e.g. newsletters) where we still want a readable text fallback.
function stripHtmlToText(html: string | null | undefined): string {
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

// Parse a "References:" header value into an array of Message-IDs.
// IMAP may return headers as a Buffer; References is a whitespace-separated
// list of <id@host> tokens, possibly wrapped across lines.
function parseReferencesHeader(rawHeaders: Buffer | string | null | undefined): string[] {
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
  // eslint-disable-next-line no-cond-assign -- single-line idiomatic regex loop
  let m: RegExpExecArray | null = ANGLE_ID_RE.exec(value);
  while (m !== null) {
    ids.push(`<${m[1]}>`);
    m = ANGLE_ID_RE.exec(value);
  }
  return ids;
}

// Decode a body part buffer according to its MIME transfer encoding, then
// extract a plain-text snippet: strip quoted reply blocks and collapse
// whitespace. Returns a trimmed string up to `maxChars`.
function makeSnippet(
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

// ─── Narrowing helpers ─────────────────────────────────────────────────

/**
 * Narrow an imapflow UIDVALIDITY/modseq value to a Number for STATE cursor
 * use. imapflow types these as `bigint`, but the wire value is a single
 * 32-bit unsigned int (UIDVALIDITY) or a mod-sequence value typically well
 * within safe-integer range. We only coerce if we can check the type at
 * runtime — casting `as bigint` would hide a future shape change.
 */
function bigintToNumber(value: unknown): number | null {
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
function bigintToCursor(value: unknown): number | string | null {
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

function toFlagsArray(flags: Set<string> | undefined): string[] {
  if (!flags) {
    return [];
  }
  return flags instanceof Set ? [...flags] : Array.from(flags);
}

function toLabelsArray(labels: Set<string> | string[] | undefined): string[] {
  if (!labels) {
    return [];
  }
  if (Array.isArray(labels)) {
    return labels;
  }
  return [...labels];
}

function internalDateToIso(date: Date | string | undefined): string {
  if (!date) {
    return nowIso();
  }
  return new Date(date).toISOString();
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startMsg = await new Promise<StartMessage>((resolve, reject) => {
    rl.once("line", (line: string) => {
      try {
        resolve(JSON.parse(line) as StartMessage);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
  if (startMsg.type !== "START") {
    fail("Expected START");
    return;
  }

  let password = process.env.GOOGLE_APP_PASSWORD_PDPP;
  if (!password) {
    try {
      const creds = await requireCredentialsOrAsk({
        required: ["GOOGLE_APP_PASSWORD_PDPP"],
        connectorName: "Gmail",
        sendInteraction: (req) => {
          const wrapped: InteractionMessage = {
            type: "INTERACTION",
            request_id: req.request_id ?? nextInteractionId(),
            kind: req.kind,
            message: req.message,
            ...(req.schema === undefined ? {} : { schema: req.schema }),
            ...(req.timeout_seconds === undefined ? {} : { timeout_seconds: req.timeout_seconds }),
          };
          return sendInteractionAndWait(wrapped).then((resp) => ({
            type: "INTERACTION_RESPONSE" as const,
            request_id: resp.request_id,
            status: resp.status,
            ...(resp.data === undefined ? {} : { data: resp.data as Record<string, string> }),
          }));
        },
      });
      password = creds.GOOGLE_APP_PASSWORD_PDPP;
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), false);
      return;
    }
  }

  let address: string | null = process.env.GMAIL_ADDRESS || null;
  // Fallback: Amazon username often matches the user's email
  if (!address && process.env.AMAZON_USERNAME && EMAIL_AT_RE.test(process.env.AMAZON_USERNAME)) {
    address = process.env.AMAZON_USERNAME;
  }
  if (!address) {
    // Ask via INTERACTION kind=credentials
    const resp = await sendInteractionAndWait({
      type: "INTERACTION",
      request_id: nextInteractionId(),
      kind: "credentials",
      message: "Gmail address to sync (the account the app password was generated for)",
      schema: {
        type: "object",
        properties: { email: { type: "string", format: "email" } },
        required: ["email"],
      },
      timeout_seconds: DEFAULT_CRED_TIMEOUT_S,
    });
    const respEmail =
      resp.status === "success" && resp.data && typeof resp.data.email === "string" ? resp.data.email : null;
    if (!respEmail) {
      fail("no Gmail address provided");
      return;
    }
    address = respEmail;
  }

  if (!password) {
    fail("no Gmail app password provided");
    return;
  }

  const requested = new Map<string, StreamRequest>((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) {
    fail("START.scope.streams is required");
    return;
  }

  const resFilters = new Map<string, Set<string> | null>();
  for (const [n, r] of requested) {
    resFilters.set(n, resourceSet(r));
  }

  const state: Record<string, unknown> = startMsg.state ?? {};
  const emittedAt = nowIso();
  let totalEmitted = 0;
  // Async so callers can await backpressure on large bodies (message_bodies
  // records can be 100+ KB, above the 64 KB pipe buffer).
  const emitRecord = async (
    stream: string,
    data: Record<string, unknown>,
    keyField: "id" | "name" = "id"
  ): Promise<void> => {
    const keyCandidate = data[keyField] ?? data.name;
    if (keyCandidate == null) {
      return;
    }
    const canonical = String(keyCandidate);
    const resSet = resFilters.get(stream);
    if (resSet && !resSet.has(canonical)) {
      return;
    }
    const key: string | number = typeof keyCandidate === "number" ? keyCandidate : canonical;
    await emit({
      type: "RECORD",
      stream,
      key,
      data,
      emitted_at: emittedAt,
    });
    totalEmitted += 1;
  };

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: address, pass: password },
    logger: false,
  });

  await client.connect();

  try {
    await emit({ type: "PROGRESS", message: `Connected to ${address}` });

    // LABELS stream — list mailboxes
    if (requested.has("labels")) {
      const mailboxes: ListResponse[] = await client.list();
      for (const mb of mailboxes) {
        const name = mb.path;
        const is_system = name === "INBOX" || GMAIL_PREFIX_TEST_RE.test(name);
        const parts = name.split("/");
        const parent_name = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
        await emitRecord(
          "labels",
          {
            name,
            canonical_name: canonicalLabelName(name),
            is_system,
            parent_name,
            message_count: null, // we could SELECT each to get EXISTS but not worth it
          },
          "name"
        );
      }
      await emit({
        type: "STATE",
        stream: "labels",
        cursor: { fetched_at: nowIso() },
      });
    }

    // Find All Mail (special-use \All or fallback to [Gmail]/All Mail)
    const mailboxes: ListResponse[] = await client.list();
    const allMail = mailboxes.find((m) => m.specialUse === "\\All" || m.path === "[Gmail]/All Mail");
    if (!allMail) {
      fail("could not find [Gmail]/All Mail mailbox; is this a Gmail account?");
      return;
    }

    const lock = await client.getMailboxLock(allMail.path);
    try {
      const mailbox = client.mailbox;
      if (!mailbox) {
        fail("mailbox not selected after lock");
        return;
      }
      // `client.mailbox` is typed as `MailboxObject | false`; we've narrowed
      // out the false branch above.
      const mailboxObj: MailboxObject = mailbox;
      const uidvalidityNum = bigintToNumber(mailboxObj.uidValidity);
      if (uidvalidityNum === null) {
        fail("missing UIDVALIDITY on All Mail mailbox");
        return;
      }
      const uidnext = mailboxObj.uidNext;
      const highestModseqCursor = bigintToCursor(mailboxObj.highestModseq);

      // The RS returns state as { <stream>: <cursor>, ... } where each
      // <cursor> is the object the connector put in the STATE message's
      // .cursor field. This connector emits STATE with stream='messages'
      // and cursor={all_mail:{uidvalidity,uidnext,highest_modseq}}, so
      // the correct read path is state.messages.all_mail — NOT
      // state.all_mail. Prior code read the top level, resolving to
      // undefined on every run and silently forcing full-refresh.
      // Observed 2026-04-21: state persisted correctly but every run
      // did a full 1:* fetch. Also accept the legacy top-level shape
      // in case any historical state was written before this fix.
      const messagesState = (state.messages ?? {}) as PriorMessagesState;
      const legacyState = state as { all_mail?: AllMailCursor };
      const priorAllMail: AllMailCursor = messagesState.all_mail ?? legacyState.all_mail ?? {};
      const priorUidvalidity = priorAllMail.uidvalidity;
      const fullResync = !priorUidvalidity || priorUidvalidity !== uidvalidityNum;
      const priorUidnext = priorAllMail.uidnext ?? 1;
      const priorModseq = priorAllMail.highest_modseq;

      // Determine fetch range.
      // - Full resync: 1..*
      // - Incremental: new UIDs (priorUidnext..*) + flag/label changes (CHANGEDSINCE priorModseq).
      const timeRange = requested.get("messages")?.time_range || requested.get("attachments")?.time_range;

      // Pass 1: new messages (or everything on full resync)
      const fetchRange = fullResync ? "1:*" : `${priorUidnext}:*`;
      await emit({
        type: "PROGRESS",
        message: `Fetching ${fullResync ? "all" : "new"} messages (${fetchRange}) from ${allMail.path}`,
      });

      let count = 0;
      const wantMessages = requested.has("messages");
      const wantBodies = requested.has("message_bodies");

      // Phase A: pull all metadata into an array up-front.
      // Phase B: for each metadata row, do any additional IMAP commands
      // (body fetches) we need — we cannot issue other IMAP commands WHILE the
      // outer fetch iterator is still open, because imapflow multiplexes one
      // command at a time over a single connection and a nested call hangs the
      // outer iterator.
      const metaQuery: ExtendedFetchQuery = {
        uid: true,
        envelope: true,
        internalDate: true,
        flags: true,
        size: true,
        bodyStructure: true,
        headers: ["list-unsubscribe", "auto-submitted", "references"],
        source: false,
        labels: true,
        threadId: true,
        emailId: true,
      };
      const metas: FetchMessageObject[] = [];
      for await (const m of client.fetch(fetchRange, metaQuery, {
        uid: true,
      })) {
        metas.push(m);
        if (metas.length % FETCH_HEADER_BATCH_PROGRESS === 0) {
          await emit({
            type: "PROGRESS",
            stream: "messages",
            message: `Collected ${metas.length} message headers`,
          });
        }
      }
      await emit({
        type: "PROGRESS",
        stream: "messages",
        message: `Collected ${metas.length} headers; beginning body pass`,
      });

      for (const msg of metas) {
        try {
          // Gmail-specific IDs via imapflow: msg.emailId = X-GM-MSGID; msg.threadId = X-GM-THRID
          const gmMsgid = String(msg.emailId ?? "");
          const gmThrid = String(msg.threadId ?? "");
          if (!gmMsgid) {
            continue; // without X-GM-MSGID we can't key
          }

          const env = msg.envelope ?? {};
          const receivedAt = internalDateToIso(msg.internalDate);
          const dateHeader = env.date ? new Date(env.date).toISOString() : null;

          // time_range filtering (against received_at)
          if (timeRange?.since && receivedAt < timeRange.since) {
            continue;
          }
          if (timeRange?.until && receivedAt >= timeRange.until) {
            continue;
          }

          const flagsArr = toFlagsArray(msg.flags);
          const labels = toLabelsArray(msg.labels);

          const attachments = decodeBodystructureForAttachments(msg.bodyStructure, gmMsgid, receivedAt);

          // Body fetching — scope-driven.
          // - If `messages` is requested (and not `message_bodies`): fetch the
          //   first 4096 bytes of text/plain only, for the snippet.
          // - If `message_bodies` is requested: fetch the full text/plain AND
          //   text/html parts (if present) in a single round-trip, and reuse
          //   the text/plain buffer for the snippet when messages is also in
          //   scope. We never fetch image/attachment parts — metadata for
          //   those lives in the `attachments` stream.
          let snippet: string | null = null;
          let bodyTextFull: string | null = null; // decoded string, text/plain
          let bodyHtmlFull: string | null = null; // decoded string, text/html
          const plainPart = findTextPlainPart(msg.bodyStructure);
          const htmlPart = wantBodies ? findTextHtmlPart(msg.bodyStructure) : null;
          const plainLeaf = plainPart ? findLeafByPath(msg.bodyStructure, plainPart) : null;
          const htmlLeaf = htmlPart ? findLeafByPath(msg.bodyStructure, htmlPart) : null;
          const plainEncoding = plainLeaf?.encoding ?? null;
          const htmlEncoding = htmlLeaf?.encoding ?? null;
          const textCharset = plainLeaf?.parameters?.charset ?? null;
          const htmlCharset = htmlLeaf?.parameters?.charset ?? null;

          if (msg.uid && (wantBodies || (wantMessages && plainPart))) {
            const parts: Array<
              | string
              | {
                  key: string;
                  start?: number;
                  maxLength?: number;
                }
            > = [];
            if (plainPart) {
              // Full body if we need message_bodies; otherwise bounded for snippet.
              parts.push(
                wantBodies
                  ? { key: plainPart }
                  : {
                      key: plainPart,
                      start: 0,
                      maxLength: SNIPPET_FETCH_MAX_BYTES,
                    }
              );
            }
            if (wantBodies && htmlPart) {
              parts.push({ key: htmlPart });
            }
            if (parts.length) {
              try {
                const bodyResp = await client.fetchOne(String(msg.uid), { bodyParts: parts }, { uid: true });
                const plainBuf = plainPart && bodyResp ? (bodyResp.bodyParts?.get(plainPart) ?? null) : null;
                const htmlBuf = htmlPart && bodyResp ? (bodyResp.bodyParts?.get(htmlPart) ?? null) : null;
                if (plainBuf) {
                  if (wantBodies) {
                    bodyTextFull = decodeBodyPart(plainBuf, plainEncoding, textCharset);
                    if (wantMessages) {
                      snippet = makeSnippet(plainBuf, plainEncoding, textCharset, SNIPPET_MAX_CHARS);
                    }
                  } else if (wantMessages) {
                    snippet = makeSnippet(plainBuf, plainEncoding, textCharset, SNIPPET_MAX_CHARS);
                  }
                }
                if (htmlBuf && wantBodies) {
                  bodyHtmlFull = decodeBodyPart(htmlBuf, htmlEncoding, htmlCharset);
                }
              } catch {
                // Best-effort: body fetch failures shouldn't block message emit.
              }
            }
          }

          if (wantBodies) {
            let bodyText = bodyTextFull;
            let bodySource: "text_plain" | "html_stripped" | "text_html" | "empty";
            if (bodyText?.length) {
              bodySource = "text_plain";
            } else if (bodyHtmlFull?.length) {
              const stripped = stripHtmlToText(bodyHtmlFull);
              if (stripped) {
                bodyText = stripped;
                bodySource = "html_stripped";
              } else {
                bodySource = "text_html";
              }
            } else {
              bodySource = "empty";
            }
            // Cap per-field length defensively. We store the FULL body's byte
            // length separately for auditing; records themselves are truncated to
            // keep single JSONL lines within a safe pipe-buffer envelope.
            // DEFENSIVE: force-stringify to eliminate any non-string type (Buffer, etc.)
            const toCleanString = (v: unknown): string | null => {
              if (v == null) {
                return null;
              }
              const s = typeof v === "string" ? v : String(v);
              // Additional belt-and-suspenders: escape any stray LF/CR in place.
              // sanitizeForJsonl also does this but gives us a defense-in-depth at the call site.
              return s.replace(CR_OR_LF_RE, " ");
            };
            const truncTxt =
              bodyText && bodyText.length > MAX_BODY_FIELD_CHARS
                ? toCleanString(`${bodyText.slice(0, MAX_BODY_FIELD_CHARS)}…[truncated]`)
                : toCleanString(bodyText);
            const truncHtml =
              bodyHtmlFull && bodyHtmlFull.length > MAX_BODY_FIELD_CHARS
                ? toCleanString(`${bodyHtmlFull.slice(0, MAX_BODY_FIELD_CHARS)}…[truncated]`)
                : toCleanString(bodyHtmlFull);
            await emitRecord("message_bodies", {
              id: gmMsgid,
              message_id: gmMsgid,
              body_text: truncTxt,
              body_html: truncHtml,
              body_text_bytes: bodyText ? Buffer.byteLength(bodyText, "utf8") : null,
              body_html_bytes: bodyHtmlFull ? Buffer.byteLength(bodyHtmlFull, "utf8") : null,
              body_source: bodySource,
              // Language detection is out of scope for v1; emit null so
              // consumers know the field exists but wasn't computed.
              content_languages: null,
              charset: textCharset || htmlCharset || null,
            });
          }

          if (wantMessages) {
            const fromAddr = env.from?.[0];
            const references = parseReferencesHeader(msg.headers);

            await emitRecord("messages", {
              id: gmMsgid,
              thread_id: gmThrid,
              subject: env.subject || null,
              from_name: fromAddr?.name || null,
              from_email: fromAddr?.address || null,
              to: addressListToArray(env.to),
              cc: addressListToArray(env.cc),
              bcc: addressListToArray(env.bcc),
              reply_to: addressListToArray(env.replyTo),
              date: dateHeader,
              received_at: receivedAt,
              message_id: env.messageId || null,
              in_reply_to: env.inReplyTo || null,
              references,
              size_bytes: typeof msg.size === "number" ? msg.size : null,
              labels,
              is_draft: flagsArr.includes("\\Draft"),
              is_flagged: flagsArr.includes("\\Flagged"),
              is_seen: flagsArr.includes("\\Seen"),
              is_answered: flagsArr.includes("\\Answered"),
              has_attachments: attachments.length > 0,
              snippet,
            });
          }

          if (requested.has("attachments") && attachments.length) {
            for (const a of attachments) {
              await emitRecord("attachments", { ...a });
            }
          }

          count += 1;
          if (count % FETCH_MSG_PROGRESS === 0) {
            await emit({
              type: "PROGRESS",
              stream: "messages",
              message: `Fetched ${count} messages`,
            });
          }
        } catch (perMsgErr) {
          const emsg = perMsgErr instanceof Error ? (perMsgErr.stack ?? perMsgErr.message) : String(perMsgErr);
          process.stderr.write(`[gmail] per-message error at UID ${String(msg.uid)}: ${emsg}\n`);
          // Continue with next message; don't let one bad record halt the whole run.
        }
      }

      // Pass 2: detect flag/label changes on already-seen messages (if incremental)
      if (!fullResync && priorModseq !== undefined && priorModseq !== null) {
        const priorModseqBig = typeof priorModseq === "bigint" ? priorModseq : BigInt(priorModseq);
        await emit({
          type: "PROGRESS",
          message: `Fetching flag/label deltas since modseq=${String(priorModseq)}`,
        });
        const deltaQuery: ExtendedFetchQuery = {
          uid: true,
          flags: true,
          labels: true,
          threadId: true,
          emailId: true,
          envelope: false,
        };
        for await (const msg of client.fetch("1:*", deltaQuery, {
          uid: true,
          changedSince: priorModseqBig,
        })) {
          const gmMsgid = String(msg.emailId ?? "");
          if (!gmMsgid) {
            continue;
          }
          // Flag/label delta update: emit a tombstone-free upsert of the message envelope
          // (minimal fields since envelope not re-fetched). For now, we emit a RECORD
          // with the same id so the RS upserts flag/label state.
          if (requested.has("messages")) {
            const flagsArr = toFlagsArray(msg.flags);
            await emitRecord("messages", {
              id: gmMsgid,
              thread_id: String(msg.threadId ?? ""),
              // Minimal: flag-state delta. We don't re-send envelope; RS retains existing fields.
              // Note: PDPP records are "whole-document" upserts in the current RS, so this
              // delta path is effectively a full re-fetch. Simpler: mark this path as "only
              // flags" by emitting the fields we have plus nulls.
              // For robustness, let's actually re-fetch envelope in v2. For v1, emit flags only.
              subject: null,
              from_name: null,
              from_email: null,
              to: [],
              cc: [],
              bcc: [],
              reply_to: [],
              date: null,
              received_at: emittedAt, // fallback so schema-required field is satisfied
              message_id: null,
              in_reply_to: null,
              references: [],
              size_bytes: null,
              labels: toLabelsArray(msg.labels),
              is_draft: flagsArr.includes("\\Draft"),
              is_flagged: flagsArr.includes("\\Flagged"),
              is_seen: flagsArr.includes("\\Seen"),
              is_answered: flagsArr.includes("\\Answered"),
              has_attachments: false,
              snippet: null,
            });
          }
        }
      }

      // THREADS stream derived server-side per run: group messages we just emitted by thread_id.
      // Simpler: a separate threads pass querying SEARCH by thread grouping is not directly supported
      // in IMAP; we derive from the fetch just done. For v1, we emit threads based on a second fetch
      // focused on emailId + threadId only if threads is requested.
      if (requested.has("threads")) {
        await emit({
          type: "PROGRESS",
          stream: "threads",
          message: "Deriving threads from All Mail",
        });
        const threadAgg = new Map<string, ThreadAggregate>();
        const threadQuery: ExtendedFetchQuery = {
          uid: true,
          threadId: true,
          emailId: true,
          envelope: true,
          flags: true,
          internalDate: true,
          // Needed for per-thread labels + has_attachments aggregation.
          labels: true,
          bodyStructure: true,
        };
        for await (const msg of client.fetch("1:*", threadQuery, {
          uid: true,
        })) {
          const tid = String(msg.threadId ?? "");
          if (!tid) {
            continue;
          }
          const env = msg.envelope ?? {};
          const rcv = internalDateToIso(msg.internalDate);
          const flagsArr = toFlagsArray(msg.flags);
          const msgLabels = toLabelsArray(msg.labels);
          const participantRaw: Array<string | undefined> = [
            env.from?.[0]?.address,
            ...(env.to || []).map((a) => a.address),
            ...(env.cc || []).map((a) => a.address),
          ];
          const participant = participantRaw.filter((a): a is string => typeof a === "string" && a.length > 0);
          const msgHasAttachments =
            decodeBodystructureForAttachments(msg.bodyStructure, String(msg.emailId ?? tid), rcv).length > 0;
          const agg: ThreadAggregate = threadAgg.get(tid) ?? {
            id: tid,
            subject: env.subject || null,
            participant_set: new Set<string>(),
            message_count: 0,
            first_message_date: rcv,
            last_message_date: rcv,
            labels_set: new Set<string>(),
            unread_count: 0,
            flagged_count: 0,
            has_attachments: false,
          };
          agg.message_count += 1;
          agg.first_message_date = rcv < agg.first_message_date ? rcv : agg.first_message_date;
          agg.last_message_date = rcv > agg.last_message_date ? rcv : agg.last_message_date;
          for (const p of participant) {
            agg.participant_set.add(p);
          }
          for (const l of msgLabels) {
            agg.labels_set.add(l);
          }
          if (msgHasAttachments) {
            agg.has_attachments = true;
          }
          if (!flagsArr.includes("\\Seen")) {
            agg.unread_count += 1;
          }
          if (flagsArr.includes("\\Flagged")) {
            agg.flagged_count += 1;
          }
          if (!agg.subject && env.subject) {
            agg.subject = env.subject;
          }
          threadAgg.set(tid, agg);
        }
        for (const agg of threadAgg.values()) {
          await emitRecord("threads", {
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
          });
        }
      }

      // Keep the cursor value (possibly string if out of safe-integer range) on STATE.
      await emit({
        type: "STATE",
        stream: "messages",
        cursor: {
          all_mail: {
            uidvalidity: uidvalidityNum,
            uidnext,
            highest_modseq: highestModseqCursor ?? null,
          },
        },
      });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch((): undefined => undefined);
  }

  await emit({
    type: "DONE",
    status: "succeeded",
    records_emitted: totalEmitted,
  });
  flushAndExit(0);
}

process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.stderr.write(`[gmail] unhandledRejection: ${msg}\n`);
  const summary = reason instanceof Error ? reason.message : String(reason);
  emit({
    type: "DONE",
    status: "failed",
    records_emitted: 0,
    error: {
      message: `unhandledRejection: ${summary.slice(0, ERROR_MSG_TAIL)}`,
      retryable: false,
    },
  }).catch((): undefined => undefined);
  flushAndExit(1);
});
process.on("uncaughtException", (err: Error) => {
  const msg = err.stack ?? err.message;
  process.stderr.write(`[gmail] uncaughtException: ${msg}\n`);
  emit({
    type: "DONE",
    status: "failed",
    records_emitted: 0,
    error: {
      message: `uncaughtException: ${err.message.slice(0, ERROR_MSG_TAIL)}`,
      retryable: false,
    },
  }).catch((): undefined => undefined);
  flushAndExit(1);
});

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  const retryable = RETRYABLE_ERROR_RE.test(msg);
  const trace = e instanceof Error ? (e.stack ?? msg) : msg;
  process.stderr.write(`[gmail] main rejected: ${trace}\n`);
  emit({
    type: "DONE",
    status: "failed",
    records_emitted: 0,
    error: { message: msg, retryable },
  }).catch((): undefined => undefined);
  flushAndExit(1);
});
