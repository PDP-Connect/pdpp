#!/usr/bin/env node
/**
 * PDPP E2E Demo
 *
 * Demonstrates the full PDPP flow and compares it against a "raw dump" approach:
 *
 * 1. Start the personal server (AS + RS)
 * 2. Register connector manifests
 * 3. Issue an owner token
 * 4. Run the seed connector to populate the RS
 * 5. Issue a parameterized grant (time-scoped, field-projected)
 * 6. Query under grant enforcement
 * 7. Show incremental sync (changes_since)
 * 8. Show what a "raw dump" would look like vs PDPP-filtered access
 *
 * Usage:
 *   node client/demo.js                      # full demo
 *   node client/demo.js --quick              # skip server startup, connect to existing
 *   node client/demo.js --port-as 7662       # custom ports
 */

import { startServer } from '../server/index.js';
import { runConnector, loadSyncState } from '../runtime/index.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = join(__dirname, '..');

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const AS_PORT = parseInt(args[args.indexOf('--port-as') + 1] || '7662');
const RS_PORT = parseInt(args[args.indexOf('--port-rs') + 1] || '7663');

const AS_URL = `http://localhost:${AS_PORT}`;
const RS_URL = `http://localhost:${RS_PORT}`;

// ─── Utilities ────────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

function header(text) {
  console.log(`\n${BOLD}${BLUE}${'═'.repeat(60)}${RESET}`);
  console.log(`${BOLD}${BLUE}  ${text}${RESET}`);
  console.log(`${BOLD}${BLUE}${'═'.repeat(60)}${RESET}\n`);
}

function section(text) {
  console.log(`\n${BOLD}${CYAN}▸ ${text}${RESET}`);
}

function ok(text) { console.log(`  ${GREEN}✓${RESET} ${text}`); }
function info(text) { console.log(`  ${DIM}${text}${RESET}`); }
function warn(text) { console.log(`  ${YELLOW}⚠ ${text}${RESET}`); }
function err(text) { console.log(`  ${RED}✗ ${text}${RESET}`); }
function show(label, data) {
  console.log(`  ${MAGENTA}${label}:${RESET}`);
  console.log(JSON.stringify(data, null, 2).split('\n').map(l => `    ${DIM}${l}${RESET}`).join('\n'));
}

async function apiCall(url, opts = {}) {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  if (!resp.ok) {
    throw Object.assign(new Error(`${resp.status}: ${JSON.stringify(body)}`), { status: resp.status, body });
  }
  return body;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main demo ───────────────────────────────────────────────────────────────

async function main() {
  header('PDPP v0.1.0 — End-to-End Demo');
  console.log(`${DIM}This demo shows the full PDPP authorization and disclosure flow,`);
  console.log(`then contrasts it with a naive "raw dump" approach.${RESET}\n`);

  // 1. Start server
  section('Starting PDPP Personal Server');
  let server;
  if (!QUICK) {
    server = await startServer({ asPort: AS_PORT, rsPort: RS_PORT, dbPath: ':memory:' });
    ok(`Authorization Server: ${AS_URL}`);
    ok(`Resource Server:      ${RS_URL}`);
  } else {
    ok(`Using existing server at ${AS_URL} (AS) and ${RS_URL} (RS)`);
  }

  // 2. Register connector manifests
  section('Registering Connector Manifests');
  const manifests = {
    spotify: JSON.parse(readFileSync(join(E2E_DIR, 'manifests/spotify.json'), 'utf8')),
    github: JSON.parse(readFileSync(join(E2E_DIR, 'manifests/github.json'), 'utf8')),
    reddit: JSON.parse(readFileSync(join(E2E_DIR, 'manifests/reddit.json'), 'utf8')),
  };

  for (const [name, manifest] of Object.entries(manifests)) {
    await apiCall(`${AS_URL}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    ok(`Registered: ${manifest.display_name} (${manifest.connector_id})`);
    info(`  Streams: ${manifest.streams.map(s => s.name).join(', ')}`);
  }

  // 3. Issue owner token
  section('Issuing Owner Token');
  const ownerResp = await apiCall(`${AS_URL}/owner-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject_id: 'user_demo' }),
  });
  const ownerToken = ownerResp.token;
  ok(`Owner token issued for subject: user_demo`);
  info(`  Token: ${ownerToken.slice(0, 16)}...`);

  // 4. Run connectors to populate the RS
  section('Running Seed Connector (populating personal data store)');
  const seedPath = join(E2E_DIR, 'connectors/seed/index.js');

  for (const [name, manifest] of Object.entries(manifests)) {
    const state = await loadSyncState(manifest.connector_id, ownerToken).catch(() => null);
    info(`Running ${manifest.display_name} seed...`);

    const result = await runConnector({
      connectorPath: seedPath,
      connectorId: manifest.connector_id,
      ownerToken,
      manifest,
      state,
      collectionMode: 'full_refresh',
      onInteraction: async () => ({ status: 'cancelled' }),
      onProgress: (msg) => {
        if (msg.type === 'PROGRESS') info(`  [${name}] ${msg.message}`);
        if (msg.type === 'ingest') info(`  [${name}] Ingested ${msg.accepted} records to stream`);
      },
    });

    ok(`${manifest.display_name}: ${result.records_emitted} records ingested (${result.status})`);
  }

  // 5. Show the "raw dump" approach (what you'd get without PDPP)
  header('"Raw Dump" Approach (No PDPP)');
  console.log(`${DIM}Without PDPP, a client requesting your Spotify data might get everything:${RESET}\n`);

  // Simulate raw dump using owner token self-export (unrestricted)
  const rawResp = await apiCall(
    `${RS_URL}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(manifests.spotify.connector_id)}&limit=3`,
    { headers: { 'Authorization': `Bearer ${ownerToken}` } }
  );

  console.log(`  ${RED}Raw dump — all fields, no consent boundary, no purpose, no expiry:${RESET}`);
  for (const rec of rawResp.data.slice(0, 2)) {
    show(`Artist`, rec.data);
  }
  warn(`${rawResp.data.length} records returned with full field access, no time constraint, no audit trail`);

  // 6. PDPP grant flow
  header('PDPP Grant Flow');

  section('Step 1: Client Initiates Grant Request');
  const grantRequest = {
    client_id: 'concert_recommendation_app',
    connector_id: manifests.spotify.connector_id,
    purpose_code: 'https://pdpp.org/purpose/personalization',
    purpose_description: 'Recommend concerts based on your listening history (last 6 months)',
    access_mode: 'single_use',
    streams: [
      {
        name: 'top_artists',
        necessity: 'required',
        view: 'basic',                        // only name, genres — not popularity or followers
        time_range: { since: new Date(Date.now() - 180 * 86400000).toISOString() },
      },
      {
        name: 'recently_played',
        necessity: 'optional',
        view: 'basic',
      },
    ],
  };

  const initiateResp = await apiCall(`${AS_URL}/grants/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(grantRequest),
  });

  ok(`Grant request initiated`);
  info(`  User code: ${initiateResp.user_code}`);
  info(`  Consent UI: ${initiateResp.verification_uri}`);
  show(`Grant request`, grantRequest);

  section('Step 2: User Reviews and Approves Grant');
  // Auto-approve for demo
  const approvalResp = await apiCall(`${AS_URL}/consent/${initiateResp.device_code}/approve-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject_id: 'user_demo' }),
  });

  ok(`Grant approved by user`);
  ok(`Access token issued`);
  show(`Issued grant`, approvalResp.grant);
  const clientToken = approvalResp.token;
  info(`  Client token: ${clientToken.slice(0, 16)}...`);

  section('Step 3: Client Queries Under Grant Enforcement');

  // List streams
  const streamsResp = await apiCall(`${RS_URL}/v1/streams`, {
    headers: { 'Authorization': `Bearer ${clientToken}` },
  });
  ok(`Streams available under grant:`);
  for (const s of streamsResp.data) {
    info(`  • ${s.name}: ${s.record_count} records`);
  }

  // Query top_artists — only 'basic' view fields visible
  const artistsResp = await apiCall(
    `${RS_URL}/v1/streams/top_artists/records?limit=5`,
    { headers: { 'Authorization': `Bearer ${clientToken}` } }
  );

  ok(`Top artists (under grant — basic view, time-scoped):`);
  for (const rec of artistsResp.data) {
    const d = rec.data;
    const fields = Object.keys(d).join(', ');
    info(`  • ${d.name} [${(d.genres || []).slice(0, 2).join(', ')}] — fields exposed: ${fields}`);
  }

  if (artistsResp.data.length < rawResp.data.length) {
    ok(`Time-range filter active: ${artistsResp.data.length} records (vs ${rawResp.data.length} without filter)`);
  }

  // Verify that unauthorized fields are blocked
  section('Step 4: Verifying Grant Enforcement');

  // Try to access a stream not in the grant
  try {
    await apiCall(`${RS_URL}/v1/streams/saved_tracks/records`, {
      headers: { 'Authorization': `Bearer ${clientToken}` },
    });
    err('BUG: saved_tracks should not be accessible!');
  } catch (e) {
    if (e.status === 403) {
      ok(`Stream not in grant correctly blocked: saved_tracks → 403 ${e.body?.error?.code}`);
    }
  }

  // Try filter on field not in grant projection
  try {
    await apiCall(`${RS_URL}/v1/streams/top_artists/records?filter[popularity]=82`, {
      headers: { 'Authorization': `Bearer ${clientToken}` },
    });
    warn(`Filter on 'popularity' not blocked (field may be included in projection)`);
  } catch (e) {
    if (e.status === 403) {
      ok(`Filter on unauthorized field blocked: popularity → 403 ${e.body?.error?.code}`);
    }
  }

  // 7. Incremental sync demo
  section('Step 5: Incremental Sync (changes_since)');

  // Get initial changes_since baseline
  const baselineResp = await apiCall(
    `${RS_URL}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(btoa(JSON.stringify({ version: 0 })))}`,
    { headers: { 'Authorization': `Bearer ${clientToken}` } }
  );
  ok(`Initial sync: ${baselineResp.data.length} records`);
  const syncCursor = baselineResp.next_changes_since;
  info(`  Sync cursor: ${syncCursor}`);

  // Now query changes since the baseline — should be empty
  const deltaResp = await apiCall(
    `${RS_URL}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(syncCursor)}`,
    { headers: { 'Authorization': `Bearer ${clientToken}` } }
  );
  ok(`Delta query since baseline: ${deltaResp.data.length} new/changed records (expected 0)`);
  info(`  next_changes_since: ${deltaResp.next_changes_since}`);

  // 8. Second grant — demonstrate multi-app consent separation
  section('Step 6: Second Client with Different Grant (Sleep App)');

  const sleepGrantReq = {
    client_id: 'github_portfolio_analyzer',
    connector_id: manifests.github.connector_id,
    purpose_code: 'https://pdpp.org/purpose/analytics',
    purpose_description: 'Analyze your open-source contributions for a portfolio summary',
    access_mode: 'continuous',
    streams: [
      { name: 'repositories', view: 'stats', necessity: 'required' },
      { name: 'commits', view: 'basic', necessity: 'required',
        time_range: { since: new Date(Date.now() - 365 * 86400000).toISOString() } },
    ],
  };

  const sleepInitiate = await apiCall(`${AS_URL}/grants/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sleepGrantReq),
  });

  const sleepApproval = await apiCall(`${AS_URL}/consent/${sleepInitiate.device_code}/approve-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject_id: 'user_demo' }),
  });

  const githubToken = sleepApproval.token;
  ok(`GitHub portfolio grant approved`);
  show(`Grant`, sleepApproval.grant);

  const reposResp = await apiCall(
    `${RS_URL}/v1/streams/repositories/records?limit=5`,
    { headers: { 'Authorization': `Bearer ${githubToken}` } }
  );
  ok(`Repositories under grant (stats view):`);
  for (const rec of reposResp.data) {
    const d = rec.data;
    info(`  • ${d.full_name} [${d.language || 'N/A'}] ★${d.stargazers_count}`);
  }

  const commitsResp = await apiCall(
    `${RS_URL}/v1/streams/commits/records?limit=5`,
    { headers: { 'Authorization': `Bearer ${githubToken}` } }
  );
  ok(`Recent commits (last 12 months, basic view):`);
  for (const rec of commitsResp.data) {
    const d = rec.data;
    info(`  • [${d.repo_full_name}] ${d.message?.slice(0, 60)}`);
  }

  // Verify Spotify data is inaccessible with GitHub token
  try {
    await apiCall(
      `${RS_URL}/v1/streams/top_artists/records`,
      { headers: { 'Authorization': `Bearer ${githubToken}` } }
    );
    err('BUG: Spotify data should not be accessible with GitHub grant!');
  } catch (e) {
    if (e.status === 403) {
      ok(`Cross-connector isolation confirmed: Spotify data blocked with GitHub token`);
    }
  }

  // 9. Owner erasure
  section('Step 7: Owner Erasure (GDPR Right to Delete)');
  const targetRecord = rawResp.data[0];
  if (targetRecord) {
    const deleteUrl = `${RS_URL}/v1/streams/top_artists/records/${encodeURIComponent(targetRecord.id)}?connector_id=${encodeURIComponent(manifests.spotify.connector_id)}`;
    const delResp = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    if (delResp.status === 204) {
      ok(`Record deleted: ${targetRecord.id}`);
      ok(`Tombstone will appear in next changes_since query for affected clients`);
    }
  }

  // 10. Summary
  header('Summary: PDPP vs Raw Data Dump');

  console.log(`${BOLD}Raw Dump (no PDPP):${RESET}`);
  console.log(`  ${RED}✗${RESET} No purpose declaration — app could use data for anything`);
  console.log(`  ${RED}✗${RESET} No field scoping — full record including sensitive fields exposed`);
  console.log(`  ${RED}✗${RESET} No time constraint — all historical data accessible`);
  console.log(`  ${RED}✗${RESET} No audit trail — no record of who accessed what`);
  console.log(`  ${RED}✗${RESET} No revocation — access can't be stopped`);
  console.log(`  ${RED}✗${RESET} No cross-connector isolation — one token = all data`);

  console.log(`\n${BOLD}PDPP:${RESET}`);
  console.log(`  ${GREEN}✓${RESET} Purpose declared and displayed to user before consent`);
  console.log(`  ${GREEN}✓${RESET} Field scoping — only authorized fields returned`);
  console.log(`  ${GREEN}✓${RESET} Time constraint — only recent data accessible`);
  console.log(`  ${GREEN}✓${RESET} Grant is an auditable consent artifact`);
  console.log(`  ${GREEN}✓${RESET} Revocable — AS marks grant revoked, RS enforces within 60s`);
  console.log(`  ${GREEN}✓${RESET} Connector isolation — grant scoped to one connector`);
  console.log(`  ${GREEN}✓${RESET} Incremental sync — changes_since for efficient delta updates`);
  console.log(`  ${GREEN}✓${RESET} Owner erasure — DELETE endpoint with tombstone propagation`);

  console.log(`\n${DIM}Grant issued: ${approvalResp.grant.grant_id}`);
  console.log(`Connector: ${manifests.spotify.connector_id}`);
  console.log(`Subject: user_demo${RESET}\n`);

  if (server) {
    server.asServer.close();
    server.rsServer.close();
  }
}

main().catch(err => {
  console.error(`\n${RED}Demo failed:${RESET}`, err.message);
  if (err.body) console.error('Response:', JSON.stringify(err.body, null, 2));
  process.exit(1);
});
