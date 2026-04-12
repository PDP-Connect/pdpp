/**
 * Browser Server
 *
 * Runs a local Playwright Chromium instance, streams CDP screencast frames
 * to the demo frontend over WebSocket, and executes the Instagram scraping
 * automation.
 *
 * WebSocket protocol (server → client):
 *   { type: 'frame', data: '<base64 jpeg>' }
 *   { type: 'status', status: 'idle'|'running'|'done'|'error', message?: string }
 *   { type: 'log', level: 'info'|'warn'|'error', message: string }
 *   { type: 'stream-complete', stream: string, count: number }
 *   { type: 'result', data: any }
 *   { type: 'automation:data', key: string, value: any }
 *   { type: 'input:request', requestId: string, input: object }
 *
 * WebSocket protocol (client → server):
 *   { type: 'start-scrape', connectorId: string, ownerToken: string, grantIssuedAt: string }
 *   { type: 'input:response', requestId: string, values: object }
 *   { type: 'input:cancel', requestId: string }
 *   { type: 'mouse', action: string, x: number, y: number }
 *   { type: 'keyboard', action: string, key: string }
 *   { type: 'reset' }
 */

import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import express from 'express';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { runGmail } from './gmail-connector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3100');
const PDPP_RS_URL = process.env.PDPP_RS_URL || 'http://localhost:7663';
const PDPP_AS_URL = process.env.PDPP_AS_URL || 'http://localhost:7662';

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

const app = express();
app.use(express.json());
const server = createServer(app);
const wss = new WebSocketServer({ server });

// ─── Session state ─────────────────────────────────────────────────────────

let browser = null;
let context = null;
let page = null;
let cdpSession = null;
let activeWs = null;
let sessionStatus = 'idle';

// Pending input requests: requestId → { resolve, reject }
const inputWaiters = new Map();

function broadcast(msg) {
  if (activeWs?.readyState === 1) {
    activeWs.send(JSON.stringify(msg));
  }
}

function broadcastData(key, value) {
  broadcast({ type: 'automation:data', key, value });
}

function setStatus(status, message) {
  sessionStatus = status;
  broadcast({ type: 'status', status, message });
  if (message) log('info', message);
}

function log(level, message) {
  console.log(`[browser-server] [${level}] ${message}`);
  broadcast({ type: 'log', level, message });
}

// ─── input:request helper ──────────────────────────────────────────────────

async function requestInput(config) {
  const requestId = randomBytes(8).toString('hex');
  return new Promise((resolve, reject) => {
    inputWaiters.set(requestId, { resolve, reject });
    broadcast({ type: 'input:request', requestId, input: config });
  });
}

// ─── Screencasting ─────────────────────────────────────────────────────────

async function startScreencast(viewport = DEFAULT_VIEWPORT) {
  if (!page || cdpSession) return;
  cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 85,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  });
  cdpSession.on('Page.screencastFrame', async ({ data, sessionId }) => {
    broadcast({ type: 'frame', data });
    try { await cdpSession.send('Page.screencastFrameAck', { sessionId }); } catch {}
  });
}

async function stopScreencast() {
  if (cdpSession) {
    try { await cdpSession.send('Page.stopScreencast'); } catch {}
    cdpSession = null;
  }
}

// ─── Browser lifecycle ─────────────────────────────────────────────────────

async function initBrowser(viewport = DEFAULT_VIEWPORT) {
  if (browser) return;
  log('info', 'Launching Chromium...');
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--disable-gpu',
    ],
  });
  context = await browser.newContext({
    viewport,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  page = await context.newPage();
  log('info', `Browser ready (${viewport.width}x${viewport.height})`);
}

// ─── Ingest helper ─────────────────────────────────────────────────────────

async function ingestRecord(connectorId, ownerToken, stream, record) {
  const url = `${PDPP_RS_URL}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ownerToken}`,
      'Content-Type': 'application/x-ndjson',
    },
    body: JSON.stringify(record),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Ingest failed for ${stream}: ${resp.status} ${body}`);
  }
}

// ─── Sync state helpers ────────────────────────────────────────────────────

async function fetchSyncState(connectorId, ownerToken) {
  try {
    const url = `${PDPP_RS_URL}/v1/state/${encodeURIComponent(connectorId)}`;
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${ownerToken}` } });
    if (!resp.ok) return {};
    const body = await resp.json();
    return body.state || {};
  } catch {
    return {};
  }
}

async function saveSyncState(connectorId, ownerToken, stateMap) {
  try {
    const url = `${PDPP_RS_URL}/v1/state/${encodeURIComponent(connectorId)}`;
    await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: stateMap }),
    });
  } catch (err) {
    log('warn', `Failed to save sync state: ${err.message}`);
  }
}

// ─── Scraping automation ───────────────────────────────────────────────────

async function runScrape({ connectorId, ownerToken, grantIssuedAt, viewport }) {
  const vp = viewport || DEFAULT_VIEWPORT;
  setStatus('running', 'Starting browser...');
  await initBrowser(vp);
  await startScreencast(vp);

  // Fetch existing sync state so the connector can resume incrementally
  const syncState = await fetchSyncState(connectorId, ownerToken);
  const collectionMode = Object.keys(syncState).length > 0 ? 'incremental' : 'full_refresh';
  log('info', `Collection mode: ${collectionMode}${collectionMode === 'incremental' ? ` (cursor: ${JSON.stringify(syncState)})` : ''}`);
  broadcast({ type: 'sync-state', stream: '_mode', cursor: { collection_mode: collectionMode } });

  const scriptSrc = readFileSync(join(__dirname, 'instagram-script.js'), 'utf8');

  // Accumulate STATE messages from the script
  const pendingSyncState = {};
  function emitState(stream, cursor) {
    pendingSyncState[stream] = cursor;
    broadcast({ type: 'sync-state', stream, cursor });
    log('info', `STATE: ${stream} cursor saved`);
  }

  try {
    // Execute the script in Node scope with injected bindings
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const fn = new AsyncFunction(
      'page', 'requestInput', 'broadcastData', 'broadcast', 'ingestRecord', 'log',
      'connectorId', 'ownerToken', 'grantIssuedAt', 'syncState', 'emitState', 'collectionMode',
      scriptSrc
    );

    await fn(
      page,
      requestInput,
      broadcastData,
      broadcast,
      ingestRecord,
      log,
      connectorId,
      ownerToken,
      grantIssuedAt,
      syncState,
      emitState,
      collectionMode,
    );

    // Persist STATE checkpoints to RS
    if (Object.keys(pendingSyncState).length > 0) {
      await saveSyncState(connectorId, ownerToken, pendingSyncState);
      log('info', `Sync state persisted: ${JSON.stringify(Object.keys(pendingSyncState))}`);
    }

    await stopScreencast();
    setStatus('done', 'Data collection complete');
    broadcast({ type: 'result', data: { ok: true } });

  } catch (err) {
    log('error', `Scrape failed: ${err.message}`);
    await stopScreencast();
    setStatus('error', err.message);
  }
}

// ─── Input relay ───────────────────────────────────────────────────────────

async function relayInput(msg) {
  if (!page) return;
  try {
    switch (msg.type) {
      case 'mouse': {
        const { action, x, y, button = 'left' } = msg;
        if (action === 'mousePressed') await page.mouse.down({ button });
        else if (action === 'mouseReleased') await page.mouse.up({ button });
        else if (action === 'mouseMoved') await page.mouse.move(x, y);
        break;
      }
      case 'keyboard': {
        if (msg.action === 'keyDown') await page.keyboard.down(msg.key);
        else if (msg.action === 'keyUp') await page.keyboard.up(msg.key);
        else if (msg.action === 'char') await page.keyboard.type(msg.text || msg.key);
        break;
      }
      case 'scroll': {
        await page.mouse.wheel(msg.deltaX, msg.deltaY);
        break;
      }
      case 'paste': {
        await page.keyboard.type(msg.text);
        break;
      }
    }
  } catch { /* page may have navigated */ }
}

// ─── Reset ─────────────────────────────────────────────────────────────────

async function resetSession() {
  // Reject any pending input waiters
  for (const [, waiter] of inputWaiters) {
    waiter.reject(new Error('Session reset'));
  }
  inputWaiters.clear();

  await stopScreencast();
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null; context = null; page = null;
  }
  sessionStatus = 'idle';
  broadcast({ type: 'status', status: 'idle' });
}

// ─── WebSocket handler ─────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  // Only one active connection at a time
  if (activeWs) { try { activeWs.close(); } catch {} }
  activeWs = ws;

  ws.send(JSON.stringify({ type: 'status', status: sessionStatus }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'start-scrape') {
      if (sessionStatus === 'running') return;
      runScrape({
        connectorId: msg.connectorId,
        ownerToken: msg.ownerToken,
        grantIssuedAt: msg.grantIssuedAt,
        viewport: msg.viewport,
      }).catch(err => log('error', err.message));

    } else if (msg.type === 'input:response') {
      const waiter = inputWaiters.get(msg.requestId);
      if (waiter) {
        inputWaiters.delete(msg.requestId);
        waiter.resolve(msg.values);
      }

    } else if (msg.type === 'input:cancel') {
      const waiter = inputWaiters.get(msg.requestId);
      if (waiter) {
        inputWaiters.delete(msg.requestId);
        waiter.reject(new Error('Input cancelled'));
      }

    } else if (msg.type === 'reset') {
      await resetSession();

    } else {
      await relayInput(msg);
    }
  });

  ws.on('close', () => {
    if (activeWs === ws) activeWs = null;
  });
});

// ─── REST endpoints ────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true, status: sessionStatus }));

app.post('/reset', async (_req, res) => {
  await resetSession();
  res.json({ ok: true });
});

// Gmail IMAP connector — runs inside personal server, credentials never reach client app
app.post('/run-gmail', async (req, res) => {
  const { ownerToken, credentials } = req.body;
  if (!ownerToken || !credentials?.gmail_user || !credentials?.gmail_pass) {
    return res.status(400).json({ error: 'ownerToken and credentials (gmail_user, gmail_pass) required' });
  }
  try {
    const result = await runGmail({
      ownerToken,
      gmailUser: credentials.gmail_user,
      gmailPass: credentials.gmail_pass,
      rsUrl: PDPP_RS_URL,
      asUrl: PDPP_AS_URL,
    });
    res.json({ ok: true, connectorId: result.connector_id, real: true, summary: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[browser-server] Listening on ws://localhost:${PORT}`);
});
