// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { buildScrubbedTestEnv } from './test-env.js';
import { storageProfileEnvironment } from './test-profile-env.js';
import { accountingResultLine, repositoryPaths, structuredNodeSummary } from '../../scripts/test-accounting/receipt.mjs';
import { RUN_AUTHORITY_SCHEMA } from '../../scripts/test-accounting/inventory.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const testDir = join(repoRoot, 'test');
const rawForwardedArgs = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--'));
const accountingIndex = rawForwardedArgs.indexOf('--accounting-authority');
const accountingPath = accountingIndex === -1 ? undefined : rawForwardedArgs[accountingIndex + 1];
if (accountingIndex !== -1 && !accountingPath) throw new Error('--accounting-authority requires PATH');
const forwardedArgs = accountingIndex === -1
  ? rawForwardedArgs
  : rawForwardedArgs.filter((_, index) => index !== accountingIndex && index !== accountingIndex + 1);
const effectiveArgs = forwardedArgs.includes('--test-force-exit')
  ? forwardedArgs
  : ['--test-force-exit', ...forwardedArgs];
if (!effectiveArgs.some((arg) => arg === '--test-reporter' || arg.startsWith('--test-reporter='))) effectiveArgs.push(`--test-reporter=${fileURLToPath(new URL('../../scripts/test-accounting/node-reporter.mjs', import.meta.url))}`);
const accountingAuthority = accountingPath ? JSON.parse(await readFile(accountingPath, 'utf8')) : undefined;
if (accountingAuthority && (accountingAuthority.schema !== RUN_AUTHORITY_SCHEMA || new Date(accountingAuthority.expires_at) < new Date())) throw new Error('accounting authority is invalid or expired');
if (accountingAuthority && (accountingAuthority.suite !== 'ri-default' || accountingAuthority.profile !== process.env.PDPP_TEST_PROFILE)) throw new Error('accounting authority does not bind the selected RI profile');
if (accountingAuthority?.profile === 'postgres' && !process.env.PDPP_TEST_POSTGRES_URL) throw new Error('postgres profile requires PDPP_TEST_POSTGRES_URL');
const selectedProfile = accountingAuthority?.profile ?? process.env.PDPP_TEST_PROFILE ?? 'memory-default';
const requestedConcurrency = Number.parseInt(process.env.PDPP_TEST_CONCURRENCY || '', 10);

// --- Per-file Postgres database isolation ---
//
// When PDPP_TEST_POSTGRES_URL is set, each test file receives its own
// ephemeral database created before spawn and dropped after exit, whether
// or not the file passes. This eliminates cross-file state pollution without
// requiring any changes to individual test files.

let fileCounter = 0;

/**
 * Derive the admin connection URL from a per-test URL by replacing the
 * database path segment with 'postgres' (always present on any standard PG
 * server). This gives us a stable admin connection independent of the base
 * DB name the operator chose.
 */
function adminUrlFromBase(baseUrl) {
  const u = new URL(baseUrl);
  u.pathname = '/postgres';
  return u.toString();
}

/**
 * Derive a short, safe DB name from the test file path and a monotonic
 * counter so concurrent workers never collide.
 */
function deriveDbName(filePath) {
  // Strip directory and extension; keep only alphanumeric/underscore chars.
  const base = filePath
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9_]/gi, '_')
    .toLowerCase()
    .slice(0, 40);
  fileCounter += 1;
  return `pdpp_test_${base}_${fileCounter}`;
}

// Per-file databases currently allocated. Tracked so that if the runner
// process itself is killed (SIGTERM/SIGINT, CI timeout) while child tests are
// in flight, their databases are dropped on the way out rather than orphaned.
const activeAllocations = new Set();
let signalCleanupArmed = false;

function armSignalCleanup() {
  if (signalCleanupArmed) return;
  signalCleanupArmed = true;
  const dropAll = () => {
    // Best-effort synchronous-ish drop of every live allocation; release() is
    // idempotent (DROP DATABASE IF EXISTS) so double-dropping is harmless.
    const pending = [...activeAllocations].map((a) => a.release().catch(() => {}));
    return Promise.allSettled(pending);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      dropAll().finally(() => {
        process.exit(sig === 'SIGINT' ? 130 : 143);
      });
    });
  }
}

/**
 * Create a fresh database and return its connection URL plus a cleanup
 * function that drops it. Never throws -- on error it logs a warning and
 * returns undefined so the caller falls back to the base URL.
 */
async function allocateTestDb(filePath, baseUrl) {
  const dbName = deriveDbName(filePath);
  const adminUrl = adminUrlFromBase(baseUrl);
  const client = new pg.Client({ connectionString: adminUrl });
  try {
    await client.connect();
    // Identifier is safe: deriveDbName produces only [a-z0-9_] chars.
    await client.query(`CREATE DATABASE "${dbName}"`);
    await client.end();
  } catch (err) {
    try { await client.end(); } catch (_) {}
    process.stderr.write(`[run-tests] WARN: could not create test DB ${dbName}: ${err.message}\n`);
    return undefined;
  }

  // Reuse the base URL structure but point at the new DB.
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${dbName}`;

  const allocation = { url: testUrl.toString() };

  allocation.release = async function release() {
    activeAllocations.delete(allocation);
    const drop = new pg.Client({ connectionString: adminUrl });
    try {
      await drop.connect();
      await drop.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await drop.end();
    } catch (err) {
      try { await drop.end(); } catch (_) {}
      process.stderr.write(`[run-tests] WARN: could not drop test DB ${dbName}: ${err.message}\n`);
    }
  };

  // Track the live allocation and arm the runner-level signal cleanup so a
  // killed runner drops its in-flight databases instead of orphaning them.
  armSignalCleanup();
  activeAllocations.add(allocation);

  return allocation;
}

async function runNodeTest(filePath, extraArgs) {
  const startedAt = Date.now();
  const baseEnv = storageProfileEnvironment(selectedProfile, buildScrubbedTestEnv(process.env));
  const baseUrl = baseEnv.PDPP_TEST_POSTGRES_URL;

  // Allocate a per-file DB when a base Postgres URL is configured.
  let allocation;
  if (baseUrl) {
    allocation = await allocateTestDb(filePath, baseUrl);
  }

  const childEnv = allocation
    ? { ...baseEnv, PDPP_TEST_POSTGRES_URL: allocation.url }
    : baseEnv;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...extraArgs, filePath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
    let output = '';

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('error', (err) => {
      if (allocation) allocation.release().finally(() => reject(err));
      else reject(err);
    });
    child.on('exit', (code, signal) => {
      const finish = () => {
        if (signal) {
          reject(new Error(`Test process for ${filePath} exited via signal ${signal}`));
          return;
        }
        resolve({
          durationMs: Date.now() - startedAt,
          filePath,
          exitCode: code ?? 1,
          output: `\n==> ${filePath}\n${output}`,
        });
      };
      if (allocation) {
        allocation.release().finally(finish);
      } else {
        finish();
      }
    });
  });
}

const entries = await readdir(testDir, { withFileTypes: true });
const NODE_TEST_EXTENSIONS = ['.test.js', '.test.mjs', '.test.ts'];
const isNodeTest = (name) => NODE_TEST_EXTENSIONS.some((extension) => name.endsWith(extension));
const topLevelTests = entries
  .filter((entry) => entry.isFile() && isNodeTest(entry.name))
  .map((entry) => join('test', entry.name));

// Co-located unit tests for focused server modules and operator scripts. The
// discovery is intentionally narrow by directory, but extension-complete for the
// Node loader used by the supported RI CI lines, including erasable TypeScript.
const COLOCATED_TEST_DIRS = [
  { dir: join('server', 'streaming'), extensions: NODE_TEST_EXTENSIONS },
  { dir: 'scripts', extensions: NODE_TEST_EXTENSIONS },
];
const colocatedTests = [];
for (const { dir: relDir, extensions } of COLOCATED_TEST_DIRS) {
  const absDir = join(repoRoot, relDir);
  let dirEntries;
  try {
    dirEntries = await readdir(absDir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of dirEntries) {
    if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
      colocatedTests.push(join(relDir, entry.name));
    }
  }
}

const testFiles = [...topLevelTests, ...colocatedTests].sort();
const defaultConcurrency = Math.max(
  1,
  Math.min(2, availableParallelism?.() ?? 1, testFiles.length || 1),
);
const fileConcurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0
  ? requestedConcurrency
  : defaultConcurrency;

const queue = [...testFiles];
const results = [];

async function worker() {
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file) return;
    const result = await runNodeTest(file, effectiveArgs);
    results.push(result);
    process.stdout.write(result.output);
  }
}

await Promise.all(Array.from({ length: fileConcurrency }, () => worker()));

const selectedFiles = repositoryPaths('reference-implementation', testFiles);
if (accountingAuthority && JSON.stringify(selectedFiles) !== JSON.stringify(accountingAuthority.files)) throw new Error('RI discovery differs from authority-issued child selection');
const summaries = results.map((result) => structuredNodeSummary(result.output));
const skipReasons = {};
for (const summary of summaries) for (const [reason, count] of Object.entries(summary.skip_reasons)) skipReasons[reason] = (skipReasons[reason] ?? 0) + count;
const failed = results.find((result) => result.exitCode !== 0);
const counts = {
  assertions: summaries.reduce((sum, summary) => sum + summary.assertions, 0),
  passed: summaries.reduce((sum, summary) => sum + summary.passed, 0),
  failed: summaries.reduce((sum, summary) => sum + summary.failed, 0),
  skipped: summaries.reduce((sum, summary) => sum + summary.skipped, 0),
  skip_reasons: skipReasons,
  planned_files: testFiles.length,
  completed_files: failed ? 0 : results.length,
};
if (accountingAuthority) process.stdout.write(`${accountingResultLine({ run_id: accountingAuthority.run_id, nonce: accountingAuthority.nonce, suite: 'ri-default', profile: accountingAuthority.profile, files: selectedFiles, counts })}\n`);

if (failed) {
  process.exit(failed.exitCode);
}
