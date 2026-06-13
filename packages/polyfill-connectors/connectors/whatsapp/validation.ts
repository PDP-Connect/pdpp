import { createHash } from "node:crypto";
import { parseWhatsAppChatFile } from "./parsers.ts";

export type WhatsAppChatExportValidationStatus = "valid" | "duplicate" | "empty" | "unsupported" | "too_large";

export interface WhatsAppChatExportValidationOptions {
  readonly existingFileHashes?: readonly string[];
  readonly fileName?: string | null;
  readonly maxFileBytes?: number | null;
}

export interface WhatsAppChatExportValidation {
  readonly date_range: { readonly end: string | null; readonly start: string | null };
  readonly detected_format: "whatsapp_chat_export" | "unsupported";
  readonly estimated_attachments: number;
  readonly estimated_chats: number;
  readonly estimated_messages: number;
  readonly estimated_participants: number;
  readonly estimated_records: number;
  readonly file_sha256: string;
  readonly media_coverage: {
    readonly attached_media_files: number;
    readonly referenced_media_files: number;
    readonly status: "none_referenced" | "not_included";
  };
  readonly remediation: string | null;
  readonly status: WhatsAppChatExportValidationStatus;
  readonly warnings: readonly string[];
}

const WHATSAPP_EXPORT_LINE_RE = /\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}.*(?:-|]).*?:/;

function minMax(values: readonly string[]): { end: string | null; start: string | null } {
  const sorted = values.filter(Boolean).sort();
  return { end: sorted.at(-1) ?? null, start: sorted[0] ?? null };
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
      return "Choose a WhatsApp chat export text file. Account reports, screenshots, and encrypted backups are not chat exports.";
    case "valid":
      return null;
    default:
      return null;
  }
}

function looksLikeWhatsAppExport(text: string): boolean {
  return WHATSAPP_EXPORT_LINE_RE.test(text);
}

export function validateWhatsAppChatExportArtifact(
  input: Uint8Array | string,
  options: WhatsAppChatExportValidationOptions = {}
): WhatsAppChatExportValidation {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  const base = {
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
  };

  if (options.maxFileBytes != null && bytes.byteLength > options.maxFileBytes) {
    return { ...base, remediation: remediationFor("too_large"), status: "too_large" };
  }

  const text = bytes.toString("utf8");
  if (!looksLikeWhatsAppExport(text)) {
    return { ...base, remediation: remediationFor("unsupported"), status: "unsupported" };
  }

  const parsed = parseWhatsAppChatFile(options.fileName ?? "WhatsApp Chat.txt", text);
  const dateRange = minMax(parsed.messages.map((message) => message.sent_at));
  const attachmentCount = parsed.messages.filter((message) => message.has_attachment).length;
  let status: WhatsAppChatExportValidationStatus = "valid";
  if (new Set(options.existingFileHashes ?? []).has(fileSha256)) {
    status = "duplicate";
  } else if (parsed.messages.length === 0) {
    status = "empty";
  }

  const warnings =
    attachmentCount > 0
      ? ["This text export references media, but the media files are not included in this import."]
      : [];

  return {
    date_range: dateRange,
    detected_format: "whatsapp_chat_export",
    estimated_attachments: attachmentCount,
    estimated_chats: parsed.messages.length > 0 ? 1 : 0,
    estimated_messages: parsed.messages.length,
    estimated_participants: parsed.participants.length,
    estimated_records: parsed.messages.length + (parsed.messages.length > 0 ? 1 : 0),
    file_sha256: fileSha256,
    media_coverage: {
      attached_media_files: 0,
      referenced_media_files: attachmentCount,
      status: attachmentCount > 0 ? "not_included" : "none_referenced",
    },
    remediation: remediationFor(status),
    status,
    warnings,
  };
}
