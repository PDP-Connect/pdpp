/**
 * Gmail IMAP connector — Collection Profile implementation.
 *
 * Runs inside the browser-server (personal server's connector runtime),
 * never in the client app. Credentials stay within the personal server
 * trust boundary.
 *
 * Collection method: imap
 * Interaction: none (manifest-declared credentials, collected before launch)
 * Streams: email_threads (append_only, incremental)
 */

import { ImapFlow } from 'imapflow';

const GMAIL_CONNECTOR_ID = 'https://registry.pdpp.org/connectors/gmail';

export const GMAIL_MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: GMAIL_CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Gmail',
  collection_method: 'imap',
  // Manifest-declared credentials: personal server collects these before
  // launching the connector — client app never receives them.
  credentials: [
    { id: 'gmail_user', type: 'string',   label: 'Gmail address',
      description: 'Your Gmail address (e.g. you@gmail.com)' },
    { id: 'gmail_pass', type: 'password', label: 'App Password',
      description: 'A Google app password — not your account password. Generate one at myaccount.google.com/apppasswords.' },
  ],
  capabilities: {
    human_interaction: [], // no mid-run interaction — credentials declared in manifest
  },
  streams: [
    {
      name: 'email_threads',
      semantics: 'append_only',
      incremental: true,
      schema: {
        type: 'object',
        properties: {
          id:           { type: 'string' },
          subject:      { type: 'string' },
          from:         { type: 'string' },
          from_name:    { type: 'string' },
          labels:       { type: 'array', items: { type: 'string' } },
          received_at:  { type: 'string', format: 'date-time' },
          thread_count: { type: 'integer' },
        },
        required: ['id', 'received_at'],
      },
      primary_key: ['id'],
      cursor_field: 'received_at',
      consent_time_field: 'received_at',
      selection: { fields: true, resources: false },
      views: [
        {
          id: 'headers',
          label: 'Email headers only (no body)',
          fields: ['id', 'subject', 'from_name', 'labels', 'received_at', 'thread_count'],
        },
        {
          id: 'sender_only',
          label: 'Sender metadata only',
          fields: ['id', 'from', 'from_name', 'received_at'],
        },
      ],
    },
  ],
};

/**
 * Register the Gmail manifest with the AS (idempotent).
 */
async function ensureManifestRegistered(asUrl) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(GMAIL_MANIFEST),
  });
  if (!resp.ok && resp.status !== 409) {
    throw new Error(`Failed to register Gmail manifest: ${resp.status}`);
  }
}

/**
 * Run the Gmail IMAP connector.
 *
 * @param {object} opts
 * @param {string} opts.ownerToken - Owner token for RS ingest
 * @param {string} opts.gmailUser  - Gmail address
 * @param {string} opts.gmailPass  - App password
 * @param {string} opts.rsUrl      - Resource server URL
 * @param {string} opts.asUrl      - Authorization server URL
 * @returns {Promise<{ thread_count: number, source: string }>}
 */
export async function runGmail({ ownerToken, gmailUser, gmailPass, rsUrl, asUrl }) {
  await ensureManifestRegistered(asUrl);

  const now = new Date().toISOString();

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: gmailUser, pass: gmailPass },
    logger: false,
    connectionTimeout: 15000,  // 15s connect timeout
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  const threads = [];

  try {
    // Fetch envelope headers only — no message bodies are ever read.
    // This satisfies §3.2 data minimization: collect only what the stream schema requires.
    for await (const msg of client.fetch('1:50', { envelope: true, flags: true })) {
      const env = msg.envelope;
      if (!env) continue;
      const from = env.from?.[0];
      const fromAddr = from?.address ?? '';
      const fromName = from?.name ?? fromAddr.split('@')[0] ?? 'Unknown';
      const labels = [];
      if (msg.flags?.has('\\Seen')) labels.push('read');
      else labels.push('unread');
      if (msg.flags?.has('\\Flagged')) labels.push('starred');
      threads.push({
        id:           String(msg.uid ?? msg.seq),
        subject:      env.subject ?? '(no subject)',
        from:         fromAddr,
        from_name:    fromName,
        labels,
        received_at:  (env.date ?? new Date()).toISOString(),
        thread_count: 1,
      });
    }
    threads.reverse(); // newest first
  } finally {
    lock.release();
    await client.logout();
  }

  const ndjson = threads
    .map(thread => JSON.stringify({
      stream: 'email_threads',
      key: thread.id,
      data: {
        id:           thread.id,
        subject:      thread.subject,
        from:         thread.from,
        from_name:    thread.from_name,
        labels:       thread.labels,
        received_at:  thread.received_at,
        thread_count: thread.thread_count,
      },
      emitted_at: now,
    }))
    .join('\n');

  const ingestResp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent('email_threads')}?connector_id=${encodeURIComponent(GMAIL_CONNECTOR_ID)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ownerToken}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: ndjson,
    },
  );

  if (!ingestResp.ok) {
    const text = await ingestResp.text();
    throw new Error(`Ingest failed: ${ingestResp.status} ${text}`);
  }

  return {
    thread_count: threads.length,
    source: 'imap',
    connector_id: GMAIL_CONNECTOR_ID,
  };
}
