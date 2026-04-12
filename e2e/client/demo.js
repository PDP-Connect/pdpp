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

function readArg(name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx === args.length - 1) return fallback;
  return args[idx + 1];
}

const AS_PORT = parseInt(readArg('--port-as', '7662'), 10);
const RS_PORT = parseInt(readArg('--port-rs', '7663'), 10);

const AS_URL = `http://localhost:${AS_PORT}`;
const RS_URL = `http://localhost:${RS_PORT}`;

process.env.AS_URL = AS_URL;
process.env.RS_URL = RS_URL;

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

function encodeCursorPayload(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

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
    const state = await loadSyncState(manifest.connector_id, ownerToken, { rsUrl: RS_URL }).catch(() => null);
    info(`Running ${manifest.display_name} seed...`);

    const result = await runConnector({
      connectorPath: seedPath,
      connectorId: manifest.connector_id,
      ownerToken,
      manifest,
      state,
      collectionMode: 'full_refresh',
      rsUrl: RS_URL,
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

  section('Step 1: Single-Use Grant');
  const singleUseGrantRequest = {
    client_id: 'concert_recommendation_app',
    connector_id: manifests.spotify.connector_id,
    purpose_code: 'https://pdpp.org/purpose/personalization',
    purpose_description: 'Recommend concerts based on your listening history (last 6 months)',
    access_mode: 'single_use',
    retention: { max_duration: 'P90D', on_expiry: 'delete' },
    streams: [
      {
        name: 'top_artists',
        necessity: 'required',
        view: 'basic',
        time_range: { since: new Date(Date.now() - 180 * 86400000).toISOString() },
      },
    ],
  };

  const singleUseInitiate = await apiCall(`${AS_URL}/grants/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(singleUseGrantRequest),
  });
  ok(`Grant request initiated`);
  info(`  User code: ${singleUseInitiate.user_code}`);
  info(`  Consent UI: ${singleUseInitiate.verification_uri}`);
  show(`Single-use request`, singleUseGrantRequest);

  const singleUseApproval = await apiCall(`${AS_URL}/consent/${singleUseInitiate.device_code}/approve-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject_id: 'user_demo' }),
  });
  const singleUseToken = singleUseApproval.token;
  ok(`Single-use grant approved`);
  show(`Issued grant`, singleUseApproval.grant);

  try {
    await apiCall(`${AS_URL}/grants/${singleUseApproval.grant.grant_id}/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    err('BUG: single_use grant should not issue a second client token');
  } catch (e) {
    ok(`single_use enforced at issuance: second token request rejected (${e.body?.error?.code || 'grant_consumed'})`);
  }

  const singleUseResp = await apiCall(
    `${RS_URL}/v1/streams/top_artists/records?limit=1`,
    { headers: { 'Authorization': `Bearer ${singleUseToken}` } }
  );
  ok(`First single_use query succeeded and returned ${singleUseResp.data.length} record`);

  const singleUseNextPage = await apiCall(
    `${RS_URL}/v1/streams/top_artists/records?limit=1&cursor=${encodeURIComponent(singleUseResp.next_cursor)}`,
    { headers: { 'Authorization': `Bearer ${singleUseToken}` } }
  );
  ok(`Issued single_use token remained valid for pagination and returned ${singleUseNextPage.data.length} second-page record`);
  info(`  single_use constrains token issuance, not follow-on reads with the issued token`);

  section('Step 2: Continuous Grant for Enforcement + Sync');
  const continuousGrantRequest = {
    client_id: 'concert_recommendation_app',
    connector_id: manifests.spotify.connector_id,
    purpose_code: 'https://pdpp.org/purpose/personalization',
    purpose_description: 'Maintain a concert-recommendation profile over time',
    access_mode: 'continuous',
    retention: { max_duration: 'P90D', on_expiry: 'delete' },
    streams: [
      { name: 'top_artists', necessity: 'required', view: 'basic' },
      { name: 'recently_played', necessity: 'optional', view: 'basic' },
    ],
  };

  const continuousInitiate = await apiCall(`${AS_URL}/grants/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(continuousGrantRequest),
  });
  const continuousApproval = await apiCall(`${AS_URL}/consent/${continuousInitiate.device_code}/approve-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject_id: 'user_demo' }),
  });
  const continuousToken = continuousApproval.token;
  ok(`Continuous grant approved`);
  info(`  Consent UI: ${continuousInitiate.verification_uri}`);
  show(`Continuous grant`, continuousApproval.grant);

  const streamsResp = await apiCall(`${RS_URL}/v1/streams`, {
    headers: { 'Authorization': `Bearer ${continuousToken}` },
  });
  ok(`Streams available under continuous grant:`);
  for (const s of streamsResp.data) {
    info(`  • ${s.name}: ${s.record_count} records`);
  }

  const artistsResp = await apiCall(
    `${RS_URL}/v1/streams/top_artists/records?limit=5`,
    { headers: { 'Authorization': `Bearer ${continuousToken}` } }
  );
  ok(`Top artists under grant (basic view):`);
  for (const rec of artistsResp.data) {
    const d = rec.data;
    info(`  • ${d.name} [${(d.genres || []).slice(0, 2).join(', ')}] — fields exposed: ${Object.keys(d).join(', ')}`);
  }

  section('Step 3: Verifying Grant Enforcement');
  try {
    await apiCall(`${RS_URL}/v1/streams/saved_tracks/records`, {
      headers: { 'Authorization': `Bearer ${continuousToken}` },
    });
    err('BUG: saved_tracks should not be accessible!');
  } catch (e) {
    if (e.status === 403) {
      ok(`Stream not in grant correctly blocked: saved_tracks → 403 ${e.body?.error?.code}`);
    } else {
      throw e;
    }
  }

  try {
    await apiCall(`${RS_URL}/v1/streams/top_artists/records?filter[popularity]=82`, {
      headers: { 'Authorization': `Bearer ${continuousToken}` },
    });
    err(`BUG: filter on popularity should have been rejected`);
  } catch (e) {
    if (e.status === 403) {
      ok(`Filter on unauthorized field blocked: popularity → 403 ${e.body?.error?.code}`);
    } else {
      throw e;
    }
  }

  section('Step 4: Projection-Safe Incremental Sync');
  const baselineResp = await apiCall(
    `${RS_URL}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(encodeCursorPayload({ kind: 'changes_since', version: 0 }))}`,
    { headers: { 'Authorization': `Bearer ${continuousToken}` } }
  );
  ok(`Initial sync baseline: ${baselineResp.data.length} records`);
  let syncCursor = baselineResp.next_changes_since;
  info(`  next_changes_since: ${syncCursor}`);

  const firstArtist = artistsResp.data[0];
  const ownerFirstArtist = await apiCall(
    `${RS_URL}/v1/streams/top_artists/records/${encodeURIComponent(firstArtist.id)}?connector_id=${encodeURIComponent(manifests.spotify.connector_id)}`,
    { headers: { 'Authorization': `Bearer ${ownerToken}` } }
  );
  const unauthorizedOnlyUpdate = {
    key: firstArtist.id,
    data: {
      ...ownerFirstArtist.data,
      popularity: 101,
      source_updated_at: new Date().toISOString(),
    },
    emitted_at: new Date().toISOString(),
  };
  await apiCall(
    `${RS_URL}/v1/ingest/top_artists?connector_id=${encodeURIComponent(manifests.spotify.connector_id)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ownerToken}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: JSON.stringify(unauthorizedOnlyUpdate),
    }
  );

  const hiddenFieldDelta = await apiCall(
    `${RS_URL}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(syncCursor)}`,
    { headers: { 'Authorization': `Bearer ${continuousToken}` } }
  );
  if (hiddenFieldDelta.data.length === 0) {
    ok(`Hidden-field-only change produced no delta under the basic view`);
  } else {
    err(`BUG: hidden-field-only change leaked into changes_since`);
  }
  syncCursor = hiddenFieldDelta.next_changes_since;

  const authorizedUpdate = {
    key: firstArtist.id,
    data: {
      ...unauthorizedOnlyUpdate.data,
      genres: [...firstArtist.data.genres, 'touring'],
      source_updated_at: new Date().toISOString(),
    },
    emitted_at: new Date().toISOString(),
  };
  await apiCall(
    `${RS_URL}/v1/ingest/top_artists?connector_id=${encodeURIComponent(manifests.spotify.connector_id)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ownerToken}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: JSON.stringify(authorizedUpdate),
    }
  );

  const authorizedDelta = await apiCall(
    `${RS_URL}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(syncCursor)}`,
    { headers: { 'Authorization': `Bearer ${continuousToken}` } }
  );
  ok(`Authorized-field change produced ${authorizedDelta.data.length} delta record(s)`);
  if (authorizedDelta.data[0]) {
    show(`Delta record`, authorizedDelta.data[0]);
  }
  syncCursor = authorizedDelta.next_changes_since;

  section('Step 5: Second Client with Different Connector Grant');
  const githubGrantReq = {
    client_id: 'github_portfolio_analyzer',
    connector_id: manifests.github.connector_id,
    purpose_code: 'https://pdpp.org/purpose/analytics',
    purpose_description: 'Analyze your open-source contributions for a portfolio summary',
    access_mode: 'continuous',
    retention: { max_duration: 'P1Y', on_expiry: 'delete' },
    streams: [
      { name: 'repositories', view: 'stats', necessity: 'required' },
      {
        name: 'commits',
        view: 'basic',
        necessity: 'required',
        time_range: { since: new Date(Date.now() - 365 * 86400000).toISOString() },
      },
    ],
  };

  const githubInitiate = await apiCall(`${AS_URL}/grants/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(githubGrantReq),
  });

  const githubApproval = await apiCall(`${AS_URL}/consent/${githubInitiate.device_code}/approve-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject_id: 'user_demo' }),
  });

  const githubToken = githubApproval.token;
  ok(`GitHub portfolio grant approved`);
  show(`Grant`, githubApproval.grant);

  const reposResp = await apiCall(
    `${RS_URL}/v1/streams/repositories/records?limit=5`,
    { headers: { 'Authorization': `Bearer ${githubToken}` } }
  );
  ok(`Repositories under grant (stats view):`);
  for (const rec of reposResp.data) {
    const d = rec.data;
    info(`  • ${d.full_name} [${d.language || 'N/A'}] ★${d.stargazers_count}`);
  }

  try {
    await apiCall(`${RS_URL}/v1/streams/top_artists/records`, {
      headers: { 'Authorization': `Bearer ${githubToken}` },
    });
    err('BUG: Spotify data should not be accessible with GitHub grant!');
  } catch (e) {
    if (e.status === 403) {
      ok(`Cross-connector isolation confirmed: Spotify data blocked with GitHub token`);
    } else {
      throw e;
    }
  }

  section('Step 6: Owner Erasure Produces Tombstones');
  const targetRecord = artistsResp.data[1];
  if (targetRecord) {
    const deleteUrl = `${RS_URL}/v1/streams/top_artists/records/${encodeURIComponent(targetRecord.id)}?connector_id=${encodeURIComponent(manifests.spotify.connector_id)}`;
    const delResp = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${ownerToken}` },
    });
    if (delResp.status === 204) {
      ok(`Record deleted: ${targetRecord.id}`);
      const tombstoneDelta = await apiCall(
        `${RS_URL}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(syncCursor)}`,
        { headers: { 'Authorization': `Bearer ${continuousToken}` } }
      );
      ok(`Deletion produced ${tombstoneDelta.data.length} tombstone delta record(s)`);
      if (tombstoneDelta.data[0]) {
        show(`Tombstone`, tombstoneDelta.data[0]);
      }
      syncCursor = tombstoneDelta.next_changes_since;
    }
  }

  section('Step 7: Revocation Stops Future Access');
  await apiCall(`${AS_URL}/grants/${continuousApproval.grant.grant_id}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    await apiCall(`${RS_URL}/v1/streams/top_artists/records?limit=1`, {
      headers: { 'Authorization': `Bearer ${continuousToken}` },
    });
    err('BUG: revoked grant should not be usable');
  } catch (e) {
    ok(`Revoked grant rejected with HTTP ${e.status}`);
  }

  // 10. Summary
  header('Summary: PDPP vs Raw Data Dump');

  console.log(`${BOLD}Raw Dump (no PDPP):${RESET}`);
  console.log(`  ${RED}✗${RESET} No purpose declaration — app could use data for anything`);
  console.log(`  ${RED}✗${RESET} No field scoping — full record including sensitive fields exposed`);
  console.log(`  ${RED}✗${RESET} No retention terms — recipient obligations are invisible`);
  console.log(`  ${RED}✗${RESET} No cross-connector isolation — one token = all data`);
  console.log(`  ${RED}✗${RESET} No revocation boundary — access can't be stopped`);

  console.log(`\n${BOLD}PDPP:${RESET}`);
  console.log(`  ${GREEN}✓${RESET} Single-use grants issue one client token, and that token remains usable until expiry`);
  console.log(`  ${GREEN}✓${RESET} Continuous grants support incremental sync with stable next_changes_since cursors`);
  console.log(`  ${GREEN}✓${RESET} Unauthorized field changes do not leak through changes_since`);
  console.log(`  ${GREEN}✓${RESET} Authorized field changes produce current-state deltas, not raw dumps`);
  console.log(`  ${GREEN}✓${RESET} Deletions propagate as tombstones`);
  console.log(`  ${GREEN}✓${RESET} Grants are connector-scoped and revocable`);

  console.log(`\n${DIM}Single-use grant: ${singleUseApproval.grant.grant_id}`);
  console.log(`Continuous grant: ${continuousApproval.grant.grant_id}`);
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
