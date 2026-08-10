// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  extractWhatsAppChatArtifact,
  extractWhatsAppChatArtifactFromFile,
  looksLikeWhatsAppChatExport,
  scanWhatsAppChatIdentity,
  scanWhatsAppChatIdentityStream,
  splitWhatsAppChatLines,
  type WhatsAppChatSummary,
  WhatsAppMessageLimitExceededError,
  WhatsAppZipPolicyRejection,
  ZIP_EXT_RE,
} from "./parsers.ts";

type WhatsAppDetectedFormat = "whatsapp_chat_export" | "whatsapp_chat_export_zip";

interface ParsedArtifactSummary {
  readonly format: WhatsAppDetectedFormat;
  readonly mediaFileCount: number;
  readonly summary: WhatsAppChatSummary;
}

export type WhatsAppChatExportValidationStatus = "valid" | "duplicate" | "empty" | "unsupported" | "too_large";

export interface WhatsAppChatExportValidationOptions {
  readonly existingFileHashes?: readonly string[];
  readonly fileName?: string | null;
  readonly maxFileBytes?: number | null;
}

export interface WhatsAppChatExportValidation {
  readonly date_range: { readonly end: string | null; readonly start: string | null };
  readonly detected_format: "whatsapp_chat_export" | "whatsapp_chat_export_zip" | "unsupported";
  readonly estimated_attachments: number;
  readonly estimated_chats: number;
  readonly estimated_messages: number;
  readonly estimated_participants: number;
  readonly estimated_records: number;
  readonly file_sha256: string;
  readonly media_coverage: {
    readonly attached_media_files: number;
    readonly referenced_media_files: number;
    readonly status: "included_for_import" | "none_referenced" | "not_included";
  };
  readonly remediation: string | null;
  readonly source_identity: {
    readonly kind: "whatsapp_chat";
    readonly participant_count: number;
    readonly participant_preview: readonly string[];
    readonly stable_id: string;
    readonly suggested_display_name: string;
    readonly title: string;
  } | null;
  readonly status: WhatsAppChatExportValidationStatus;
  readonly warnings: readonly string[];
}

function remediationFor(status: WhatsAppChatExportValidationStatus): string | null {
  switch (status) {
    case "duplicate":
      return "This chat export was already imported. Export the chat again if you need newer messages.";
    case "empty":
      return "The file looks like a WhatsApp chat export, but it does not contain importable messages.";
    case "too_large":
      return "This chat export is larger than the upload limit. Import a smaller chat export first.";
    case "unsupported":
      return "Choose a WhatsApp chat export .txt file or the .zip created by Export chat with media. Account reports, screenshots, and encrypted backups are not chat exports.";
    case "valid":
      return null;
    default:
      return null;
  }
}

function mediaCoverageStatus(
  attachedMediaFiles: number,
  referencedMediaFiles: number
): WhatsAppChatExportValidation["media_coverage"]["status"] {
  if (attachedMediaFiles > 0) {
    return "included_for_import";
  }
  if (referencedMediaFiles > 0) {
    return "not_included";
  }
  return "none_referenced";
}

function baseValidation(fileSha256: string): Omit<WhatsAppChatExportValidation, "remediation" | "status"> {
  return {
    date_range: { end: null, start: null },
    detected_format: "unsupported" as const,
    estimated_attachments: 0,
    estimated_chats: 0,
    estimated_messages: 0,
    estimated_participants: 0,
    estimated_records: 0,
    file_sha256: fileSha256,
    media_coverage: {
      attached_media_files: 0,
      referenced_media_files: 0,
      status: "none_referenced" as const,
    },
    warnings: [] as const,
    source_identity: null,
  };
}

/**
 * Shared tail: builds the final validation result from an already-scanned
 * chat SUMMARY (aggregates only — never a message array; see
 * scanWhatsAppChatIdentity's doc comment) plus its media inventory. Both
 * the buffer-backed and file-backed entrypoints funnel through this once
 * they've each scanned the chat their own way — this is where the actual
 * chat-format business rules (duplicate/empty classification, media-
 * coverage warnings, estimated counts) live, in exactly one place.
 */
function buildValidationFromSummary(
  artifactSummary: ParsedArtifactSummary,
  fileSha256: string,
  existingFileHashes: readonly string[] | undefined
): WhatsAppChatExportValidation {
  const { format, mediaFileCount, summary } = artifactSummary;
  const dateRange = { end: summary.lastSentAt, start: summary.firstSentAt };
  const attachmentCount = summary.attachmentMessageCount;
  let status: WhatsAppChatExportValidationStatus = "valid";
  if (new Set(existingFileHashes ?? []).has(fileSha256)) {
    status = "duplicate";
  } else if (summary.messageCount === 0) {
    status = "empty";
  }

  const warnings: string[] = [];
  if (attachmentCount > 0 && mediaFileCount > 0) {
    warnings.push("This export includes media files. PDPP will import them as WhatsApp attachment records.");
  } else if (attachmentCount > 0) {
    warnings.push("This text export references media, but the media files are not included in this import.");
  } else if (mediaFileCount > 0) {
    warnings.push(
      "This zip includes media-like files, but the parsed chat text did not reference them. PDPP will still import them as attachment records for this chat."
    );
  }

  return {
    date_range: dateRange,
    detected_format: format,
    estimated_attachments: attachmentCount,
    estimated_chats: summary.messageCount > 0 ? 1 : 0,
    estimated_messages: summary.messageCount,
    estimated_participants: summary.participants.length,
    estimated_records: summary.messageCount + (summary.messageCount > 0 ? 1 : 0),
    file_sha256: fileSha256,
    media_coverage: {
      attached_media_files: mediaFileCount,
      referenced_media_files: attachmentCount,
      status: mediaCoverageStatus(mediaFileCount, attachmentCount),
    },
    remediation: remediationFor(status),
    source_identity:
      summary.messageCount > 0
        ? {
            kind: "whatsapp_chat",
            participant_count: summary.participants.length,
            participant_preview: summary.participants.slice(0, 8),
            stable_id: summary.chatId,
            suggested_display_name: summary.title ? `WhatsApp - ${summary.title}` : "WhatsApp chat export",
            title: summary.title,
          }
        : null,
    status,
    warnings,
  };
}

export function validateWhatsAppChatExportArtifact(
  input: Uint8Array | string,
  options: WhatsAppChatExportValidationOptions = {}
): WhatsAppChatExportValidation {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  const base = baseValidation(fileSha256);

  if (options.maxFileBytes !== null && options.maxFileBytes !== undefined && bytes.byteLength > options.maxFileBytes) {
    return { ...base, remediation: remediationFor("too_large"), status: "too_large" };
  }

  let artifact: ReturnType<typeof extractWhatsAppChatArtifact>;
  try {
    artifact = extractWhatsAppChatArtifact(options.fileName ?? "WhatsApp Chat.txt", bytes);
  } catch (err) {
    if (err instanceof WhatsAppZipPolicyRejection) {
      // A real (or plausibly real) export that tripped the decompression-bomb
      // policy — report too_large, not unsupported, so the owner gets
      // actionable guidance instead of being told their real export is
      // unrecognized.
      return { ...base, remediation: remediationFor("too_large"), status: "too_large" };
    }
    throw err;
  }
  if (!artifact) {
    return { ...base, remediation: remediationFor("unsupported"), status: "unsupported" };
  }

  let summary: WhatsAppChatSummary;
  try {
    summary = scanWhatsAppChatIdentity(artifact.chatFileName, splitWhatsAppChatLines(artifact.text));
  } catch (err) {
    if (err instanceof WhatsAppMessageLimitExceededError) {
      // Same real-but-oversized signal as the zip-bomb policy above — a
      // thrown, catchable rejection here (never a V8 heap OOM abort) means
      // this is a normal "too_large" outcome, not a crash.
      return { ...base, remediation: remediationFor("too_large"), status: "too_large" };
    }
    throw err;
  }
  return buildValidationFromSummary(
    { format: artifact.format, mediaFileCount: artifact.mediaFileCount, summary },
    fileSha256,
    options.existingFileHashes
  );
}

export interface WhatsAppChatExportFileValidationOptions {
  readonly existingFileHashes?: readonly string[];
  readonly fileName?: string | null;
  /** Already-known SHA-256 of the file (e.g. computed once during the
   *  streaming upload write) — passed in rather than recomputed, so this
   *  validator never needs a second whole-file read just to hash it again. */
  readonly fileSha256: string;
  readonly maxFileBytes?: number | null;
}

/**
 * File-backed variant of {@link validateWhatsAppChatExportArtifact}: the
 * artifact's bytes are never buffered whole. `fileSize` is used directly for
 * the size-limit check (no read needed), zip archives are read via
 * extractWhatsAppChatArtifactFromFile (bounded-zip-archive.ts's file-backed
 * reader; the chat-text entry it locates is bounded to MAX_CHAT_TEXT_BYTES
 * before being parsed), and plain .txt exports are parsed directly from a
 * streamed line source (readline over createReadStream) via
 * parseWhatsAppChatFileStream — the message list is built in ONE pass either
 * way, never parsed twice. `fd`/`fileName` are caller-owned; this function
 * neither opens nor closes `fd`.
 */
export async function validateWhatsAppChatExportArtifactFromFile(
  fd: number,
  fileName: string,
  fileSize: number,
  options: WhatsAppChatExportFileValidationOptions
): Promise<WhatsAppChatExportValidation> {
  const base = baseValidation(options.fileSha256);

  if (options.maxFileBytes !== null && options.maxFileBytes !== undefined && fileSize > options.maxFileBytes) {
    return { ...base, remediation: remediationFor("too_large"), status: "too_large" };
  }

  const displayFileName = options.fileName ?? fileName;
  const summary = ZIP_EXT_RE.test(fileName)
    ? parseZipArtifactSummary(fd, fileSize)
    : await parseTextArtifactSummary(fileName, displayFileName);
  if (summary === "too_large") {
    return { ...base, remediation: remediationFor("too_large"), status: "too_large" };
  }
  if (!summary) {
    return { ...base, remediation: remediationFor("unsupported"), status: "unsupported" };
  }

  return buildValidationFromSummary(summary, options.fileSha256, options.existingFileHashes);
}

function parseZipArtifactSummary(fd: number, fileSize: number): ParsedArtifactSummary | "too_large" | null {
  let artifact: ReturnType<typeof extractWhatsAppChatArtifactFromFile>;
  try {
    artifact = extractWhatsAppChatArtifactFromFile(fd, fileSize);
  } catch (err) {
    if (err instanceof WhatsAppZipPolicyRejection) {
      return "too_large";
    }
    throw err;
  }
  if (!artifact) {
    return null;
  }
  try {
    const summary = scanWhatsAppChatIdentity(artifact.chatFileName, splitWhatsAppChatLines(artifact.text));
    return { format: artifact.format, mediaFileCount: artifact.mediaFileCount, summary };
  } catch (err) {
    if (err instanceof WhatsAppMessageLimitExceededError) {
      return "too_large";
    }
    throw err;
  }
}

/**
 * Streams lines from disk once, doing two things per line: feeding the
 * identity-scan accumulator (scanWhatsAppChatIdentityStream) AND checking
 * the format sniff (looksLikeWhatsAppChatExport), so this never needs a
 * second pass or a separate "peek the first N bytes" read. Distinguishes
 * "never looked like a WhatsApp export at all" (null -> unsupported,
 * matching the buffer path's pre-parse sniff gate in
 * extractWhatsAppChatArtifact) from "looked like one but zero messages
 * actually parsed" (returns a summary with messageCount 0 --
 * buildValidationFromSummary classifies that as `empty`, not
 * `unsupported`), exactly as the buffer-backed path does.
 */
async function parseTextArtifactSummary(
  path: string,
  displayFileName: string
): Promise<ParsedArtifactSummary | "too_large" | null> {
  if (statSync(path).size === 0) {
    return null;
  }
  let sawExportShapedLine = false;
  async function* sniffedLines(rawLines: AsyncIterable<string>): AsyncGenerator<string> {
    for await (const line of rawLines) {
      if (!sawExportShapedLine && looksLikeWhatsAppChatExport(line)) {
        sawExportShapedLine = true;
      }
      yield line;
    }
  }
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: stream });
  let summary: WhatsAppChatSummary;
  try {
    summary = await scanWhatsAppChatIdentityStream(displayFileName, sniffedLines(lines));
  } catch (err) {
    if (err instanceof WhatsAppMessageLimitExceededError) {
      return "too_large";
    }
    throw err;
  }
  if (!sawExportShapedLine) {
    return null;
  }
  return { format: "whatsapp_chat_export", mediaFileCount: 0, summary };
}
