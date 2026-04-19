#!/usr/bin/env node
/**
 * Orchestrator CLI — starts the personal server (embedded), registers the
 * requested connector's manifest, issues an owner token, runs the connector,
 * and prints a verification summary (records per stream landed in the RS).
 *
 * Usage:
 *   node bin/orchestrate.js run <connector>    (e.g. "ynab")
 *   node bin/orchestrate.js query <stream>     (requires already-running server)
 */

import { config as dotenvConfig } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_AS_URL,
  DEFAULT_RS_URL,
  readManifest,
  getConnectorPaths,
  registerManifest,
  issueOwnerToken,
  startEmbeddedServer,
  queryStream,
} from '../src/orchestrator.js';
import { handleInteraction } from '../src/interaction-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..', '..', '..', 'reference-implementation');
const REPO_ROOT = join(__dirname, '..', '..', '..');

dotenvConfig({ path: join(REPO_ROOT, '.env.the owner.local') });

const [, , cmd, ...rest] = process.argv;

async function cmdRun(name) {
  const manifest = readManifest(name);
  const { connectorPath } = getConnectorPaths(name);

  const dbPath = process.env.PDPP_DB_PATH ||
    join(REPO_ROOT, 'packages/polyfill-connectors/.pdpp-data/polyfill.sqlite');

  console.error(`[orchestrate] starting embedded server (db=${dbPath})...`);
  const server = await startEmbeddedServer({ dbPath });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  console.error(`[orchestrate] AS at ${asUrl}  RS at ${rsUrl}`);

  try {
    console.error(`[orchestrate] registering manifest for ${name}...`);
    await registerManifest(asUrl, manifest);

    console.error(`[orchestrate] minting owner token...`);
    const ownerToken = await issueOwnerToken(asUrl, process.env.PDPP_SUBJECT_ID || 'the owner');

    console.error(`[orchestrate] loading prior sync state...`);
    const { runConnector, loadSyncState } = await import(join(REFERENCE_IMPL_DIR, 'runtime/index.js'));
    const prior = await loadSyncState({ connectorId: manifest.connector_id, ownerToken, rsUrl }).catch(() => ({}));
    const priorState = prior && Object.keys(prior).length ? prior : null;
    console.error(`[orchestrate] prior state: ${priorState ? 'present (incremental)' : 'none (full_refresh)'}`);

    console.error(`[orchestrate] running connector: ${connectorPath}`);
    const result = await runConnector({
      connectorPath,
      connectorId: manifest.connector_id,
      ownerToken,
      manifest,
      state: priorState,
      collectionMode: priorState ? 'incremental' : 'full_refresh',
      persistState: true,
      rsUrl,
      onProgress: (p) => {
        if (p.message) process.stderr.write(`  • ${p.stream ? `[${p.stream}] ` : ''}${p.message}\n`);
      },
      onInteraction: (msg) => handleInteraction(msg, { connectorName: name }),
    });

    console.error(`[orchestrate] result: status=${result.status} records_emitted=${result.records_emitted}`);
    if (result.error) {
      console.error(`[orchestrate] error: ${JSON.stringify(result.error).slice(0, 800)}`);
    }

    // Verify: query each stream and report record count
    console.error(`\n[orchestrate] verifying records in RS:`);
    for (const stream of manifest.streams) {
      const countQ = await queryStream(rsUrl, ownerToken, stream.name, { limit: 100, connectorId: manifest.connector_id });
      if (countQ.status !== 200) {
        console.error(`  ✗ ${stream.name.padEnd(28)} status=${countQ.status} ${JSON.stringify(countQ.body).slice(0, 100)}`);
        continue;
      }
      const count = Array.isArray(countQ.body?.data) ? countQ.body.data.length : 0;
      const hasMore = countQ.body?.has_more ? '+' : '';
      console.error(`  ✓ ${stream.name.padEnd(28)} ${count}${hasMore} record(s)`);
    }

    return { ok: result.status === 'succeeded', result };
  } finally {
    console.error(`[orchestrate] shutting down server...`);
    server.asServer.closeAllConnections?.();
    server.rsServer.closeAllConnections?.();
    await new Promise((r) => server.asServer.close(() => r()));
    await new Promise((r) => server.rsServer.close(() => r()));
  }
}

async function cmdQuery(stream) {
  const asUrl = DEFAULT_AS_URL;
  const rsUrl = DEFAULT_RS_URL;
  const ownerToken = await issueOwnerToken(asUrl, process.env.PDPP_SUBJECT_ID || 'the owner');
  const q = await queryStream(rsUrl, ownerToken, stream, { limit: 10 });
  console.log(JSON.stringify(q.body, null, 2));
}

async function main() {
  if (cmd === 'run' && rest[0]) {
    const r = await cmdRun(rest[0]);
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'query' && rest[0]) {
    await cmdQuery(rest[0]);
    process.exit(0);
  }
  console.error('Usage:');
  console.error('  orchestrate run <connector>       # ynab | gmail | chatgpt | usaa | amazon');
  console.error('  orchestrate query <stream>        # against already-running server');
  process.exit(2);
}

main().catch((e) => {
  console.error('[orchestrate] ERROR:', e);
  process.exit(1);
});
