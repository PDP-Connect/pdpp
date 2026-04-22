#!/usr/bin/env node
/**
 * Register all known connector manifests against a running AS. Useful smoke
 * test: "do all my manifests parse + pass AS validation?". Also a quick way
 * to seed a fresh server before interactive exploration.
 *
 * Usage:
 *   AS_URL=http://localhost:7662 node bin/register-all.js
 * or start an embedded server:
 *   node bin/register-all.js --embedded
 */

import { config as dotenvConfig } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_AS_URL, DEFAULT_RS_URL,
  readManifest, registerManifest, startEmbeddedServer,
} from '../src/orchestrator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
dotenvConfig({ path: join(REPO_ROOT, '.env.local') });

const CONNECTORS = [
  'ynab', 'gmail', 'chatgpt', 'usaa', 'amazon',
  'github', 'oura', 'spotify', 'anthropic', 'shopify',
  'heb', 'wholefoods', 'linkedin', 'meta', 'loom',
  'uber', 'doordash', 'whatsapp', 'slack',
  'pocket', 'google_takeout', 'twitter_archive', 'imessage',
  'strava', 'notion', 'reddit',
  'claude_code', 'codex',
  'apple_health', 'ical',
  // 'pocket' intentionally excluded — Mozilla shut Pocket down 2025-07-08. See
  // openspec/changes/add-polyfill-connector-system/design-notes/platform-bootstrap-research.md
];

async function run() {
  const embedded = process.argv.includes('--embedded');
  let server = null, asUrl = DEFAULT_AS_URL, rsUrl = DEFAULT_RS_URL;

  if (embedded) {
    // Use in-memory DB for smoke test — don't collide with other writers.
    server = await startEmbeddedServer({ dbPath: ':memory:' });
    asUrl = `http://localhost:${server.asPort}`;
    rsUrl = `http://localhost:${server.rsPort}`;
    console.error(`[register-all] embedded server at AS=${asUrl} RS=${rsUrl}`);
  }

  let ok = 0, fail = 0;
  for (const name of CONNECTORS) {
    try {
      const manifest = readManifest(name);
      await registerManifest(asUrl, manifest);
      console.log(`  ✓ ${name.padEnd(12)} ${manifest.connector_id}`);
      ok++;
    } catch (err) {
      console.log(`  ✗ ${name.padEnd(12)} ${err.message.slice(0, 120)}`);
      fail++;
    }
  }
  console.log(`\n${ok}/${CONNECTORS.length} manifests registered.`);

  if (server) {
    server.asServer.closeAllConnections?.();
    server.rsServer.closeAllConnections?.();
    await new Promise((r) => server.asServer.close(() => r()));
    await new Promise((r) => server.rsServer.close(() => r()));
  }
  process.exit(fail > 0 ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
