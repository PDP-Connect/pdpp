/**
 * Polyfill orchestrator.
 *
 * Starts (or connects to) the reference-implementation personal server,
 * registers polyfill manifests, issues an owner token, and runs connectors
 * end-to-end via runConnector(). Records land in the RS; you can query them.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, '..');
const REFERENCE_IMPL_DIR = join(PACKAGE_ROOT, '..', '..', 'reference-implementation');

export const DEFAULT_AS_URL = process.env.AS_URL || 'http://localhost:7662';
export const DEFAULT_RS_URL = process.env.RS_URL || 'http://localhost:7663';
export const DEFAULT_SUBJECT_ID = process.env.PDPP_SUBJECT_ID || 'the owner';
const OWNER_BOOTSTRAP_CLIENT = 'pdpp-polyfill-owner-bootstrap';

export const MANIFEST_DIR = join(PACKAGE_ROOT, 'manifests');
export const CONNECTORS_DIR = join(PACKAGE_ROOT, 'connectors');

function c(name) {
  return {
    connectorPath: join(CONNECTORS_DIR, name, 'index.js'),
    manifestPath: join(MANIFEST_DIR, `${name}.json`),
  };
}

const KNOWN_CONNECTORS = {
  ynab: c('ynab'),
  gmail: c('gmail'),
  chatgpt: c('chatgpt'),
  usaa: c('usaa'),
  amazon: c('amazon'),
  github: c('github'),
  oura: c('oura'),
  spotify: c('spotify'),
  anthropic: c('anthropic'),
  shopify: c('shopify'),
  heb: c('heb'),
  wholefoods: c('wholefoods'),
  linkedin: c('linkedin'),
  meta: c('meta'),
  loom: c('loom'),
  uber: c('uber'),
  doordash: c('doordash'),
  whatsapp: c('whatsapp'),
  slack: c('slack'),
  pocket: c('pocket'),
  google_takeout: { connectorPath: join(CONNECTORS_DIR, 'google_takeout', 'index.js'), manifestPath: join(MANIFEST_DIR, 'google_takeout.json') },
  twitter_archive: { connectorPath: join(CONNECTORS_DIR, 'twitter_archive', 'index.js'), manifestPath: join(MANIFEST_DIR, 'twitter_archive.json') },
  imessage: c('imessage'),
  strava: c('strava'),
  notion: c('notion'),
  reddit: c('reddit'),
  claude_code: { connectorPath: join(CONNECTORS_DIR, 'claude_code', 'index.js'), manifestPath: join(MANIFEST_DIR, 'claude_code.json') },
  codex: c('codex'),
  apple_health: { connectorPath: join(CONNECTORS_DIR, 'apple_health', 'index.js'), manifestPath: join(MANIFEST_DIR, 'apple_health.json') },
  ical: c('ical'),
};

export function getConnectorPaths(name) {
  const paths = KNOWN_CONNECTORS[name];
  if (!paths) throw new Error(`unknown connector: ${name}`);
  return paths;
}

export function readManifest(name) {
  const { manifestPath } = getConnectorPaths(name);
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

async function asFetch(asUrl, path, opts = {}) {
  const res = await fetch(`${asUrl}${path}`, opts);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: res.status, body };
}

export async function registerManifest(asUrl, manifest) {
  const { status, body } = await asFetch(asUrl, '/connectors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  // 409 Conflict on re-register is fine — manifest version unchanged.
  if (status !== 201 && status !== 200 && status !== 409) {
    throw new Error(`register manifest failed ${status}: ${JSON.stringify(body)}`);
  }
  return body;
}

export async function issueOwnerToken(asUrl, subjectId = DEFAULT_SUBJECT_ID) {
  const clientId = OWNER_BOOTSTRAP_CLIENT;
  const deviceReq = await asFetch(asUrl, '/oauth/device_authorization', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  if (deviceReq.status !== 200) {
    throw new Error(`device_authorization failed ${deviceReq.status}: ${JSON.stringify(deviceReq.body)}`);
  }
  const device = deviceReq.body;

  const approveRes = await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
  });
  if (!approveRes.ok) {
    const t = await approveRes.text().catch(() => '');
    throw new Error(`device/approve failed ${approveRes.status}: ${t}`);
  }

  const tokenReq = await asFetch(asUrl, '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  });
  if (tokenReq.status !== 200) {
    throw new Error(`/oauth/token failed ${tokenReq.status}: ${JSON.stringify(tokenReq.body)}`);
  }
  return tokenReq.body.access_token;
}

export async function startEmbeddedServer({ dbPath = join(PACKAGE_ROOT, '.pdpp-data/polyfill.sqlite') } = {}) {
  const { startServer } = await import(join(REFERENCE_IMPL_DIR, 'server/index.js'));
  // Ensure dir exists
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dirname(dbPath), { recursive: true });

  const server = await startServer({
    asPort: 0,  // ephemeral — avoid collision with other PDPP servers
    rsPort: 0,
    dbPath,
    preRegisteredPublicClients: [
      {
        client_id: OWNER_BOOTSTRAP_CLIENT,
        metadata: {
          client_name: 'PDPP Polyfill Owner Bootstrap',
          token_endpoint_auth_method: 'none',
        },
      },
    ],
  });
  return server;
}

export async function loadPriorState(rsUrl, ownerToken, connectorId) {
  const { loadSyncState } = await import(join(REFERENCE_IMPL_DIR, 'runtime/index.js'));
  return loadSyncState({ connectorId, ownerToken, rsUrl });
}

export async function runOne(name, { asUrl = DEFAULT_AS_URL, rsUrl = DEFAULT_RS_URL, subjectId = DEFAULT_SUBJECT_ID, onInteraction } = {}) {
  const manifest = readManifest(name);
  const { connectorPath } = getConnectorPaths(name);

  await registerManifest(asUrl, manifest);
  const ownerToken = await issueOwnerToken(asUrl, subjectId);
  const state = await loadPriorState(rsUrl, ownerToken, manifest.connector_id).catch(() => null);
  const collectionMode = state && Object.keys(state).length ? 'incremental' : 'full_refresh';

  const { runConnector } = await import(join(REFERENCE_IMPL_DIR, 'runtime/index.js'));
  const result = await runConnector({
    connectorPath,
    connectorId: manifest.connector_id,
    ownerToken,
    manifest,
    state: state && Object.keys(state).length ? state : null,
    collectionMode,
    persistState: true,
    rsUrl,
    onInteraction,
    onProgress: () => {},
  });

  return { manifest, result, ownerToken };
}

export async function queryStream(rsUrl, ownerToken, stream, { limit = 5, connectorId, ...filters } = {}) {
  const url = new URL(`/v1/streams/${encodeURIComponent(stream)}/records`, rsUrl);
  url.searchParams.set('limit', String(limit));
  if (connectorId) url.searchParams.set('connector_id', connectorId);
  for (const [k, v] of Object.entries(filters)) {
    if (v != null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ownerToken}` } });
  const body = await res.json();
  return { status: res.status, body };
}
