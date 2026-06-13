import { createHash } from "node:crypto";
import { extractWhatsAppChatArtifact, parseWhatsAppChatFile } from "./parsers.ts";

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
    readonly status: "included_not_imported" | "none_referenced" | "not_included";
  };
  readonly remediation: string | null;
  readonly status: WhatsAppChatExportValidationStatus;
  readonly warnings: readonly string[];
}

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
    return "included_not_imported";
  }
  if (referencedMediaFiles > 0) {
    return "not_included";
  }
  return "none_referenced";
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

  const artifact = extractWhatsAppChatArtifact(options.fileName ?? "WhatsApp Chat.txt", bytes);
  if (!artifact) {
    return { ...base, remediation: remediationFor("unsupported"), status: "unsupported" };
  }

  const parsed = parseWhatsAppChatFile(artifact.chatFileName, artifact.text);
  const dateRange = minMax(parsed.messages.map((message) => message.sent_at));
  const attachmentCount = parsed.messages.filter((message) => message.has_attachment).length;
  let status: WhatsAppChatExportValidationStatus = "valid";
  if (new Set(options.existingFileHashes ?? []).has(fileSha256)) {
    status = "duplicate";
  } else if (parsed.messages.length === 0) {
    status = "empty";
  }

  const warnings: string[] = [];
  if (attachmentCount > 0 && artifact.mediaFileCount > 0) {
    warnings.push(
      "This export includes media files. PDPP imports messages now and records media as present, but does not attach media files to records in this tranche."
    );
  } else if (attachmentCount > 0) {
    warnings.push("This text export references media, but the media files are not included in this import.");
  } else if (artifact.mediaFileCount > 0) {
    warnings.push(
      "This zip includes media-like files, but the parsed chat text did not reference them. PDPP records them as present but not attached."
    );
  }

  return {
    date_range: dateRange,
    detected_format: artifact.format,
    estimated_attachments: attachmentCount,
    estimated_chats: parsed.messages.length > 0 ? 1 : 0,
    estimated_messages: parsed.messages.length,
    estimated_participants: parsed.participants.length,
    estimated_records: parsed.messages.length + (parsed.messages.length > 0 ? 1 : 0),
    file_sha256: fileSha256,
    media_coverage: {
      attached_media_files: artifact.mediaFileCount,
      referenced_media_files: attachmentCount,
      status: mediaCoverageStatus(artifact.mediaFileCount, attachmentCount),
    },
    remediation: remediationFor(status),
    status,
    warnings,
  };
}
