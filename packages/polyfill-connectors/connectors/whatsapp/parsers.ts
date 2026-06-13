import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export interface ParsedWhatsAppMessage {
  author: string;
  content: string;
  has_attachment?: boolean;
  sent_at: string;
}

export interface ParsedWhatsAppChat {
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
const PATH_SPLIT_RE = /[\\/]/;
const ZIP_EOCD_SIGNATURE = 0x06_05_4b_50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02_01_4b_50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04_03_4b_50;
const ZIP_UTF8_FLAG = 0x08_00;
const ZIP_STORE_METHOD = 0;
const ZIP_DEFLATE_METHOD = 8;
const ZIP_EOCD_MIN_LENGTH = 22;
const ZIP_EOCD_MAX_COMMENT_LENGTH = 0xff_ff;

// Chat ID is derived from the export file name. This preserves existing
// collector semantics while validation and collection share one parser.
const CHAT_ID_HASH_LENGTH = 16;

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseWhatsAppDateTime(dateStr: string, timeStr: string): string | null {
  try {
    const date = new Date(`${dateStr} ${timeStr}`);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  } catch {
    /* fall through */
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
  text: string;
}

interface ZipEntry {
  data(): Buffer;
  name: string;
}

function basename(path: string): string {
  return path.split(PATH_SPLIT_RE).filter(Boolean).at(-1) ?? path;
}

function isProbablyMediaEntry(name: string): boolean {
  const clean = name.replaceAll("\\", "/");
  if (!clean || clean.endsWith("/") || clean.startsWith("__MACOSX/") || clean.includes("/__MACOSX/")) {
    return false;
  }
  return !TXT_EXT_RE.test(clean);
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const min = Math.max(0, bytes.length - ZIP_EOCD_MAX_COMMENT_LENGTH - ZIP_EOCD_MIN_LENGTH);
  for (let offset = bytes.length - ZIP_EOCD_MIN_LENGTH; offset >= min; offset--) {
    if (bytes.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

function decodeZipName(raw: Buffer, flags: number): string {
  const isUtf8 = Math.floor(flags / ZIP_UTF8_FLAG) % 2 === 1;
  return raw.toString(isUtf8 ? "utf8" : "latin1");
}

function readZipEntries(bytes: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    return [];
  }
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  let offset = bytes.readUInt32LE(eocdOffset + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      break;
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const fileNameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    if (nameStart + fileNameLength > bytes.length) {
      break;
    }
    const name = decodeZipName(bytes.subarray(nameStart, nameStart + fileNameLength), flags);
    if (localHeaderOffset + 30 > bytes.length || bytes.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_SIGNATURE) {
      offset = nameStart + fileNameLength + extraLength + commentLength;
      continue;
    }
    const localNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd <= bytes.length) {
      entries.push({
        name,
        data() {
          const compressed = bytes.subarray(dataStart, dataEnd);
          if (method === ZIP_STORE_METHOD) {
            return Buffer.from(compressed);
          }
          if (method === ZIP_DEFLATE_METHOD) {
            return inflateRawSync(compressed);
          }
          throw new Error(`unsupported_zip_compression_method:${method}`);
        },
      });
    }
    offset = nameStart + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function hasZipLocalFileSignature(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === ZIP_LOCAL_FILE_SIGNATURE;
}

export function extractWhatsAppChatArtifact(
  filename: string,
  input: Buffer | Uint8Array | string
): ExtractedWhatsAppChatArtifact | null {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (ZIP_EXT_RE.test(filename) || hasZipLocalFileSignature(bytes)) {
    const entries = readZipEntries(bytes);
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
          mediaFileCount: entries.filter((candidate) => isProbablyMediaEntry(candidate.name)).length,
          text,
        };
      }
    }
    return null;
  }
  const text = bytes.toString("utf8");
  return looksLikeWhatsAppChatExport(text)
    ? { chatFileName: filename, format: "whatsapp_chat_export", mediaFileCount: 0, text }
    : null;
}

export function parseWhatsAppChatFile(filename: string, content: string): ParsedWhatsAppChat {
  const messages: ParsedWhatsAppMessage[] = [];
  const participants = new Set<string>();
  const lines = content.split(WHATSAPP_LINE_SPLIT_RE);
  let current: ParsedWhatsAppMessage | null = null;

  for (const line of lines) {
    const match = LINE_RE.exec(line);
    if (match) {
      if (current) {
        messages.push(current);
      }
      const sentAt = parseWhatsAppDateTime(match[1] ?? "", match[2] ?? "") || nowIso();
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
    chatId: createHash("sha256").update(filename).digest("hex").slice(0, CHAT_ID_HASH_LENGTH),
    title: whatsappChatTitleFromFilename(filename),
    participants: [...participants],
    messages,
  };
}
