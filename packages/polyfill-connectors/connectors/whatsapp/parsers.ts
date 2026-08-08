// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  hasZipLocalFileSignature,
  readZipEntries,
  ZipPolicyViolationError,
  type ZipReadPolicy,
  zipBasename,
} from "../../src/bounded-zip-archive.ts";

// Bounds match the manifest's max_file_bytes (1 GiB, see manifests/whatsapp.json) —
// a real "with media" export can legitimately contain many attachments, so
// entry count and total size are generous, but no single entry (nor the
// archive as a whole) can inflate past the upload's own declared ceiling.
// This is the decompression-bomb gate for WhatsApp zip exports: see
// bounded-zip-archive.ts for how maxEntryUncompressedBytes bounds inflation
// itself, not just a post-hoc length check.
const WHATSAPP_ZIP_POLICY: ZipReadPolicy = {
  maxEntries: 20_000,
  maxEntryUncompressedBytes: 1024 * 1024 * 1024,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
};

export interface ParsedWhatsAppMessage {
  author: string;
  content: string;
  has_attachment?: boolean;
  sent_at: string;
}

export interface ParsedWhatsAppAttachment {
  bytes: Buffer;
  filename: string;
}

export interface ParsedWhatsAppChat {
  attachments: ParsedWhatsAppAttachment[];
  chatId: string;
  messages: ParsedWhatsAppMessage[];
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
const ZIP_EXT_RE = /\.zip$/i;
const WHATSAPP_TITLE_PREFIX_RE = /^WhatsApp Chat - /;
const WHATSAPP_LINE_SPLIT_RE = /\r?\n/;
const WHATSAPP_EXPORT_PROBE_RE = /\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}.*(?:-|]).*?:/;
const basename = zipBasename;
const WHATSAPP_TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([APap][Mm]))?$/;

// Chat ID is derived from the export file name. This preserves existing
// collector semantics while validation and collection share one parser.
const CHAT_ID_HASH_LENGTH = 16;

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

function extractMediaFiles(entries: ReturnType<typeof readZipEntries>): {
  mediaFiles: ParsedWhatsAppAttachment[];
  skippedMediaCount: number;
} {
  const mediaFiles: ParsedWhatsAppAttachment[] = [];
  let skippedMediaCount = 0;
  for (const entry of entries.filter((e) => isProbablyMediaEntry(e.name))) {
    try {
      mediaFiles.push({ bytes: entry.data(), filename: basename(entry.name) });
    } catch {
      // Oversized (policy violation) or corrupt media entry: excluded from
      // this parse. skippedMediaCount carries this forward so the caller
      // can surface a real coverage gap instead of silently under-reporting.
      skippedMediaCount += 1;
    }
  }
  return { mediaFiles, skippedMediaCount };
}

function findChatTextEntry(
  entries: ReturnType<typeof readZipEntries>,
  mediaFiles: ParsedWhatsAppAttachment[],
  skippedMediaCount: number
): ExtractedWhatsAppChatArtifact | null {
  const textEntries = entries.filter((entry) => TXT_EXT_RE.test(entry.name));
  for (const entry of textEntries) {
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
        skippedMediaCount,
        text,
      };
    }
  }
  return null;
}

function extractFromZip(bytes: Buffer): ExtractedWhatsAppChatArtifact | null {
  let entries: ReturnType<typeof readZipEntries>;
  try {
    entries = readZipEntries(bytes, WHATSAPP_ZIP_POLICY);
  } catch (err) {
    if (err instanceof ZipPolicyViolationError) {
      // biome-ignore lint/style/useErrorCause: cause IS passed — WhatsAppZipPolicyRejection's constructor forwards it via super(cause.message, { cause }); the linter doesn't see through the wrapper class.
      throw new WhatsAppZipPolicyRejection(err);
    }
    return null;
  }
  const { mediaFiles, skippedMediaCount } = extractMediaFiles(entries);
  return findChatTextEntry(entries, mediaFiles, skippedMediaCount);
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

export function parseWhatsAppChatFile(filename: string, content: string): ParsedWhatsAppChat {
  const messages: ParsedWhatsAppMessage[] = [];
  const participants = new Set<string>();
  const lines = content.split(WHATSAPP_LINE_SPLIT_RE);
  let current: ParsedWhatsAppMessage | null = null;

  for (const line of lines) {
    const match = LINE_RE.exec(line);
    // A line can match LINE_RE's shape yet carry an impossible date (31/02,
    // year < 1970). Stamping nowIso() there would date the message to the run
    // — non-deterministic, and `sent_at` is the manifest's semantic-time
    // source. Fold it into the preceding message instead, exactly as a
    // non-matching continuation line: the text survives, no date is invented.
    const sentAt = match ? parseWhatsAppDateTime(match[1] ?? "", match[2] ?? "") : null;
    if (match && sentAt) {
      if (current) {
        messages.push(current);
      }
      const author = (match[3] ?? "").trim();
      participants.add(author);
      current = { author, content: match[4] || "", sent_at: sentAt };
    } else if (current && line.trim()) {
      current.content += `\n${line}`;
    }
  }

  if (current) {
    messages.push(current);
  }

  for (const message of messages) {
    message.has_attachment = WHATSAPP_ATTACHMENT_RE.test(message.content);
  }

  return {
    attachments: [],
    chatId: createHash("sha256").update(filename).digest("hex").slice(0, CHAT_ID_HASH_LENGTH),
    title: whatsappChatTitleFromFilename(filename),
    participants: [...participants],
    messages,
  };
}
