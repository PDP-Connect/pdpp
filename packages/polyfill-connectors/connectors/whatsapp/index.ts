#!/usr/bin/env node

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
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type EmittedMessage, runConnector } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import {
  makeReferenceBlobUploader,
  type ReferenceBlobRef,
  runtimeBlobUploadAvailable,
} from "../../src/reference-blob-uploader.ts";
import { extractWhatsAppChatArtifact, nowIso, type ParsedWhatsAppChat, parseWhatsAppChatFile } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

// ─── Fingerprinted record emission ───────────────────────────────────────────

type EmitRecord = (stream: string, record: Record<string, unknown>) => Promise<void>;
type EmitEvent = (event: EmittedMessage) => Promise<void>;
type FingerprintCursor = ReturnType<typeof openFingerprintCursor>;
interface RequestedStreams {
  has(stream: string): boolean;
}
interface WhatsAppCursors {
  attachments: FingerprintCursor;
  chats: FingerprintCursor;
  messages: FingerprintCursor;
}
const SUPPORTED_EXPORT_EXTENSIONS = [".txt", ".zip"] as const;
const MAX_DISCOVERY_DEPTH = 3;
const MAX_DISCOVERY_ENTRIES = 10_000;

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
  const uploader = makeReferenceBlobUploader({ ownerToken, rsUrl });
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
  parsed: ParsedWhatsAppChat,
  first: string | null,
  last: string | null,
  chatsCursor: FingerprintCursor,
  emitRecord: EmitRecord
): Promise<void> {
  const record = {
    id: parsed.chatId,
    title: parsed.title,
    participants: parsed.participants,
    message_count: parsed.messages.length,
    first_message_date: first,
    last_message_date: last,
  };
  if (chatsCursor.shouldEmit(record)) {
    await emitRecord("chats", record);
  }
}

async function emitMessageRecords(
  parsed: ParsedWhatsAppChat,
  messagesCursor: FingerprintCursor,
  emitRecord: EmitRecord
): Promise<void> {
  for (let i = 0; i < parsed.messages.length; i++) {
    const m = parsed.messages[i];
    if (!m) {
      continue;
    }
    const record = {
      id: `${parsed.chatId}:${i}`,
      chat_id: parsed.chatId,
      author: m.author,
      content: m.content,
      has_attachment: !!m.has_attachment,
      sent_at: m.sent_at,
    };
    if (messagesCursor.shouldEmit(record)) {
      await emitRecord("messages", record);
    }
  }
}

async function parseExportFile(
  importDir: string,
  fileName: string,
  emit: EmitEvent
): Promise<ParsedWhatsAppChat | null> {
  const content = await readFile(join(importDir, fileName)).catch((): Buffer => Buffer.alloc(0));
  if (content.length === 0) {
    return null;
  }
  const artifact = extractWhatsAppChatArtifact(fileName, content);
  if (!artifact) {
    await emit({
      type: "PROGRESS",
      message: `Skipped ${fileName}: not a supported WhatsApp chat export`,
    });
    return null;
  }
  const parsed = parseWhatsAppChatFile(artifact.chatFileName, artifact.text);
  return { ...parsed, attachments: artifact.mediaFiles };
}

function attachmentRecordId(chatId: string, filename: string, bytes: Buffer): string {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const suffix = createHash("sha256").update(`${filename}:${sha}`).digest("hex").slice(0, 16);
  return `${chatId}:attachment:${suffix}`;
}

function findAttachmentMessageId(parsed: ParsedWhatsAppChat, filename: string): string | null {
  const lower = filename.toLowerCase();
  const index = parsed.messages.findIndex((message) => message.content.toLowerCase().includes(lower));
  return index >= 0 ? `${parsed.chatId}:${index}` : null;
}

async function emitAttachmentRecords(
  parsed: ParsedWhatsAppChat,
  attachmentsCursor: FingerprintCursor,
  emitRecord: EmitRecord
): Promise<void> {
  for (const attachment of parsed.attachments) {
    const id = attachmentRecordId(parsed.chatId, attachment.filename, attachment.bytes);
    const contentType = contentTypeForFileName(attachment.filename);
    const contentSha256 = createHash("sha256").update(attachment.bytes).digest("hex");
    let blobRef: ReferenceBlobRef | null = null;
    let hydrationStatus: "deferred" | "failed" | "hydrated" = "deferred";
    let hydrationError: string | null = null;
    try {
      blobRef = await uploadBlob({
        bytes: attachment.bytes,
        connectorId: "https://registry.pdpp.org/connectors/whatsapp",
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
    const record = {
      id,
      blob_ref: blobRef,
      chat_id: parsed.chatId,
      content_sha256: blobRef?.sha256 ?? contentSha256,
      content_type: blobRef?.mime_type ?? contentType,
      filename: attachment.filename,
      hydration_error: hydrationError,
      hydration_status: hydrationStatus,
      message_id: findAttachmentMessageId(parsed, attachment.filename),
      size_bytes: blobRef?.size_bytes ?? attachment.bytes.byteLength,
    };
    if (attachmentsCursor.shouldEmit(record)) {
      await emitRecord("attachments", record);
    }
  }
}

function openWhatsAppCursors(state: Record<string, unknown>): WhatsAppCursors {
  return {
    attachments: openFingerprintCursor(state.attachments),
    chats: openFingerprintCursor(state.chats),
    messages: openFingerprintCursor(state.messages),
  };
}

async function discoverImportFilesOrThrow(importDir: string): Promise<string[]> {
  try {
    return await discoverExportFiles(importDir);
  } catch {
    throw new Error(`import_dir_not_found: ${importDir} (set WHATSAPP_EXPORT_DIR or create the directory)`);
  }
}

async function emitNoExports(importDir: string, emit: EmitEvent): Promise<void> {
  await emit({
    message: `No .txt or .zip exports in ${importDir}. Export chats from WhatsApp and drop files here.`,
    reason: "no_exports_found",
    stream: "chats",
    type: "SKIP_RESULT",
  });
}

async function emitParsedExport(
  fileName: string,
  parsed: ParsedWhatsAppChat,
  requested: RequestedStreams,
  cursors: WhatsAppCursors,
  emit: EmitEvent,
  emitRecord: EmitRecord
): Promise<void> {
  const first = parsed.messages[0]?.sent_at || null;
  const last = parsed.messages.at(-1)?.sent_at || null;
  if (requested.has("chats")) {
    await emitChatRecord(parsed, first, last, cursors.chats, emitRecord);
  }
  if (requested.has("messages")) {
    await emitMessageRecords(parsed, cursors.messages, emitRecord);
  }
  if (requested.has("attachments")) {
    await emitAttachmentRecords(parsed, cursors.attachments, emitRecord);
  }
  await emit({
    message: `Imported ${fileName}: ${parsed.messages.length} messages`,
    type: "PROGRESS",
  });
}

function pruneRequestedCursors(requested: RequestedStreams, cursors: WhatsAppCursors): void {
  for (const [stream, cursor] of Object.entries(cursors)) {
    if (requested.has(stream)) {
      cursor.pruneStale();
    }
  }
}

async function emitStateForCursor(stream: string, cursor: FingerprintCursor, emit: EmitEvent): Promise<void> {
  const cursorState: Record<string, unknown> = { synced_at: nowIso() };
  if (cursor.size() > 0) {
    cursorState.fingerprints = cursor.toState();
  }
  await emit({ cursor: cursorState, stream, type: "STATE" });
}

async function emitRequestedState(
  requested: RequestedStreams,
  cursors: WhatsAppCursors,
  emit: EmitEvent
): Promise<void> {
  for (const [stream, cursor] of Object.entries(cursors)) {
    if (requested.has(stream)) {
      await emitStateForCursor(stream, cursor, emit);
    }
  }
}

runConnector({
  name: "whatsapp",
  validateRecord,
  async collect({ requested, state, emit, emitRecord }) {
    const importDir = process.env.WHATSAPP_EXPORT_DIR || join(homedir(), ".pdpp/imports/whatsapp");

    // Per-record fingerprint cursors — one per stream — seeded from the prior
    // run's STATE. WhatsApp re-parses all exported .txt files on every run
    // (file-based, no incremental API). Without fingerprint gating, every
    // unchanged message produces a fresh RECORD version each run, accumulating
    // unbounded churn downstream. The cursor skips records whose content has
    // not changed and carries unchanged fingerprints forward into the next
    // STATE write so they are not re-emitted on the following run either.
    const cursors = openWhatsAppCursors(state);

    const files = await discoverImportFilesOrThrow(importDir);
    if (!files.length) {
      await emitNoExports(importDir, emit);
      return;
    }

    for (const f of files) {
      const parsed = await parseExportFile("", f, emit);
      if (!parsed) {
        continue;
      }
      await emitParsedExport(f, parsed, requested, cursors, emit, emitRecord);
    }

    // Drop fingerprints for chats/messages that disappeared from the export
    // directory since the prior run (full-scan streams re-enumerate everything).
    pruneRequestedCursors(requested, cursors);

    // Emit STATE checkpoints so fingerprint maps survive into the next run.
    await emitRequestedState(requested, cursors, emit);
  },
});
