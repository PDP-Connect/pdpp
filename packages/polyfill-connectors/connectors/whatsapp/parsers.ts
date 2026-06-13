import { createHash } from "node:crypto";

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
const WHATSAPP_TITLE_PREFIX_RE = /^WhatsApp Chat - /;
const WHATSAPP_LINE_SPLIT_RE = /\r?\n/;

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
