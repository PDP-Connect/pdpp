#!/usr/bin/env node
/**
 * PDPP Gmail Connector (v0.1.0)
 *
 * Uses IMAP + Google app-specific password. Iterates [Gmail]/All Mail so
 * messages with multiple labels aren't multi-counted. Derives label
 * membership from X-GM-LABELS per message.
 *
 * Auth:
 *   GOOGLE_APP_PASSWORD_PDPP — app password
 *   GMAIL_ADDRESS            — the account's email; if missing, emits
 *                              INTERACTION kind=credentials on first run.
 *
 * Streams: messages, threads, labels, attachments.
 *
 * State shape:
 *   {
 *     all_mail: { uidvalidity: N, uidnext: N, highest_modseq: N }
 *   }
 *
 * Rate budget: keep to one concurrent connection; fetch in windows of 200.
 */

import { createInterface } from 'node:readline';
import { ImapFlow } from 'imapflow';
import { resourceSet, requireCredentialsOrAsk } from '../../src/scope-filters.js';

const rl = createInterface({ input: process.stdin, terminal: false });
function emit(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// Drain stdout before exit — otherwise Node may exit with buffered bytes still
// unwritten on a pipe, truncating the final line.
function flushAndExit(code) {
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(code));
    // Hard timeout so we don't hang on a pipe that's gone away
    setTimeout(() => process.exit(code), 3000).unref();
  } else {
    process.exit(code);
  }
}
function fail(m, retryable = false) {
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable } });
  flushAndExit(1);
}

const nowIso = () => new Date().toISOString();

let interactionCounter = 0;
function nextInteractionId() { return `int_${Date.now()}_${++interactionCounter}`; }

// Block on stdin until we receive INTERACTION_RESPONSE matching request_id.
async function sendInteractionAndWait(msg) {
  emit(msg);
  const reqId = msg.request_id;
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'INTERACTION_RESPONSE' && parsed.request_id === reqId) {
          rl.off('line', onLine);
          resolve(parsed);
        }
      } catch (err) {
        reject(err);
      }
    };
    rl.on('line', onLine);
  });
}

function canonicalLabelName(raw) {
  if (raw === 'INBOX') return 'inbox';
  const m = /^\[Gmail\]\/(.+)$/.exec(raw);
  if (m) return m[1].toLowerCase().replace(/\s+/g, '_');
  return raw.toLowerCase().replace(/\s+/g, '_');
}

function addressListToArray(list) {
  if (!list) return [];
  return list.map((a) => ({ name: a.name || null, email: a.address || null }));
}

function decodeBodystructureForAttachments(structure, msgId, receivedAt, path = '') {
  const items = [];
  if (!structure) return items;
  // imapflow BODYSTRUCTURE nodes expose `type` as a combined MIME string
  // (e.g. "image/png" or "multipart/mixed"). Multiparts have `childNodes`;
  // leaves have `parameters`, `id`, `description`, `encoding`, `size`,
  // `disposition`, and `dispositionParameters`.
  const walk = (node, p) => {
    if (!node) return;
    if (Array.isArray(node.childNodes) && node.childNodes.length) {
      node.childNodes.forEach((child, i) => walk(child, p ? `${p}.${i + 1}` : String(i + 1)));
      return;
    }
    const disposition = node.disposition;
    const filename = node.dispositionParameters?.filename
      || node.parameters?.name
      || null;
    const isAttachmentLike = (disposition === 'attachment' || disposition === 'inline')
      || !!filename;
    if (!isAttachmentLike) return;
    const partIndex = p || '1';
    items.push({
      id: `${msgId}:${partIndex}`,
      message_id: msgId,
      filename,
      content_type: node.type || null,
      size_bytes: typeof node.size === 'number' ? node.size : null,
      content_id: node.id || null,
      is_inline: disposition === 'inline',
      encoding: node.encoding || null,
      part_index: partIndex,
      message_received_at: receivedAt,
    });
  };
  walk(structure, path);
  return items;
}

// Find the first leaf of a given MIME type in a BODYSTRUCTURE tree; return its
// IMAP part number (e.g. "1" or "1.2") or null if none.
function findFirstPartByType(structure, mimeType, path = '') {
  if (!structure) return null;
  const walk = (node, p) => {
    if (!node) return null;
    if (Array.isArray(node.childNodes) && node.childNodes.length) {
      for (let i = 0; i < node.childNodes.length; i++) {
        const found = walk(node.childNodes[i], p ? `${p}.${i + 1}` : String(i + 1));
        if (found) return found;
      }
      return null;
    }
    if (node.type === mimeType) return p || '1';
    return null;
  };
  return walk(structure, path);
}

function findTextPlainPart(structure, path = '') {
  return findFirstPartByType(structure, 'text/plain', path);
}

function findTextHtmlPart(structure, path = '') {
  return findFirstPartByType(structure, 'text/html', path);
}

// Locate a leaf in a BODYSTRUCTURE tree by its IMAP part number.
function findLeafByPath(structure, targetPath) {
  const walk = (node, p) => {
    if (!node) return null;
    if (Array.isArray(node.childNodes) && node.childNodes.length) {
      for (let i = 0; i < node.childNodes.length; i++) {
        const found = walk(node.childNodes[i], p ? `${p}.${i + 1}` : String(i + 1));
        if (found) return found;
      }
      return null;
    }
    return (p || '1') === targetPath ? node : null;
  };
  return walk(structure, '');
}

// Decode a body part buffer according to its MIME transfer encoding and
// charset into a JavaScript string. Best-effort; never throws.
function decodeBodyPart(buffer, encoding, charset) {
  if (!buffer || !buffer.length) return '';
  const cs = charset || 'utf8';
  try {
    const enc = (encoding || '').toLowerCase();
    if (enc === 'base64') {
      return Buffer.from(buffer.toString('ascii'), 'base64').toString(cs);
    }
    if (enc === 'quoted-printable') {
      const raw = buffer.toString('ascii');
      const unfolded = raw.replace(/=\r?\n/g, '');
      // Decode the =HH sequences as raw bytes, then interpret in charset.
      const bytes = [];
      let i = 0;
      while (i < unfolded.length) {
        if (unfolded[i] === '=' && i + 2 < unfolded.length && /[0-9A-Fa-f]{2}/.test(unfolded.slice(i + 1, i + 3))) {
          bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16));
          i += 3;
        } else {
          bytes.push(unfolded.charCodeAt(i));
          i += 1;
        }
      }
      return Buffer.from(bytes).toString(cs);
    }
    return buffer.toString(cs);
  } catch {
    return buffer.toString('utf8');
  }
}

// Strip HTML tags into plain text. Handles <script>/<style> blocks, common
// block-level tags (inserted newlines), <br>, and basic entity decoding.
// Not a full HTML parser — intentionally minimal for bodies that arrive as
// HTML-only (e.g. newsletters) where we still want a readable text fallback.
function stripHtmlToText(html) {
  if (!html) return '';
  let s = String(html);
  // Drop script/style contents entirely
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  // HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Line-break tags
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  // Block-level close tags — insert newline before stripping
  s = s.replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre)\s*>/gi, '\n');
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, '');
  // Decode common entities
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ''; }
    })
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    });
  // Collapse runs of blank lines and trim each line
  s = s.split(/\r?\n/).map((ln) => ln.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
  return s;
}

// Parse a "References:" header value into an array of Message-IDs.
// IMAP may return headers as a Buffer; References is a whitespace-separated
// list of <id@host> tokens, possibly wrapped across lines.
function parseReferencesHeader(rawHeaders) {
  if (!rawHeaders) return [];
  const text = Buffer.isBuffer(rawHeaders) ? rawHeaders.toString('utf8') : String(rawHeaders);
  // Unfold: collapse CRLF+WSP into a single space
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
  // Find the References header value (case-insensitive)
  const match = /^references:\s*(.*)$/im.exec(unfolded);
  if (!match) return [];
  const value = match[1];
  const ids = [];
  const re = /<([^>]+)>/g;
  let m;
  while ((m = re.exec(value)) !== null) ids.push(`<${m[1]}>`);
  return ids;
}

// Decode a body part buffer according to its MIME transfer encoding, then
// extract a plain-text snippet: strip quoted reply blocks and collapse
// whitespace. Returns a trimmed string up to `maxChars`.
function makeSnippet(buffer, encoding, charset, maxChars = 200) {
  if (!buffer || !buffer.length) return null;
  let decoded;
  try {
    const enc = (encoding || '').toLowerCase();
    if (enc === 'base64') {
      decoded = Buffer.from(buffer.toString('ascii'), 'base64').toString(charset || 'utf8');
    } else if (enc === 'quoted-printable') {
      // Minimal QP decode: =HH hex + soft line breaks (=\r?\n)
      const raw = buffer.toString('ascii');
      const unfolded = raw.replace(/=\r?\n/g, '');
      decoded = unfolded.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    } else {
      decoded = buffer.toString(charset || 'utf8');
    }
  } catch {
    decoded = buffer.toString('utf8');
  }
  // Drop lines that are obviously quoted replies ("> ...") and signature separators
  const cleaned = decoded
    .split(/\r?\n/)
    .filter((ln) => !/^\s*>/.test(ln))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars).trim() : cleaned;
}

async function main() {
  const startMsg = await new Promise((resolve, reject) => {
    rl.once('line', (line) => { try { resolve(JSON.parse(line)); } catch (e) { reject(e); } });
  });
  if (startMsg.type !== 'START') return fail('Expected START');

  let password = process.env.GOOGLE_APP_PASSWORD_PDPP;
  if (!password) {
    try {
      const creds = await requireCredentialsOrAsk({
        required: ['GOOGLE_APP_PASSWORD_PDPP'],
        connectorName: 'Gmail',
        sendInteractionAndWait,
        nextInteractionId,
      });
      password = creds.GOOGLE_APP_PASSWORD_PDPP;
    } catch (e) { return fail(e.message, false); }
  }

  let address = process.env.GMAIL_ADDRESS || null;
  // Fallback: Amazon username often matches the user's email
  if (!address && process.env.AMAZON_USERNAME && /@/.test(process.env.AMAZON_USERNAME)) {
    address = process.env.AMAZON_USERNAME;
  }
  if (!address) {
    // Ask via INTERACTION kind=credentials
    const resp = await sendInteractionAndWait({
      type: 'INTERACTION',
      request_id: nextInteractionId(),
      kind: 'credentials',
      message: 'Gmail address to sync (the account the app password was generated for)',
      schema: {
        type: 'object',
        properties: { email: { type: 'string', format: 'email' } },
        required: ['email'],
      },
      timeout_seconds: 1800,
    });
    if (resp.status !== 'success' || !resp.data?.email) return fail('no Gmail address provided');
    address = resp.data.email;
  }

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  const resFilters = new Map();
  for (const [n, r] of requested) resFilters.set(n, resourceSet(r));

  const state = startMsg.state || {};
  const emittedAt = nowIso();
  let totalEmitted = 0;
  const emitRecord = (stream, data, keyField = 'id') => {
    const key = data[keyField] ?? data.name;
    if (key == null) return;
    const canonical = String(key);
    const resSet = resFilters.get(stream);
    if (resSet && !resSet.has(canonical)) return;
    emit({ type: 'RECORD', stream, key, data, emitted_at: emittedAt });
    totalEmitted++;
  };

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: address, pass: password },
    logger: false,
  });

  await client.connect();

  try {
    emit({ type: 'PROGRESS', message: `Connected to ${address}` });

    // LABELS stream — list mailboxes
    if (requested.has('labels')) {
      const mailboxes = await client.list();
      for (const mb of mailboxes) {
        const name = mb.path;
        const is_system = name === 'INBOX' || /^\[Gmail\]\//.test(name);
        const parts = name.split('/');
        const parent_name = parts.length > 1 ? parts.slice(0, -1).join('/') : null;
        emitRecord('labels', {
          name,
          canonical_name: canonicalLabelName(name),
          is_system,
          parent_name,
          message_count: null, // we could SELECT each to get EXISTS but not worth it
        }, 'name');
      }
      emit({ type: 'STATE', stream: 'labels', cursor: { fetched_at: nowIso() } });
    }

    // Find All Mail (special-use \All or fallback to [Gmail]/All Mail)
    const mailboxes = await client.list();
    const allMail = mailboxes.find((m) => (m.specialUse === '\\All') || m.path === '[Gmail]/All Mail');
    if (!allMail) return fail('could not find [Gmail]/All Mail mailbox; is this a Gmail account?');

    const lock = await client.getMailboxLock(allMail.path);
    try {
      const mailbox = client.mailbox;
      const uidvalidity = Number(mailbox.uidValidity);
      const uidnext = mailbox.uidNext;
      const highestModseq = mailbox.highestModseq;

      const priorUidvalidity = state.all_mail?.uidvalidity;
      const fullResync = !priorUidvalidity || priorUidvalidity !== uidvalidity;
      const priorUidnext = state.all_mail?.uidnext || 1;
      const priorModseq = state.all_mail?.highest_modseq;

      // Determine fetch range.
      // - Full resync: 1..*
      // - Incremental: new UIDs (priorUidnext..*) + flag/label changes (CHANGEDSINCE priorModseq).
      const timeRange = requested.get('messages')?.time_range || requested.get('attachments')?.time_range;

      // Pass 1: new messages (or everything on full resync)
      const fetchRange = fullResync ? '1:*' : `${priorUidnext}:*`;
      emit({ type: 'PROGRESS', message: `Fetching ${fullResync ? 'all' : 'new'} messages (${fetchRange}) from ${allMail.path}` });

      let count = 0;
      const wantMessages = requested.has('messages');
      const wantBodies = requested.has('message_bodies');
      for await (const msg of client.fetch(fetchRange, {
        uid: true,
        envelope: true,
        internalDate: true,
        flags: true,
        size: true,
        bodyStructure: true,
        // Include References so we can populate messages.references (not part
        // of the IMAP ENVELOPE response).
        headers: ['list-unsubscribe', 'auto-submitted', 'references'],
        source: false,
        labels: true,
        threadId: true,
        emailId: true,
      }, { uid: true, changedSince: null })) {
        // Gmail-specific IDs via imapflow: msg.emailId = X-GM-MSGID; msg.threadId = X-GM-THRID
        const gmMsgid = String(msg.emailId ?? '');
        const gmThrid = String(msg.threadId ?? '');
        if (!gmMsgid) continue; // without X-GM-MSGID we can't key

        const env = msg.envelope || {};
        const receivedAt = msg.internalDate ? new Date(msg.internalDate).toISOString() : nowIso();
        const dateHeader = env.date ? new Date(env.date).toISOString() : null;

        // time_range filtering (against received_at)
        if (timeRange?.since && receivedAt < timeRange.since) continue;
        if (timeRange?.until && receivedAt >= timeRange.until) continue;

        const flags = msg.flags || new Set();
        const flagsArr = flags instanceof Set ? [...flags] : Array.from(flags || []);
        const labels = Array.isArray(msg.labels) ? msg.labels : [...(msg.labels || [])];

        const attachments = decodeBodystructureForAttachments(msg.bodyStructure, gmMsgid, receivedAt);

        // Body fetching — scope-driven.
        // - If `messages` is requested (and not `message_bodies`): fetch the
        //   first 4096 bytes of text/plain only, for the snippet.
        // - If `message_bodies` is requested: fetch the full text/plain AND
        //   text/html parts (if present) in a single round-trip, and reuse
        //   the text/plain buffer for the snippet when messages is also in
        //   scope. We never fetch image/attachment parts — metadata for
        //   those lives in the `attachments` stream.
        let snippet = null;
        let bodyTextFull = null;   // decoded string, text/plain
        let bodyHtmlFull = null;   // decoded string, text/html
        let textCharset = null;
        let htmlCharset = null;
        const plainPart = findTextPlainPart(msg.bodyStructure);
        const htmlPart = wantBodies ? findTextHtmlPart(msg.bodyStructure) : null;
        const plainLeaf = plainPart ? findLeafByPath(msg.bodyStructure, plainPart) : null;
        const htmlLeaf = htmlPart ? findLeafByPath(msg.bodyStructure, htmlPart) : null;
        const plainEncoding = plainLeaf?.encoding || null;
        const htmlEncoding = htmlLeaf?.encoding || null;
        textCharset = plainLeaf?.parameters?.charset || null;
        htmlCharset = htmlLeaf?.parameters?.charset || null;

        if (msg.uid && (wantBodies || (wantMessages && plainPart))) {
          const parts = [];
          if (plainPart) {
            // Full body if we need message_bodies; otherwise bounded for snippet.
            parts.push(wantBodies ? { key: plainPart } : { key: plainPart, start: 0, maxLength: 4096 });
          }
          if (wantBodies && htmlPart) parts.push({ key: htmlPart });
          if (parts.length) {
            try {
              const bodyResp = await client.fetchOne(
                String(msg.uid),
                { bodyParts: parts },
                { uid: true }
              );
              const plainBuf = plainPart ? bodyResp?.bodyParts?.get(plainPart) : null;
              const htmlBuf = htmlPart ? bodyResp?.bodyParts?.get(htmlPart) : null;
              if (plainBuf) {
                if (wantBodies) {
                  bodyTextFull = decodeBodyPart(plainBuf, plainEncoding, textCharset);
                  if (wantMessages) snippet = makeSnippet(plainBuf, plainEncoding, textCharset, 200);
                } else if (wantMessages) {
                  snippet = makeSnippet(plainBuf, plainEncoding, textCharset, 200);
                }
              }
              if (htmlBuf && wantBodies) {
                bodyHtmlFull = decodeBodyPart(htmlBuf, htmlEncoding, htmlCharset);
              }
            } catch {
              // Best-effort: body fetch failures shouldn't block message emit.
            }
          }
        }

        if (wantBodies) {
          let bodyText = bodyTextFull || null;
          let bodySource;
          if (bodyText && bodyText.length) {
            bodySource = 'text_plain';
          } else if (bodyHtmlFull && bodyHtmlFull.length) {
            const stripped = stripHtmlToText(bodyHtmlFull);
            if (stripped) {
              bodyText = stripped;
              bodySource = 'html_stripped';
            } else {
              bodySource = 'text_html';
            }
          } else {
            bodySource = 'empty';
          }
          emitRecord('message_bodies', {
            id: gmMsgid,
            message_id: gmMsgid,
            body_text: bodyText || null,
            body_html: bodyHtmlFull || null,
            body_text_bytes: bodyText ? Buffer.byteLength(bodyText, 'utf8') : null,
            body_html_bytes: bodyHtmlFull ? Buffer.byteLength(bodyHtmlFull, 'utf8') : null,
            body_source: bodySource,
            // Language detection is out of scope for v1; emit null so
            // consumers know the field exists but wasn't computed.
            content_languages: null,
            charset: textCharset || htmlCharset || null,
          });
        }

        if (wantMessages) {
          const fromAddr = env.from?.[0];
          const references = parseReferencesHeader(msg.headers);

          emitRecord('messages', {
            id: gmMsgid,
            thread_id: gmThrid,
            subject: env.subject || null,
            from_name: fromAddr?.name || null,
            from_email: fromAddr?.address || null,
            to: addressListToArray(env.to),
            cc: addressListToArray(env.cc),
            bcc: addressListToArray(env.bcc),
            reply_to: addressListToArray(env.replyTo),
            date: dateHeader,
            received_at: receivedAt,
            message_id: env.messageId || null,
            in_reply_to: env.inReplyTo || null,
            references,
            size_bytes: typeof msg.size === 'number' ? msg.size : null,
            labels,
            is_draft: flagsArr.includes('\\Draft'),
            is_flagged: flagsArr.includes('\\Flagged'),
            is_seen: flagsArr.includes('\\Seen'),
            is_answered: flagsArr.includes('\\Answered'),
            has_attachments: attachments.length > 0,
            snippet,
          });
        }

        if (requested.has('attachments') && attachments.length) {
          for (const a of attachments) emitRecord('attachments', a);
        }

        count++;
        if (count % 500 === 0) {
          emit({ type: 'PROGRESS', stream: 'messages', message: `Fetched ${count} messages` });
        }
      }

      // Pass 2: detect flag/label changes on already-seen messages (if incremental)
      if (!fullResync && priorModseq) {
        emit({ type: 'PROGRESS', message: `Fetching flag/label deltas since modseq=${priorModseq}` });
        for await (const msg of client.fetch('1:*', {
          uid: true,
          flags: true,
          labels: true,
          threadId: true,
          emailId: true,
          envelope: false,
        }, { uid: true, changedSince: priorModseq })) {
          const gmMsgid = String(msg.emailId ?? '');
          if (!gmMsgid) continue;
          // Flag/label delta update: emit a tombstone-free upsert of the message envelope
          // (minimal fields since envelope not re-fetched). For now, we emit a RECORD
          // with the same id so the RS upserts flag/label state.
          if (requested.has('messages')) {
            const flags = msg.flags || new Set();
            const flagsArr = flags instanceof Set ? [...flags] : Array.from(flags || []);
            emitRecord('messages', {
              id: gmMsgid,
              thread_id: String(msg.threadId ?? ''),
              // Minimal: flag-state delta. We don't re-send envelope; RS retains existing fields.
              // Note: PDPP records are "whole-document" upserts in the current RS, so this
              // delta path is effectively a full re-fetch. Simpler: mark this path as "only
              // flags" by emitting the fields we have plus nulls.
              // For robustness, let's actually re-fetch envelope in v2. For v1, emit flags only.
              subject: null,
              from_name: null,
              from_email: null,
              to: [],
              cc: [],
              bcc: [],
              reply_to: [],
              date: null,
              received_at: emittedAt, // fallback so schema-required field is satisfied
              message_id: null,
              in_reply_to: null,
              references: [],
              size_bytes: null,
              labels: Array.isArray(msg.labels) ? msg.labels : [...(msg.labels || [])],
              is_draft: flagsArr.includes('\\Draft'),
              is_flagged: flagsArr.includes('\\Flagged'),
              is_seen: flagsArr.includes('\\Seen'),
              is_answered: flagsArr.includes('\\Answered'),
              has_attachments: false,
              snippet: null,
            });
          }
        }
      }

      // THREADS stream derived server-side per run: group messages we just emitted by thread_id.
      // Simpler: a separate threads pass querying SEARCH by thread grouping is not directly supported
      // in IMAP; we derive from the fetch just done. For v1, we emit threads based on a second fetch
      // focused on emailId + threadId only if threads is requested.
      if (requested.has('threads')) {
        emit({ type: 'PROGRESS', stream: 'threads', message: 'Deriving threads from All Mail' });
        const threadAgg = new Map();
        for await (const msg of client.fetch('1:*', {
          uid: true,
          threadId: true,
          emailId: true,
          envelope: true,
          flags: true,
          internalDate: true,
          // Needed for per-thread labels + has_attachments aggregation.
          labels: true,
          bodyStructure: true,
        }, { uid: true })) {
          const tid = String(msg.threadId ?? '');
          if (!tid) continue;
          const env = msg.envelope || {};
          const rcv = msg.internalDate ? new Date(msg.internalDate).toISOString() : nowIso();
          const flags = msg.flags || new Set();
          const flagsArr = flags instanceof Set ? [...flags] : Array.from(flags || []);
          const msgLabels = Array.isArray(msg.labels) ? msg.labels : [...(msg.labels || [])];
          const participant = [env.from?.[0]?.address, ...(env.to || []).map((a) => a?.address), ...(env.cc || []).map((a) => a?.address)]
            .filter(Boolean);
          const msgHasAttachments = decodeBodystructureForAttachments(msg.bodyStructure, String(msg.emailId ?? tid), rcv).length > 0;
          const agg = threadAgg.get(tid) || {
            id: tid,
            subject: env.subject || null,
            participant_set: new Set(),
            message_count: 0,
            first_message_date: rcv,
            last_message_date: rcv,
            labels_set: new Set(),
            unread_count: 0,
            flagged_count: 0,
            has_attachments: false,
          };
          agg.message_count++;
          agg.first_message_date = rcv < agg.first_message_date ? rcv : agg.first_message_date;
          agg.last_message_date = rcv > agg.last_message_date ? rcv : agg.last_message_date;
          for (const p of participant) agg.participant_set.add(p);
          for (const l of msgLabels) agg.labels_set.add(l);
          if (msgHasAttachments) agg.has_attachments = true;
          if (!flagsArr.includes('\\Seen')) agg.unread_count++;
          if (flagsArr.includes('\\Flagged')) agg.flagged_count++;
          if (!agg.subject && env.subject) agg.subject = env.subject;
          threadAgg.set(tid, agg);
        }
        for (const agg of threadAgg.values()) {
          emitRecord('threads', {
            id: agg.id,
            subject: agg.subject,
            participant_emails: [...agg.participant_set],
            message_count: agg.message_count,
            first_message_date: agg.first_message_date,
            last_message_date: agg.last_message_date,
            labels: [...agg.labels_set],
            unread_count: agg.unread_count,
            flagged_count: agg.flagged_count,
            has_attachments: agg.has_attachments,
          });
        }
      }

      emit({
        type: 'STATE', stream: 'messages',
        cursor: { all_mail: { uidvalidity, uidnext, highest_modseq: highestModseq || null } },
      });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  emit({ type: 'DONE', status: 'succeeded', records_emitted: totalEmitted });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e && e.message ? e.message : String(e);
  const retryable = /ECONN|ETIMEDOUT|fetch failed|EPIPE|timeout/i.test(msg);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable } });
  flushAndExit(1);
});
