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

import { createInterface } from 'node:readline';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resourceSet } from '../../src/scope-filters.js';

const rl = createInterface({ input: process.stdin, terminal: false });
const emit = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const flushAndExit = (code) => {
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else process.exit(code);
};
const fail = (m, r = false) => { emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable: r } }); flushAndExit(1); };
const nowIso = () => new Date().toISOString();

// WhatsApp export line formats:
//   iOS: [M/D/YY, H:MM:SS AM] Author: Message
//   iOS: [YYYY-MM-DD, HH:MM:SS] Author: Message
//   Android: M/D/YY, H:MM - Author: Message
//   Android: DD/MM/YYYY, HH:MM - Author: Message
const LINE_RE = /^\s*(?:\[)?(\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)(?:\])?\s*[-–]?\s*([^:]+?):\s?(.*)$/;

function parseDateTime(dateStr, timeStr) {
  try {
    const d = new Date(`${dateStr} ${timeStr}`);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch { /* fall through */ }
  return null;
}

function parseChatFile(filename, content) {
  const messages = [];
  const participants = new Set();
  const lines = content.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (m) {
      if (current) messages.push(current);
      const sentAt = parseDateTime(m[1], m[2]) || nowIso();
      const author = m[3].trim();
      participants.add(author);
      const body = m[4] || '';
      current = { author, content: body, sent_at: sentAt };
    } else if (current && line.trim()) {
      current.content += '\n' + line;
    }
  }
  if (current) messages.push(current);

  for (const msg of messages) {
    msg.has_attachment = /<attached: |<Media omitted>|image omitted|video omitted|audio omitted|document omitted/i.test(msg.content);
  }

  const chatId = createHash('sha256').update(filename).digest('hex').slice(0, 16);
  return {
    chatId,
    title: filename.replace(/\.txt$/i, '').replace(/^WhatsApp Chat - /, ''),
    participants: [...participants],
    messages,
  };
}

async function main() {
  const startMsg = await new Promise((r, j) => rl.once('line', (l) => { try { r(JSON.parse(l)); } catch (e) { j(e); } }));
  if (startMsg.type !== 'START') return fail('Expected START');

  const importDir = process.env.WHATSAPP_EXPORT_DIR || join(homedir(), '.pdpp/imports/whatsapp');

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  let files;
  try {
    files = (await readdir(importDir)).filter((f) => f.toLowerCase().endsWith('.txt'));
  } catch (err) {
    return fail(`import_dir_not_found: ${importDir} (set WHATSAPP_EXPORT_DIR or create the directory)`);
  }
  if (!files.length) {
    emit({ type: 'SKIP_RESULT', reason: 'no_exports_found', message: `No .txt exports in ${importDir}. Export chats from WhatsApp and drop files here.` });
    emit({ type: 'DONE', status: 'succeeded', records_emitted: 0 });
    flushAndExit(0);
  }

  const emittedAt = nowIso();
  let total = 0;
  const resFilters = new Map();
  for (const [n, r] of requested) resFilters.set(n, resourceSet(r));
  const emitRecord = (s, d) => {
    if (d.id == null) return;
    const resSet = resFilters.get(s);
    if (resSet && !resSet.has(String(d.id))) return;
    emit({ type: 'RECORD', stream: s, key: d.id, data: d, emitted_at: emittedAt });
    total++;
  };

  for (const f of files) {
    const content = await readFile(join(importDir, f), 'utf8').catch(() => '');
    if (!content) continue;
    const parsed = parseChatFile(f, content);
    const first = parsed.messages[0]?.sent_at || null;
    const last = parsed.messages[parsed.messages.length - 1]?.sent_at || null;

    if (requested.has('chats')) {
      emitRecord('chats', {
        id: parsed.chatId,
        title: parsed.title,
        participants: parsed.participants,
        message_count: parsed.messages.length,
        first_message_date: first,
        last_message_date: last,
      });
    }

    if (requested.has('messages')) {
      for (let i = 0; i < parsed.messages.length; i++) {
        const m = parsed.messages[i];
        emitRecord('messages', {
          id: `${parsed.chatId}:${i}`,
          chat_id: parsed.chatId,
          author: m.author,
          content: m.content,
          has_attachment: !!m.has_attachment,
          sent_at: m.sent_at,
        });
      }
    }
    emit({ type: 'PROGRESS', message: `Imported ${f}: ${parsed.messages.length} messages` });
  }

  emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e?.message || String(e);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: false } });
  flushAndExit(1);
});
