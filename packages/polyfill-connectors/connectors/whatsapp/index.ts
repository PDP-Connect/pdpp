#!/usr/bin/env node

/**
 * PDPP WhatsApp Connector (v0.1.0)
 *
 * Auth: none (file-based). User exports chats from the WhatsApp app
 * ("Chat" → menu → Export Chat → Without Media) and drops .txt files
 * (or .zip containing .txt) into WHATSAPP_EXPORT_DIR.
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
import { runConnector } from "../../src/connector-runtime.ts";

interface ParsedMessage {
  author: string;
  content: string;
  has_attachment?: boolean;
  sent_at: string;
}

interface ParsedChat {
  chatId: string;
  messages: ParsedMessage[];
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
const ATTACHMENT_RE = /<attached: |<Media omitted>|image omitted|video omitted|audio omitted|document omitted/i;
const TXT_EXT_RE = /\.txt$/i;
const WHATSAPP_TITLE_PREFIX_RE = /^WhatsApp Chat - /;
const WHATSAPP_LINE_SPLIT_RE = /\r?\n/;

// Chat ID derived from filename; 16 hex chars is collision-safe for a user's
// local export dir.
const CHAT_ID_HASH_LENGTH = 16;

const nowIso = (): string => new Date().toISOString();

function parseDateTime(dateStr: string, timeStr: string): string | null {
  try {
    const d = new Date(`${dateStr} ${timeStr}`);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  } catch {
    /* fall through */
  }
  return null;
}

function parseChatFile(filename: string, content: string): ParsedChat {
  const messages: ParsedMessage[] = [];
  const participants = new Set<string>();
  const lines = content.split(WHATSAPP_LINE_SPLIT_RE);
  let current: ParsedMessage | null = null;
  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (m) {
      if (current) {
        messages.push(current);
      }
      const sentAt = parseDateTime(m[1] ?? "", m[2] ?? "") || nowIso();
      const author = (m[3] ?? "").trim();
      participants.add(author);
      const body = m[4] || "";
      current = { author, content: body, sent_at: sentAt };
    } else if (current && line.trim()) {
      current.content += `\n${line}`;
    }
  }
  if (current) {
    messages.push(current);
  }

  for (const msg of messages) {
    msg.has_attachment = ATTACHMENT_RE.test(msg.content);
  }

  const chatId = createHash("sha256").update(filename).digest("hex").slice(0, CHAT_ID_HASH_LENGTH);
  return {
    chatId,
    title: filename.replace(TXT_EXT_RE, "").replace(WHATSAPP_TITLE_PREFIX_RE, ""),
    participants: [...participants],
    messages,
  };
}

runConnector({
  name: "whatsapp",
  async collect({ requested, emit, emitRecord }) {
    const importDir = process.env.WHATSAPP_EXPORT_DIR || join(homedir(), ".pdpp/imports/whatsapp");

    let files: string[];
    try {
      files = (await readdir(importDir)).filter((f) => f.toLowerCase().endsWith(".txt"));
    } catch {
      throw new Error(`import_dir_not_found: ${importDir} (set WHATSAPP_EXPORT_DIR or create the directory)`);
    }
    if (!files.length) {
      await emit({
        type: "SKIP_RESULT",
        stream: "chats",
        reason: "no_exports_found",
        message: `No .txt exports in ${importDir}. Export chats from WhatsApp and drop files here.`,
      });
      return;
    }

    for (const f of files) {
      const content = await readFile(join(importDir, f), "utf8").catch((): string => "");
      if (!content) {
        continue;
      }
      const parsed = parseChatFile(f, content);
      const first = parsed.messages[0]?.sent_at || null;
      const last = parsed.messages.at(-1)?.sent_at || null;

      if (requested.has("chats")) {
        await emitRecord("chats", {
          id: parsed.chatId,
          title: parsed.title,
          participants: parsed.participants,
          message_count: parsed.messages.length,
          first_message_date: first,
          last_message_date: last,
        });
      }

      if (requested.has("messages")) {
        for (let i = 0; i < parsed.messages.length; i++) {
          const m = parsed.messages[i];
          if (!m) {
            continue;
          }
          await emitRecord("messages", {
            id: `${parsed.chatId}:${i}`,
            chat_id: parsed.chatId,
            author: m.author,
            content: m.content,
            has_attachment: !!m.has_attachment,
            sent_at: m.sent_at,
          });
        }
      }
      await emit({
        type: "PROGRESS",
        message: `Imported ${f}: ${parsed.messages.length} messages`,
      });
    }
  },
});
