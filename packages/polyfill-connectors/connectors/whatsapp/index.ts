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

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runConnector } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { extractWhatsAppChatArtifact, nowIso, type ParsedWhatsAppChat, parseWhatsAppChatFile } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

// ─── Fingerprinted record emission ───────────────────────────────────────────

type EmitRecord = (stream: string, record: Record<string, unknown>) => Promise<void>;
type EmitEvent = (event: { message: string; type: "PROGRESS" }) => Promise<void>;
type FingerprintCursor = ReturnType<typeof openFingerprintCursor>;
const SUPPORTED_EXPORT_EXTENSIONS = [".txt", ".zip"] as const;
const MAX_DISCOVERY_DEPTH = 3;
const MAX_DISCOVERY_ENTRIES = 10_000;

function isSupportedExportFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return SUPPORTED_EXPORT_EXTENSIONS.some((extension) => lower.endsWith(extension));
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
  return parseWhatsAppChatFile(artifact.chatFileName, artifact.text);
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
    const chatsCursor = openFingerprintCursor(state.chats);
    const messagesCursor = openFingerprintCursor(state.messages);

    let files: string[];
    try {
      files = await discoverExportFiles(importDir);
    } catch {
      throw new Error(`import_dir_not_found: ${importDir} (set WHATSAPP_EXPORT_DIR or create the directory)`);
    }
    if (!files.length) {
      await emit({
        type: "SKIP_RESULT",
        stream: "chats",
        reason: "no_exports_found",
        message: `No .txt or .zip exports in ${importDir}. Export chats from WhatsApp and drop files here.`,
      });
      return;
    }

    for (const f of files) {
      const parsed = await parseExportFile("", f, emit);
      if (!parsed) {
        continue;
      }
      const first = parsed.messages[0]?.sent_at || null;
      const last = parsed.messages.at(-1)?.sent_at || null;

      if (requested.has("chats")) {
        await emitChatRecord(parsed, first, last, chatsCursor, emitRecord);
      }

      if (requested.has("messages")) {
        await emitMessageRecords(parsed, messagesCursor, emitRecord);
      }
      await emit({
        type: "PROGRESS",
        message: `Imported ${f}: ${parsed.messages.length} messages`,
      });
    }

    // Drop fingerprints for chats/messages that disappeared from the export
    // directory since the prior run (full-scan streams re-enumerate everything).
    if (requested.has("chats")) {
      chatsCursor.pruneStale();
    }
    if (requested.has("messages")) {
      messagesCursor.pruneStale();
    }

    // Emit STATE checkpoints so fingerprint maps survive into the next run.
    if (requested.has("chats")) {
      const cursor: Record<string, unknown> = { synced_at: nowIso() };
      if (chatsCursor.size() > 0) {
        cursor.fingerprints = chatsCursor.toState();
      }
      await emit({ type: "STATE", stream: "chats", cursor });
    }
    if (requested.has("messages")) {
      const cursor: Record<string, unknown> = { synced_at: nowIso() };
      if (messagesCursor.size() > 0) {
        cursor.fingerprints = messagesCursor.toState();
      }
      await emit({ type: "STATE", stream: "messages", cursor });
    }
  },
});
