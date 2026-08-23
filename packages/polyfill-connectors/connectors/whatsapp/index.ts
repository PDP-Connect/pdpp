#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP WhatsApp Connector (v0.1.0)
 *
 * Auth: none (file-based). User exports chats from the WhatsApp app
 * ("Chat" → menu → Export Chat → With or Without Media) and drops .txt
 * files or WhatsApp export .zip files into WHATSAPP_EXPORT_DIR.
 *
 * Uses the community-standard WhatsApp chat-export format. We parse
 * directly (no external dep for v1) — supports iPhone + Android formats.
 *
 * WHATSAPP_EXPORT_DIR defaults to ~/.pdpp/imports/whatsapp/
 */

import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, fstatSync, openSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import {
  buildDetailCoverageMessage,
  type EmittedMessage,
  type ProgressExtra,
  runConnector,
} from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import {
  makeReferenceBlobUploader,
  type ReferenceBlobRef,
  runtimeBlobUploadAvailable,
} from "../../src/reference-blob-uploader.ts";
import {
  extractWhatsAppChatArtifactFromFile,
  looksLikeWhatsAppChatExport,
  mintChatId,
  nowIso,
  type ParsedWhatsAppAttachment,
  type ParsedWhatsAppMessage,
  sampleUniform,
  scanWhatsAppChatIdentity,
  scanWhatsAppChatIdentityStream,
  splitWhatsAppChatLines,
  streamWhatsAppChatMessagesAsync,
  type WhatsAppChatSummary,
  WhatsAppMessageLimitExceededError,
  WhatsAppZipPolicyRejection,
  ZIP_EXT_RE,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

// ─── Fingerprinted record emission ───────────────────────────────────────────

type EmitRecord = (stream: string, record: Record<string, unknown>) => Promise<void>;
type EmitEvent = (event: EmittedMessage) => Promise<void>;
type EmitProgress = (message: string, extra?: ProgressExtra) => Promise<void>;
type FingerprintCursor = ReturnType<typeof openFingerprintCursor>;
interface RequestedStreams {
  has: (stream: string) => boolean;
}
interface WhatsAppCursors {
  attachments: FingerprintCursor;
  chats: FingerprintCursor;
  messages: FingerprintCursor;
}
const SUPPORTED_EXPORT_EXTENSIONS = [".txt", ".zip"] as const;
const MAX_DISCOVERY_DEPTH = 3;
const MAX_DISCOVERY_ENTRIES = 10_000;
const MESSAGE_PROGRESS_INTERVAL = 500;
const ATTACHMENT_PROGRESS_INTERVAL = 25;
const STREAM_PRIORITY = ["chats", "messages", "attachments"] as const;

function isSupportedExportFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return SUPPORTED_EXPORT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function contentTypeForFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".mp4")) {
    return "video/mp4";
  }
  if (lower.endsWith(".mov")) {
    return "video/quicktime";
  }
  if (lower.endsWith(".mp3")) {
    return "audio/mpeg";
  }
  if (lower.endsWith(".m4a")) {
    return "audio/mp4";
  }
  if (lower.endsWith(".ogg") || lower.endsWith(".opus")) {
    return "audio/ogg";
  }
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  return "application/octet-stream";
}

function firstRequestedStream(requested: RequestedStreams): string {
  return STREAM_PRIORITY.find((stream) => requested.has(stream)) ?? "chats";
}

function uploadBlob(args: {
  bytes: Buffer;
  connectorId: string;
  mimeType: string;
  recordKey: string;
  stream: string;
}): Promise<ReferenceBlobRef | null> {
  const rsUrl = process.env.PDPP_RS_URL || process.env.RS_URL;
  const ownerToken = process.env.PDPP_OWNER_TOKEN;
  if (!(runtimeBlobUploadAvailable(process.env) && rsUrl && ownerToken)) {
    return Promise.resolve(null);
  }
  const uploader = makeReferenceBlobUploader({
    connectorInstanceId: process.env.PDPP_CONNECTOR_INSTANCE_ID || null,
    ownerToken,
    rsUrl,
  });
  return uploader({
    connectorId: args.connectorId,
    content: [args.bytes],
    mimeType: args.mimeType,
    recordKey: args.recordKey,
    stream: args.stream,
  });
}

async function discoverExportFiles(importDir: string): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DISCOVERY_DEPTH || visited >= MAX_DISCOVERY_ENTRIES) {
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_DISCOVERY_ENTRIES) {
        return;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (entry.isFile() && isSupportedExportFile(entry.name)) {
        found.push(path);
      }
    }
  }
  await walk(importDir, 0);
  return [...new Set(found)].sort();
}

async function emitChatRecord(
  summary: WhatsAppChatSummary,
  chatsCursor: FingerprintCursor,
  emitRecord: EmitRecord
): Promise<void> {
  const record = {
    id: summary.chatId,
    title: summary.title,
    participants: summary.participants,
    message_count: summary.messageCount,
    first_message_date: summary.firstSentAt,
    last_message_date: summary.lastSentAt,
  };
  if (chatsCursor.shouldEmit(record)) {
    await emitRecord("chats", record);
  }
}

/**
 * Attachment records need to link back to the message that referenced them
 * (see findAttachmentMessageId's prior array-scan design) -- but a message
 * corpus is no longer materialized. Instead this index is built INLINE
 * during the same pass-2 message stream that emits message records: for
 * every message flagged has_attachment (a small subset of a real chat, not
 * every message), check it against the small list of attachment filenames
 * this export actually has and record the match. Bounded by
 * attachment-mentioning-message-count x attachment-count, not by total
 * message count.
 */
class AttachmentMessageLinkIndex {
  private readonly byFilenameLower = new Map<string, string>();
  private readonly attachmentFilenamesLower: string[];

  constructor(attachments: readonly ParsedWhatsAppAttachment[]) {
    this.attachmentFilenamesLower = attachments.map((a) => a.filename.toLowerCase());
  }

  observe(message: ParsedWhatsAppMessage): void {
    if (!message.has_attachment || this.attachmentFilenamesLower.length === 0) {
      return;
    }
    const contentLower = message.content.toLowerCase();
    for (const filenameLower of this.attachmentFilenamesLower) {
      if (!this.byFilenameLower.has(filenameLower) && contentLower.includes(filenameLower)) {
        this.byFilenameLower.set(filenameLower, message.id);
      }
    }
  }

  messageIdFor(filename: string): string | null {
    return this.byFilenameLower.get(filename.toLowerCase()) ?? null;
  }
}

interface MessageStreamSummary {
  attachmentLinkIndex: AttachmentMessageLinkIndex;
  emitted: number;
  processed: number;
}

/**
 * Pass 2's message emission: streams the chat's lines a second time (a
 * fresh read, not the pass-1 array) with the FINAL resolved chatId, and
 * emits one message record at a time -- at most one message's worth of
 * state (plus the bounded attachment-link index) is ever in memory.
 */
async function emitMessageRecords(
  chatId: string,
  lines: AsyncIterable<string> | Iterable<string>,
  attachments: readonly ParsedWhatsAppAttachment[],
  requestMessages: boolean,
  messagesCursor: FingerprintCursor,
  emitRecord: EmitRecord,
  progress: EmitProgress,
  exportOrdinal: number,
  exportTotal: number
): Promise<MessageStreamSummary> {
  let emitted = 0;
  let processed = 0;
  const attachmentLinkIndex = new AttachmentMessageLinkIndex(attachments);

  await streamWhatsAppChatMessagesAsync(lines, chatId, async (m) => {
    attachmentLinkIndex.observe(m);
    processed += 1;
    if (requestMessages) {
      const record = {
        id: m.id,
        chat_id: chatId,
        author: m.author,
        content: m.content,
        has_attachment: !!m.has_attachment,
        sent_at: m.sent_at,
      };
      if (messagesCursor.shouldEmit(record)) {
        await emitRecord("messages", record);
        emitted += 1;
      }
    }
    if (processed % MESSAGE_PROGRESS_INTERVAL === 0) {
      await progress(`Processed ${processed} WhatsApp messages from export ${exportOrdinal} of ${exportTotal}.`, {
        count: processed,
        stream: "messages",
        total: processed,
      });
    }
  });

  // Streaming means the TOTAL message count is only known once the stream
  // ends (unlike the old array-based design, which knew it upfront) -- a
  // final tick here guarantees a "count === total" completion signal even
  // when `processed` doesn't land on MESSAGE_PROGRESS_INTERVAL, matching
  // the pre-streaming contract's guaranteed last-tick-at-100%.
  if (processed % MESSAGE_PROGRESS_INTERVAL !== 0) {
    await progress(
      `Processed ${processed} of ${processed} WhatsApp messages from export ${exportOrdinal} of ${exportTotal}.`,
      {
        count: processed,
        stream: "messages",
        total: processed,
      }
    );
  }

  return { attachmentLinkIndex, emitted, processed };
}

/**
 * A successfully-recognized export, ready for two-pass processing.
 * `linesForPass` returns a FRESH line source each call -- pass 1
 * (identity scan) and pass 2 (message emission) each call it once, so
 * neither pass depends on the other having buffered anything. For the zip
 * path this just re-splits the already-in-memory (MAX_CHAT_TEXT_BYTES-
 * bounded) chat text; for the .txt path it opens a fresh
 * createReadStream/readline pair over the file.
 */
interface ParsedExportSource {
  attachments: readonly ParsedWhatsAppAttachment[];
  /** Caller MUST call this once done consuming `attachments` (each
   *  attachment's `data()` reads lazily from the underlying fd — closing it
   *  before every attachment has been read would make those data() calls
   *  fail). Safe to call even if no attachments were ever read; a no-op for
   *  the .txt path, which never keeps an fd open across the return. */
  closeSource: () => void;
  fileTitle: string;
  linesForPass: () => AsyncIterable<string> | Iterable<string>;
}

/**
 * Zip path: the archive is read via a file descriptor and
 * extractWhatsAppChatArtifactFromFile (bounded-zip-archive.ts's file-backed
 * reader) -- the archive's bytes are never buffered whole. The chat .txt
 * entry found inside is bounded to MAX_CHAT_TEXT_BYTES (parsers.ts) before
 * being materialized as one string; media attachments are returned lazily
 * (data() per entry, read one at a time during emission -- see
 * emitAttachmentRecords) and never held all at once.
 *
 * Opens a file descriptor for the zip and keeps it open across the return —
 * `artifact.mediaFiles[i].data()` (bounded-zip-archive.ts's lazy ZipEntry
 * accessor) reads from this SAME fd on demand, later, during attachment
 * emission. Closing the fd here (before every attachment has actually been
 * read) would make every data() call fail. `closeSource` is the caller's
 * signal to close it once attachment consumption for this export is fully
 * done.
 */
async function parseZipExportFile(
  fileName: string,
  emit: EmitEvent,
  exportOrdinal: number,
  exportTotal: number,
  skipStream: string
): Promise<{ closeSource: () => void; source: ParsedExportSource | null }> {
  const fileSize = statSync(fileName).size;
  const fd = openSync(fileName, "r");
  const closeSource = () => closeSync(fd);
  let artifact: ReturnType<typeof extractWhatsAppChatArtifactFromFile>;
  try {
    artifact = extractWhatsAppChatArtifactFromFile(fd, fileSize);
  } catch (err) {
    if (err instanceof WhatsAppZipPolicyRejection) {
      closeSource();
      await emit({
        message: `Skipped WhatsApp export ${exportOrdinal} of ${exportTotal}: exceeds the safe archive read policy (${err.message}).`,
        reason: "import_exceeds_bounded_read_policy",
        stream: skipStream,
        type: "SKIP_RESULT",
      });
      return { closeSource: () => undefined, source: null };
    }
    closeSource();
    throw err;
  }
  if (!artifact) {
    closeSource();
    await emit({
      message: `Skipped WhatsApp export ${exportOrdinal} of ${exportTotal}: not a supported chat export.`,
      reason: "unsupported_export",
      stream: skipStream,
      type: "SKIP_RESULT",
    });
    return { closeSource: () => undefined, source: null };
  }
  return {
    closeSource,
    source: {
      attachments: artifact.mediaFiles,
      closeSource,
      fileTitle: artifact.chatFileName,
      linesForPass: () => splitWhatsAppChatLines(artifact.text),
    },
  };
}

type TxtParseOutcome =
  | { kind: "empty" }
  | { kind: "parsed"; source: ParsedExportSource; summary: WhatsAppChatSummary }
  | { kind: "too_large"; reason: string }
  | { kind: "unsupported" };

/**
 * Reads from a PINNED file descriptor, not a fresh path-based open. Pass 1
 * and pass 2 both call this against the SAME fd (opened once in
 * `parseTxtExportFile` and kept open for the export's whole lifetime, like
 * the zip path's `closeSource` fd) with an explicit `start: 0` so each call
 * independently reads the file from the beginning without depending on the
 * fd's OS-level cursor position left over from a prior read. Because both
 * passes read through one fd tied to one inode, there is no second
 * path-based lookup left to race: a concurrent rename/replace of the
 * staging path between passes cannot swap which file pass 2 reads (that
 * inode is already open), and `identitySnapshot`'s (size, mtimeMs) pin
 * (checked by the caller against a second fstat right before pass 2) closes
 * the remaining window where the SAME inode is mutated in place between
 * passes.
 */
function pinnedFdLines(fd: number): AsyncIterable<string> {
  const stream = createReadStream("", { autoClose: false, encoding: "utf8", fd, start: 0 });
  return createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: stream });
}

interface TxtFileIdentity {
  readonly mtimeMs: number;
  readonly size: number;
}

function txtFileIdentitySnapshot(fd: number): TxtFileIdentity {
  const stat = fstatSync(fd);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

class TxtArtifactChangedError extends Error {
  constructor(fileName: string) {
    super(
      `WhatsApp export "${basename(fileName)}" changed on disk between the identity scan and message emission passes; refusing to emit against inconsistent content.`
    );
    this.name = "TxtArtifactChangedError";
  }
}

/**
 * Test-only, opt-in synchronous barrier between pass 1 finishing and pass 2's
 * identity re-check. The test observes the ready marker, rewrites the staged
 * file, and creates the release marker. This makes the mutation land at the
 * exact boundary rather than guessing subprocess startup time. No-op in
 * production (PDPP_TEST_TXT_TOCTOU_BARRIER_DIR unset). Blocking (Atomics.wait),
 * not async, because `linesForPass` is a synchronous call in the production
 * API (mirrored by the zip path's sync `splitWhatsAppChatLines`); an async
 * version would leak into every caller's signature for a test-only concern.
 */
function testOnlyTxtToctouBarrier(): void {
  const barrierDir = process.env.PDPP_TEST_TXT_TOCTOU_BARRIER_DIR;
  if (!barrierDir) {
    return;
  }
  const readyPath = join(barrierDir, "pass-1-complete");
  const releasePath = join(barrierDir, "release-pass-2");
  writeFileSync(readyPath, `${String(process.pid)}\n`, { flag: "wx" });

  const deadline = Date.now() + 10_000;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for the WhatsApp .txt TOCTOU test barrier release");
    }
    Atomics.wait(waitCell, 0, 0, 10);
  }
}

/**
 * .txt path: pass 1 (identity scan) streams line-by-line from disk via
 * readline over a createReadStream, never materializing the whole file as
 * one string. Zero-byte files and files with no parseable message line are
 * distinguished explicitly (empty vs. unsupported), matching the
 * pre-streaming contract.
 *
 * A single fd is opened here and kept open for the export's whole
 * lifetime (mirroring the zip path's `closeSource` contract exactly,
 * instead of the .txt path being a special case). Both
 * `scanWhatsAppChatIdentityStream` (pass 1, here) and pass 2's
 * `linesForPass()` (run later by the caller, via `pinnedFdLines`) read
 * from this SAME fd/inode with an explicit `start: 0` each time, closing
 * the TOCTOU window a fresh path-based `createReadStream(fileName)` per
 * pass would leave open: a concurrent re-upload reusing this staging
 * filename, or this connector's own boot sweep touching the staging
 * directory, could otherwise make pass 2 read different bytes than pass 1
 * scanned. `identitySnapshot` additionally pins (size, mtimeMs) at the end
 * of pass 1; the caller re-checks it against a fresh fstat immediately
 * before starting pass 2 and refuses to emit (TxtArtifactChangedError) if
 * the SAME inode was mutated in place between passes -- a lower-probability
 * residual the fd pin alone does not close, since fstat on an already-open
 * fd still reflects a concurrent write to that same file.
 */
async function parseTxtExportFile(fileName: string): Promise<TxtParseOutcome> {
  if (statSync(fileName).size === 0) {
    return { kind: "empty" };
  }
  const fd = openSync(fileName, "r");
  const closeSource = () => closeSync(fd);
  let sawExportShapedLine = false;
  async function* sniffedLines(rawLines: AsyncIterable<string>): AsyncGenerator<string> {
    for await (const line of rawLines) {
      if (!sawExportShapedLine && looksLikeWhatsAppChatExport(line)) {
        sawExportShapedLine = true;
      }
      yield line;
    }
  }
  try {
    const summary = await scanWhatsAppChatIdentityStream(basename(fileName), sniffedLines(pinnedFdLines(fd)));
    if (!sawExportShapedLine || summary.messageCount === 0) {
      closeSource();
      return { kind: "unsupported" };
    }
    const identitySnapshot = txtFileIdentitySnapshot(fd);
    return {
      kind: "parsed",
      source: {
        attachments: [],
        closeSource,
        fileTitle: basename(fileName),
        linesForPass: () => {
          testOnlyTxtToctouBarrier();
          const current = txtFileIdentitySnapshot(fd);
          if (current.size !== identitySnapshot.size || current.mtimeMs !== identitySnapshot.mtimeMs) {
            throw new TxtArtifactChangedError(fileName);
          }
          return pinnedFdLines(fd);
        },
      },
      summary,
    };
  } catch (err) {
    closeSource();
    if (err instanceof WhatsAppMessageLimitExceededError) {
      return { kind: "too_large", reason: err.message };
    }
    throw err;
  }
}

interface ParseExportOutcome {
  closeSource: () => void;
  result: { source: ParsedExportSource; summary: WhatsAppChatSummary } | null;
}

async function skipParseExport(
  emit: EmitEvent,
  message: string,
  reason: string,
  skipStream: string,
  closeSource: () => void = () => undefined
): Promise<ParseExportOutcome> {
  await emit({ message, reason, stream: skipStream, type: "SKIP_RESULT" });
  return { closeSource, result: null };
}

async function parseZipExportOutcome(
  fileName: string,
  emit: EmitEvent,
  exportOrdinal: number,
  exportTotal: number,
  skipStream: string
): Promise<ParseExportOutcome> {
  const zipResult = await parseZipExportFile(fileName, emit, exportOrdinal, exportTotal, skipStream);
  if (!zipResult.source) {
    return { closeSource: zipResult.closeSource, result: null };
  }
  // The zip path's identity scan runs over the already-bounded,
  // already-in-memory chat text (see parseZipExportFile) -- cheap to
  // re-split for pass 1 here, since it never re-reads the archive.
  // linesForPass()'s return type is widened to also cover the .txt path's
  // async source; the zip source always returns a plain sync Iterable in
  // practice, so this cast is safe.
  let summary: WhatsAppChatSummary;
  try {
    summary = scanWhatsAppChatIdentity(zipResult.source.fileTitle, zipResult.source.linesForPass() as Iterable<string>);
  } catch (err) {
    zipResult.closeSource();
    if (err instanceof WhatsAppMessageLimitExceededError) {
      return skipParseExport(
        emit,
        `Skipped WhatsApp export ${exportOrdinal} of ${exportTotal}: ${err.message}.`,
        "import_exceeds_bounded_read_policy",
        skipStream
      );
    }
    throw err;
  }
  if (summary.messageCount === 0) {
    zipResult.closeSource();
    return skipParseExport(
      emit,
      `Skipped WhatsApp export ${exportOrdinal} of ${exportTotal}: not a supported chat export.`,
      "unsupported_export",
      skipStream
    );
  }
  return { closeSource: zipResult.closeSource, result: { source: zipResult.source, summary } };
}

async function parseTxtExportOutcome(
  fileName: string,
  emit: EmitEvent,
  exportOrdinal: number,
  exportTotal: number,
  skipStream: string
): Promise<ParseExportOutcome> {
  const txtOutcome = await parseTxtExportFile(fileName);
  const noopClose = () => undefined;
  if (txtOutcome.kind === "empty") {
    return skipParseExport(
      emit,
      `Skipped WhatsApp export ${exportOrdinal} of ${exportTotal}: the file is empty or unreadable.`,
      "empty_export",
      skipStream,
      noopClose
    );
  }
  if (txtOutcome.kind === "too_large") {
    return skipParseExport(
      emit,
      `Skipped WhatsApp export ${exportOrdinal} of ${exportTotal}: ${txtOutcome.reason}.`,
      "import_exceeds_bounded_read_policy",
      skipStream,
      noopClose
    );
  }
  if (txtOutcome.kind === "unsupported") {
    return skipParseExport(
      emit,
      `Skipped WhatsApp export ${exportOrdinal} of ${exportTotal}: not a supported chat export.`,
      "unsupported_export",
      skipStream,
      noopClose
    );
  }
  return { closeSource: noopClose, result: { source: txtOutcome.source, summary: txtOutcome.summary } };
}

/**
 * `closeSource` MUST be called by the caller once done consuming the
 * returned source's attachments (see ParsedExportSource) — for the .txt
 * path it is always a no-op, but callers must call it unconditionally
 * rather than special-casing by file type, so the lazy-fd lifetime
 * contract is uniform.
 */
async function parseExportFile(
  fileName: string,
  emit: EmitEvent,
  progress: EmitProgress,
  exportOrdinal: number,
  exportTotal: number,
  skipStream: string
): Promise<ParseExportOutcome> {
  await progress(`Reading WhatsApp export ${exportOrdinal} of ${exportTotal}.`, {
    count: exportOrdinal,
    total: exportTotal,
  });
  let outcome: ParseExportOutcome;
  try {
    outcome = ZIP_EXT_RE.test(fileName)
      ? await parseZipExportOutcome(fileName, emit, exportOrdinal, exportTotal, skipStream)
      : await parseTxtExportOutcome(fileName, emit, exportOrdinal, exportTotal, skipStream);
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") {
      return skipParseExport(
        emit,
        `Skipped WhatsApp export ${exportOrdinal} of ${exportTotal}: the file is empty or unreadable.`,
        "empty_export",
        skipStream
      );
    }
    throw err;
  }
  if (!outcome.result) {
    return outcome;
  }
  await progress(
    `Parsed WhatsApp export ${exportOrdinal} of ${exportTotal}: ${outcome.result.summary.messageCount} messages and ${outcome.result.source.attachments.length} media file(s).`,
    {
      count: exportOrdinal,
      total: exportTotal,
    }
  );
  return outcome;
}

function attachmentRecordId(chatId: string, filename: string, bytes: Buffer): string {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const suffix = createHash("sha256").update(`${filename}:${sha}`).digest("hex").slice(0, 16);
  return `${chatId}:attachment:${suffix}`;
}

/**
 * Reads, uploads, and builds the record for ONE attachment. Returns `null`
 * if the attachment's data() throws (oversized per policy, or corrupt) —
 * that is a per-attachment skip, not a whole-export failure. Bytes are read
 * here and go out of scope once this function returns; attachments are
 * handled strictly one at a time, so memory use is bounded by the largest
 * single attachment, not the sum of every attachment in the archive.
 */
async function buildAttachmentRecord(
  chatId: string,
  attachment: ParsedWhatsAppAttachment,
  attachmentLinkIndex: AttachmentMessageLinkIndex
): Promise<Record<string, unknown> | null> {
  let bytes: Buffer;
  try {
    bytes = attachment.data();
  } catch {
    return null;
  }
  const id = attachmentRecordId(chatId, attachment.filename, bytes);
  const contentType = contentTypeForFileName(attachment.filename);
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  let blobRef: ReferenceBlobRef | null = null;
  let hydrationStatus: "deferred" | "failed" | "hydrated" = "deferred";
  let hydrationError: string | null = null;
  try {
    blobRef = await uploadBlob({
      bytes,
      connectorId: "https://registry.pdpp.dev/connectors/whatsapp",
      mimeType: contentType,
      recordKey: id,
      stream: "attachments",
    });
    if (blobRef) {
      hydrationStatus = "hydrated";
    }
  } catch (err) {
    hydrationStatus = "failed";
    hydrationError = err instanceof Error ? err.message : "Attachment blob upload failed.";
  }
  return {
    id,
    blob_ref: blobRef,
    chat_id: chatId,
    content_sha256: blobRef?.sha256 ?? contentSha256,
    content_type: blobRef?.mime_type ?? contentType,
    filename: attachment.filename,
    hydration_error: hydrationError,
    hydration_status: hydrationStatus,
    message_id: attachmentLinkIndex.messageIdFor(attachment.filename),
    size_bytes: blobRef?.size_bytes ?? bytes.byteLength,
  };
}

async function emitAttachmentRecords(
  chatId: string,
  attachments: readonly ParsedWhatsAppAttachment[],
  attachmentLinkIndex: AttachmentMessageLinkIndex,
  attachmentsCursor: FingerprintCursor,
  emitRecord: EmitRecord,
  progress: EmitProgress,
  exportOrdinal: number,
  exportTotal: number,
  emit: EmitEvent
): Promise<{ covered: number; emitted: number; processed: number }> {
  let emitted = 0;
  let skipped = 0;
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    if (!attachment) {
      continue;
    }
    const record = await buildAttachmentRecord(chatId, attachment, attachmentLinkIndex);
    if (!record) {
      skipped += 1;
      continue;
    }
    if (attachmentsCursor.shouldEmit(record)) {
      await emitRecord("attachments", record);
      emitted += 1;
    }
    const processed = index + 1;
    if (processed % ATTACHMENT_PROGRESS_INTERVAL === 0 || processed === attachments.length) {
      await progress(
        `Processed ${processed} of ${attachments.length} WhatsApp media file(s) from export ${exportOrdinal} of ${exportTotal}.`,
        {
          count: processed,
          stream: "attachments",
          total: attachments.length,
        }
      );
    }
  }
  if (skipped > 0) {
    await emit({
      type: "SKIP_RESULT",
      stream: "attachments",
      reason: "media_exceeds_bounded_read_policy",
      message: `${skipped} media file(s) in WhatsApp export ${exportOrdinal} of ${exportTotal} exceeded the archive read policy and were not imported.`,
    });
  }
  // `covered` excludes media the read policy dropped. The runtime's coverage
  // contract is explicit that a weighed-but-dropped item belongs to neither the
  // collected nor the covered count, so counting the raw discovered length here
  // would report a chat with skipped media as fully covered.
  return { covered: attachments.length - skipped, emitted, processed: attachments.length };
}

function openWhatsAppCursors(state: Record<string, unknown>): WhatsAppCursors {
  return {
    attachments: openFingerprintCursor(state.attachments),
    chats: openFingerprintCursor(state.chats),
    messages: openFingerprintCursor(state.messages),
  };
}

// ─── Chat identity reconciliation (STATE-persisted, connection-owned) ──────
//
// See parsers.ts's module comment above deriveChatIdentityKey for why no
// content-only signal is a defensible unique chat id.
//
// A FIRST DRAFT of this cursor mapped identityKey -> ONE chatId directly
// (first-seen wins, every later export sharing that identityKey reused the
// same chatId). That is wrong: two DIFFERENT chats can share an identical
// participant list (e.g. a group is left and an unrelated new group is
// created with the same people), and that draft would have SILENTLY MERGED
// their records under one chatId -- a confidently-wrong data corruption,
// not a stability fix. Caught before shipping.
//
// This cursor instead keeps a list of ALIASES per identityKey. Each alias
// remembers the chatId it was minted for AND a bounded sample of message
// CONTENT fingerprints (see parsers.ts's messageContentFingerprint) already
// seen under that chatId. Resolving a new export:
//   1. Compute this export's own message content fingerprints.
//   2. For each existing alias under this identityKey, check for ANY
//      fingerprint overlap with the alias's stored sample.
//   3. Overlap found -> STRONG match (some message content is provably the
//      same as a prior run) -> reuse that alias's chatId. This is the
//      common re-export case: filename changed, date range changed, but
//      the chat's actual message content overlaps with what was seen
//      before.
//   4. No overlap against ANY existing alias (including zero prior
//      aliases, i.e. first sight) -> mint a NEW, DISTINCT alias/chatId. If
//      this identityKey already had at least one other alias, this is the
//      ambiguous same-participants-different-chat case -- surfaced via
//      `ambiguous` on the resolution result rather than merged silently.
//
// This does not (and cannot, from file content alone) prove two exports
// are the same chat with certainty -- it proves EITHER "definite content
// overlap" (safe to merge) OR "no evidence of overlap, kept distinct,
// flagged" (safe default: never merge on absence of evidence). If a chat's
// content genuinely never overlaps across exports (e.g. two completely
// disjoint date-range exports of the same real chat, no shared message),
// this design conservatively treats them as distinct aliases rather than
// guessing -- an honest limitation, not silently resolved.
//
// Sampling: fingerprint samples (both the initial per-export sample from
// parsers.ts's scanWhatsAppChatIdentity and the grown sample below, when an
// existing alias picks up new fingerprints from a matching run) use
// RESERVOIR sampling (parsers.ts's sampleUniform/ReservoirSampler) -- an
// unbiased uniform-random sample, not the fixed-STRIDE sampling this module
// used before. Fixed-stride picks evenly-spaced INDICES; on a large chat
// with a genuine but narrow overlap window (e.g. only messages 500-520 out
// of 2M are shared between two exports), a fixed stride can land on none of
// them, producing a FALSE NEGATIVE -- two exports of the same real chat get
// treated as distinct, unmerged aliases. Reservoir sampling gives every
// message an equal chance of being in the sample regardless of position,
// closing that blind spot.
//
// Alias-list growth: capped at MAX_ALIASES_PER_IDENTITY_KEY (see below) --
// every reservoir-sampling false negative (a real re-export that, by bad
// luck, shares no fingerprint with the persisted sample) would otherwise
// append a new alias FOREVER, growing STATE size without bound and making
// resolution cost scale with alias count. Once the cap is hit, an export
// that finds no overlap is treated as ambiguous (kept as its own chatId,
// diagnostic emitted) but does NOT mint yet another alias -- see resolve()'s
// cap check.
const MESSAGE_FINGERPRINT_SAMPLE_SIZE = 40;
const MAX_ALIASES_PER_IDENTITY_KEY = 20;

interface ChatIdentityAlias {
  readonly chatId: string;
  readonly fingerprintSample: readonly string[];
}

function decodeAliasList(raw: unknown): ChatIdentityAlias[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const aliases: ChatIdentityAlias[] = [];
  for (const entry of raw) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { chat_id?: unknown }).chat_id === "string" &&
      Array.isArray((entry as { fingerprint_sample?: unknown }).fingerprint_sample)
    ) {
      aliases.push({
        chatId: (entry as { chat_id: string }).chat_id,
        fingerprintSample: (entry as { fingerprint_sample: unknown[] }).fingerprint_sample.filter(
          (f): f is string => typeof f === "string"
        ),
      });
    }
  }
  return aliases;
}

function mergeAliasMapFrom(map: Map<string, ChatIdentityAlias[]>, cursorState: unknown): void {
  if (!cursorState || typeof cursorState !== "object") {
    return;
  }
  const chatIdentity = (cursorState as { chat_identity?: unknown }).chat_identity;
  if (!chatIdentity || typeof chatIdentity !== "object") {
    return;
  }
  const raw = (chatIdentity as { aliases?: unknown }).aliases;
  if (!raw || typeof raw !== "object") {
    return;
  }
  for (const [identityKey, aliasListRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!map.has(identityKey)) {
      map.set(identityKey, decodeAliasList(aliasListRaw));
    }
  }
}

/**
 * The reconciliation map can have been written under ANY of the three
 * streams' cursor objects (see emitRequestedState's fallback -- which
 * stream last happened to be requested when it was written). Every prior
 * run's state is checked so a run that only requests "messages" still finds
 * aliases a PRIOR run wrote under "chats" (or vice versa).
 */
function decodeAliasesByIdentityKey(state: Record<string, unknown>): Map<string, ChatIdentityAlias[]> {
  const map = new Map<string, ChatIdentityAlias[]>();
  for (const stream of STREAM_PRIORITY) {
    mergeAliasMapFrom(map, state[stream]);
  }
  return map;
}

export interface ChatIdentityResolution {
  readonly ambiguous: boolean;
  readonly chatId: string;
}

export interface ChatIdentityCursor {
  resolve: (
    identityKey: string,
    provisionalChatId: string,
    messageFingerprints: readonly string[]
  ) => ChatIdentityResolution;
  toState: () => { aliases: Record<string, unknown>; synced_at: string };
}

export function openChatIdentityCursor(state: Record<string, unknown>): ChatIdentityCursor {
  const aliasesByKey = decodeAliasesByIdentityKey(state);
  return {
    resolve(identityKey, provisionalChatId, messageFingerprints) {
      const existingAliases = aliasesByKey.get(identityKey) ?? [];
      const incomingSet = new Set(messageFingerprints);
      const matched = existingAliases.find((alias) => alias.fingerprintSample.some((f) => incomingSet.has(f)));
      if (matched) {
        // Strong match: grow the alias's sample with new fingerprints from
        // this run (bounded, reservoir-sampled -- see the module comment
        // above), so future overlap checks stay accurate as the known
        // content for this chat grows across runs.
        const grownSample = sampleUniform(
          [...matched.fingerprintSample, ...messageFingerprints],
          MESSAGE_FINGERPRINT_SAMPLE_SIZE
        );
        const grownAliases = existingAliases.map((alias) =>
          alias.chatId === matched.chatId ? { chatId: alias.chatId, fingerprintSample: grownSample } : alias
        );
        aliasesByKey.set(identityKey, grownAliases);
        return { ambiguous: false, chatId: matched.chatId };
      }
      // No overlap against any existing alias for this identityKey. Once
      // MAX_ALIASES_PER_IDENTITY_KEY is reached, stop minting NEW aliases
      // (STATE would grow without bound otherwise -- see the module
      // comment above) -- fall back to a deterministic, non-persisted
      // "overflow" chatId for this identityKey instead. Not persisting it
      // means a later export with the SAME content this run couldn't
      // match will independently re-derive the SAME overflow chatId
      // (deterministic salt), so overflow exports still get stable,
      // idempotent ids across runs -- they just don't get their own
      // tracked alias slot.
      if (existingAliases.length >= MAX_ALIASES_PER_IDENTITY_KEY) {
        return { ambiguous: true, chatId: mintChatId(identityKey, "overflow") };
      }
      // provisionalChatId (mintChatId(identityKey, "")) alone would collide
      // with a future alias minted for the SAME identityKey (both derive
      // from the same key with no salt) -- append this alias's own ordinal
      // as a salt so multiple distinct chats sharing an identityKey get
      // distinct chatIds, not silently the same one.
      const newChatId =
        existingAliases.length === 0 ? provisionalChatId : mintChatId(identityKey, String(existingAliases.length));
      aliasesByKey.set(identityKey, [
        ...existingAliases,
        { chatId: newChatId, fingerprintSample: sampleUniform(messageFingerprints, MESSAGE_FINGERPRINT_SAMPLE_SIZE) },
      ]);
      // ambiguous=true only when this identityKey ALREADY had at least one
      // other alias -- i.e. this really is the same-participants-different-
      // chat case, not merely "first time we've seen this chat".
      return { ambiguous: existingAliases.length > 0, chatId: newChatId };
    },
    toState() {
      const aliases: Record<string, unknown> = {};
      for (const [identityKey, aliasList] of aliasesByKey) {
        aliases[identityKey] = aliasList.map((alias) => ({
          chat_id: alias.chatId,
          fingerprint_sample: alias.fingerprintSample,
        }));
      }
      return { aliases, synced_at: nowIso() };
    },
  };
}

async function discoverImportFilesOrThrow(importDir: string): Promise<string[]> {
  try {
    return await discoverExportFiles(importDir);
  } catch (err) {
    throw new Error(`import_dir_not_found: ${importDir} (set WHATSAPP_EXPORT_DIR or create the directory)`, {
      cause: err,
    });
  }
}

async function emitNoExports(emit: EmitEvent, skipStream: string): Promise<void> {
  await emit({
    message: "No WhatsApp .txt or .zip exports are available for this source. Add an export and run again.",
    reason: "no_exports_found",
    stream: skipStream,
    type: "SKIP_RESULT",
  });
}

async function emitParsedExport(
  chatId: string,
  summary: WhatsAppChatSummary,
  source: ParsedExportSource,
  requested: RequestedStreams,
  cursors: WhatsAppCursors,
  emit: EmitEvent,
  emitRecord: EmitRecord,
  progress: EmitProgress,
  exportOrdinal: number,
  exportTotal: number
): Promise<{ attachments: number; attachmentsCovered: number; messages: number; records: number }> {
  let records = 0;
  let attachmentsCovered = 0;
  if (requested.has("chats")) {
    await emitChatRecord(summary, cursors.chats, emitRecord);
    records += 1;
    await progress(`Imported chat metadata for WhatsApp export ${exportOrdinal} of ${exportTotal}.`, {
      count: exportOrdinal,
      stream: "chats",
      total: exportTotal,
    });
  }

  // Pass 2 (message re-stream) is only needed if messages OR attachments
  // are requested -- attachments need it too, for the message-link index
  // (see AttachmentMessageLinkIndex), not just for message records
  // themselves.
  if (requested.has("messages") || requested.has("attachments")) {
    const messageSummary = await emitMessageRecords(
      chatId,
      source.linesForPass(),
      source.attachments,
      requested.has("messages"),
      cursors.messages,
      emitRecord,
      progress,
      exportOrdinal,
      exportTotal
    );
    records += messageSummary.emitted;

    if (requested.has("attachments")) {
      const attachmentSummary = await emitAttachmentRecords(
        chatId,
        source.attachments,
        messageSummary.attachmentLinkIndex,
        cursors.attachments,
        emitRecord,
        progress,
        exportOrdinal,
        exportTotal,
        emit
      );
      records += attachmentSummary.emitted;
      attachmentsCovered += attachmentSummary.covered;
    }
  }

  await emit({
    message: `Imported WhatsApp export ${exportOrdinal} of ${exportTotal}: ${summary.messageCount} messages and ${source.attachments.length} media file(s).`,
    count: exportOrdinal,
    total: exportTotal,
    type: "PROGRESS",
  });
  return {
    attachments: source.attachments.length,
    attachmentsCovered,
    messages: summary.messageCount,
    records,
  };
}

function pruneRequestedCursors(requested: RequestedStreams, cursors: WhatsAppCursors): void {
  for (const [stream, cursor] of Object.entries(cursors)) {
    if (requested.has(stream)) {
      cursor.pruneStale();
    }
  }
}

async function emitStateForCursor(
  stream: string,
  cursor: FingerprintCursor,
  emit: EmitEvent,
  extra?: Record<string, unknown>
): Promise<void> {
  const cursorState: Record<string, unknown> = { synced_at: nowIso(), ...extra };
  if (cursor.size() > 0) {
    cursorState.fingerprints = cursor.toState();
  }
  await emit({ cursor: cursorState, stream, type: "STATE" });
}

/**
 * The chat-identity reconciliation map (see openChatIdentityCursor) is NOT a
 * real emitted-record stream, so it cannot be its own STATE.stream value --
 * the runtime hard-rejects any STATE for a stream not declared in the
 * manifest (`Connector emitted STATE for undeclared stream`), failing the
 * whole run. Instead it rides inside the "messages" stream's own cursor
 * object, alongside its `fingerprints` field: `messages` is the stream whose
 * emitted record ids actually depend on the resolved chatId, and identity
 * resolution must work even when a caller requests `messages` without
 * `chats` (chat-scoped id derivation is not the only reason messages need a
 * stable chatId). If `messages` is not requested this run, the map is
 * carried forward via the FALLBACK write below so it survives regardless of
 * which streams a given run happened to request.
 */
async function emitRequestedState(
  requested: RequestedStreams,
  cursors: WhatsAppCursors,
  identityCursor: ChatIdentityCursor,
  emit: EmitEvent
): Promise<void> {
  let identityStateWritten = false;
  for (const [stream, cursor] of Object.entries(cursors)) {
    if (!requested.has(stream)) {
      continue;
    }
    if (stream === "messages") {
      await emitStateForCursor(stream, cursor, emit, { chat_identity: identityCursor.toState() });
      identityStateWritten = true;
    } else {
      await emitStateForCursor(stream, cursor, emit);
    }
  }
  if (!identityStateWritten) {
    // messages wasn't requested this run -- still persist the identity map
    // (unchanged reconciliation entries carried forward, any newly-minted
    // ones from this run included) under whatever stream IS requested, so a
    // messages-only run later still finds it. chats is the next-most-likely
    // to be requested; if truly nothing was requested there is nothing to
    // attach state to at all, which mirrors how the fingerprint cursors
    // behave in that same situation.
    const fallbackStream = STREAM_PRIORITY.find((stream) => requested.has(stream));
    if (fallbackStream) {
      await emit({
        cursor: { chat_identity: identityCursor.toState(), synced_at: nowIso() },
        stream: fallbackStream,
        type: "STATE",
      });
    }
  }
}

runConnector({
  name: "whatsapp",
  validateRecord,
  async collect({ requested, state, emit, emitRecord, progress }) {
    const importDir = process.env.WHATSAPP_EXPORT_DIR || join(homedir(), ".pdpp/imports/whatsapp");

    // Per-record fingerprint cursors — one per stream — seeded from the prior
    // run's STATE. WhatsApp re-parses all exported .txt files on every run
    // (file-based, no incremental API). Without fingerprint gating, every
    // unchanged message produces a fresh RECORD version each run, accumulating
    // unbounded churn downstream. The cursor skips records whose content has
    // not changed and carries unchanged fingerprints forward into the next
    // STATE write so they are not re-emitted on the following run either.
    const cursors = openWhatsAppCursors(state);
    const identityCursor = openChatIdentityCursor(state);
    const skipStream = firstRequestedStream(requested);

    const files = await discoverImportFilesOrThrow(importDir);
    await progress(`Found ${files.length} WhatsApp export file(s) to inspect.`, {
      count: files.length,
      total: files.length,
    });
    if (!files.length) {
      await emitNoExports(emit, skipStream);
      return;
    }

    // The discovery walk is the chat coverage boundary. Every export file is
    // considered even when parsing later rejects it; only successfully parsed
    // exports are covered.
    const consideredExports = files.length;
    let importedExports = 0;
    let totalAttachments = 0;
    let totalAttachmentsCovered = 0;
    let totalMessages = 0;
    let totalRecords = 0;
    for (let index = 0; index < files.length; index += 1) {
      const f = files[index];
      if (!f) {
        continue;
      }
      const exportOrdinal = index + 1;
      const { closeSource, result } = await parseExportFile(f, emit, progress, exportOrdinal, files.length, skipStream);
      if (!result) {
        closeSource();
        continue;
      }
      const { source, summary: chatSummary } = result;
      try {
        // Resolve this export's provisional (identityKey-derived) chatId
        // against the connection's persisted reconciliation-alias map.
        // Content overlap (not identityKey alone) decides reuse -- see
        // openChatIdentityCursor's doc comment. `ambiguous: true` means
        // this identityKey (participant set) already had a DIFFERENT,
        // non-overlapping chat under it; this export is kept as its own
        // distinct chatId rather than merged, and surfaced as a SKIP_RESULT
        // diagnostic so the owner has visibility into the ambiguity instead
        // of it being silently absorbed. messageFingerprintSample is
        // pass 1's bounded RESERVOIR sample (see parsers.ts), not every
        // fingerprint in the chat -- no full message array is ever built to
        // compute it.
        const resolution = identityCursor.resolve(
          chatSummary.identityKey,
          chatSummary.chatId,
          chatSummary.messageFingerprintSample
        );
        const { ambiguous, chatId } = resolution;
        if (ambiguous) {
          // Not a skip -- this chat IS imported, under its own distinct
          // chatId. PROGRESS (not SKIP_RESULT) is the honest signal: no
          // data was dropped, but the owner should know this export was
          // NOT merged into a same-participants chat seen before, because
          // the two share no overlapping message content.
          await emit({
            message: `WhatsApp export ${exportOrdinal} of ${files.length} shares its participant list with a different, already-imported chat but has no overlapping message content — imported as a separate chat rather than merged. If this should be the same chat, re-export with more overlapping history.`,
            type: "PROGRESS",
          });
        }
        const emitSummary = await emitParsedExport(
          chatId,
          { ...chatSummary, chatId },
          source,
          requested,
          cursors,
          emit,
          emitRecord,
          progress,
          exportOrdinal,
          files.length
        );
        importedExports += 1;
        totalAttachments += emitSummary.attachments;
        totalAttachmentsCovered += emitSummary.attachmentsCovered;
        totalMessages += emitSummary.messages;
        totalRecords += emitSummary.records;
      } finally {
        // Every attachment's data() has now been read (or skipped) by
        // emitParsedExport -> emitAttachmentRecords; safe to release the
        // zip file descriptor this export's attachments were lazily reading
        // from (see ZipParseResult's doc comment).
        closeSource();
      }
    }

    // One chat record per successfully parsed export file: `importedExports`
    // counts the files that yielded a chat, measured at the discovery walk
    // above rather than from the emit count, so a steady-state run whose chats
    // were all fingerprint-suppressed still reads covered. Files rejected by
    // `parseExportFile` emit their own SKIP_RESULT: they remain in the
    // enumeration denominator but stay out of `covered`, so a rejected export
    // correctly reads partial.
    if (requested.has("chats")) {
      await emit(
        buildDetailCoverageMessage({
          stream: "chats",
          stateStream: "chats",
          requiredKeys: [],
          hydratedKeys: [],
          considered: consideredExports,
          covered: importedExports,
        })
      );
    }

    // `totalMessages` is the parsed message count summed across exports
    // (`parsed.messages.length`), not the emitted count — every parsed message
    // is either emitted or suppressed as unchanged by the fingerprint cursor.
    if (requested.has("messages")) {
      await emit(
        buildDetailCoverageMessage({
          stream: "messages",
          stateStream: "messages",
          requiredKeys: [],
          hydratedKeys: [],
          considered: totalMessages,
          covered: totalMessages,
        })
      );
    }

    if (requested.has("attachments")) {
      await emit(
        buildDetailCoverageMessage({
          stream: "attachments",
          stateStream: "attachments",
          requiredKeys: [],
          hydratedKeys: [],
          considered: totalAttachments,
          // Media dropped by the bounded-read policy is discovered but not
          // collected, so it must not inflate `covered` into a false complete.
          covered: totalAttachmentsCovered,
        })
      );
    }

    // Drop fingerprints for chats/messages that disappeared from the export
    // directory since the prior run (full-scan streams re-enumerate everything).
    pruneRequestedCursors(requested, cursors);

    // Emit STATE checkpoints so fingerprint maps survive into the next run.
    await emitRequestedState(requested, cursors, identityCursor, emit);
    await progress(
      `Finished WhatsApp import: ${importedExports} export(s), ${totalMessages} messages, ${totalAttachments} media file(s).`,
      {
        count: totalRecords,
        total: totalRecords,
      }
    );
  },
});
