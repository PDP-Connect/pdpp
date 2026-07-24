// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { assertCleanSourceTree, contentDigest, gitHead, gitPath, gitRoot, readManifest, receiptBinding, RUN_AUTHORITY_SCHEMA, RUN_COMPLETION_SCHEMA, selectedRuns, sourceTreeDigest, treeDigest, trackedFiles, verifyReceipts } from './inventory.mjs';
import { readStructuredChildResult, structuredNodeSummary, structuredPythonSummary } from './receipt.mjs';

const AUTHORITY_TTL_MS = 2 * 60 * 60 * 1000;
function fail(message) { throw new Error(`test accounting authority: ${message}`); }
function instant(value) { return new Date(value).toISOString(); }

function parseArgs(argv) {
  const value = { suites: [] };
  const take = (index, flag) => { const item = argv[index + 1]; if (!item || item.startsWith('--')) fail(`${flag} requires exactly one value`); return item; };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run') { if (value.run) fail('--run may appear only once'); value.run = true; }
    else if (arg === '--suite') { value.suites.push(take(index, arg)); index += 1; }
    else if (arg === '--profile' || arg === '--base') { value[arg.slice(2).replaceAll('-', '_')] = take(index, arg); index += 1; }
    else fail(`unknown argument: ${arg}`);
  }
  if (!value.run) fail('use --run');
  if (new Set(value.suites).size !== value.suites.length || (value.suites.includes('all') && value.suites.length !== 1)) fail('suite selection must be unique and cannot combine all with other suites');
  return value;
}

async function writeNew(path, value) {
  const fd = await open(path, 'wx');
  try { await fd.writeFile(`${JSON.stringify(value, null, 2)}\n`); await fd.sync(); } finally { await fd.close(); }
}
async function capture(command, cwd, env, transcript, start) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; const writes = [];
    const append = (stream, chunk) => {
      const text = chunk.toString(); if (stream === 'stdout') stdout += text;
      writes.push(transcript.write(`${JSON.stringify({ event: stream, run_id: start.run_id, chunk: text })}\n`));
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.on('error', reject);
    child.on('exit', async (code, signal) => { await Promise.all(writes); resolveResult({ exit_code: code ?? 1, signal: signal ?? null, stdout }); });
  });
}
function requiredByDefault(entry) { return entry.required !== false; }
function authorityDirectory(root) { return resolve(gitPath('test-accounting', root), 'runs'); }
function assertChildResult(result, issued) {
  if (!result || result.run_id !== issued.run_id || result.nonce !== issued.nonce || result.suite !== issued.suite || result.profile !== issued.profile) fail(`${issued.suite}/${issued.profile} child did not return its issued authority`);
  if (JSON.stringify(result.files) !== JSON.stringify(issued.files)) fail(`${issued.suite}/${issued.profile} child changed its issued selection`);
  if (!result.counts || typeof result.counts !== 'object') fail(`${issued.suite}/${issued.profile} child omitted structured counts`);
  return result.counts;
}
function leafCommand(run, authorityPath) {
  if (run.suite.zero_tests) return null;
  const command = [...run.suite.command];
  if (run.suite.authority_argument) command.push(run.suite.authority_argument, authorityPath);
  if (run.suite.execution === 'direct') command.push(...run.files);
  return command;
}
function observedCounts(run, observed, issued) {
  if (run.suite.zero_tests) return { assertions: 0, passed: 0, failed: 0, skipped: 0, skip_reasons: {}, planned_files: 0, completed_files: 0, zero_test_declaration: true };
  if (run.suite.execution === 'authority-runner') return assertChildResult(readStructuredChildResult(observed.stdout), issued);
  let counts;
  if (run.suite.loader === 'node-test') counts = structuredNodeSummary(observed.stdout);
  else if (run.suite.loader === 'python-unittest') counts = structuredPythonSummary(observed.stdout, observed.exit_code);
  else counts = { assertions: issued.files.length, passed: observed.exit_code === 0 ? issued.files.length : 0, failed: observed.exit_code === 0 ? 0 : 1, skipped: 0, skip_reasons: {} };
  return { ...counts, planned_files: issued.files.length, completed_files: observed.exit_code === 0 ? issued.files.length : 0 };
}

export async function runAuthority({ root = gitRoot(), suites = [], profile, base } = {}) {
  assertCleanSourceTree(root);
  const head = gitHead(root); const manifest = await readManifest(resolve(root, 'test-accounting.manifest.json'), { root, intendedBase: base });
  const files = trackedFiles(root); const selection = selectedRuns(manifest, files, { suites, profile });
  if (profile) for (const run of selection.runs) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(run.profile.optional_predicate ?? '');
    if (run.profile.required === false && (!match || process.env[match[1]] !== match[2])) fail(`${run.suite.id}/${run.profile.id} requires its optional environment predicate`);
  }
  const runs = selection.runs.filter((run) => profile || requiredByDefault(run.profile));
  if (runs.length === 0) fail('no required suite/profile runs were selected');
  const directory = authorityDirectory(root); await mkdir(directory, { recursive: true });
  const sourceTree = sourceTreeDigest(root, head); const manifestHash = contentDigest(await readFile(resolve(root, 'test-accounting.manifest.json')));
  const receipts = [];
  for (const run of runs) {
    const runId = randomUUID(); const nonce = randomUUID(); const issuedAt = instant(Date.now()); const expiresAt = instant(Date.now() + AUTHORITY_TTL_MS);
    const issued = { schema: RUN_AUTHORITY_SCHEMA, run_id: runId, nonce, issued_at: issuedAt, expires_at: expiresAt, suite: run.suite.id, profile: run.profile.id, files: run.files, cwd: run.suite.cwd, argv: run.suite.command, base_sha: manifest.inventory_base_sha, head_sha: head, source_tree_sha256: sourceTree, selection_tree_sha256: treeDigest(root, head, run.files), manifest_sha256: manifestHash };
    const authorityPath = resolve(directory, `${runId}.authority.json`); await writeNew(authorityPath, issued);
    const transcriptPath = resolve(directory, `${runId}.transcript`); const transcript = await open(transcriptPath, 'wx');
    const startedAt = instant(Date.now()); await transcript.write(`${JSON.stringify({ event: 'start', run_id: runId, nonce, started_at: startedAt, suite: issued.suite, profile: issued.profile, files: issued.files, cwd: issued.cwd, argv: issued.argv })}\n`);
    const command = leafCommand(run, authorityPath);
    let observed;
    try { observed = command ? await capture(command, resolve(root, run.suite.cwd), { ...process.env, PDPP_TEST_PROFILE: run.profile.id, ...(run.suite.environment ?? {}) }, transcript, issued) : { exit_code: 0, signal: null, stdout: '' }; } catch (error) { await transcript.close(); throw error; }
    const endedAt = instant(Date.now()); await transcript.write(`${JSON.stringify({ event: 'end', run_id: runId, nonce, ended_at: endedAt, exit_code: observed.exit_code, signal: observed.signal })}\n`); await transcript.sync(); await transcript.close();
    assertCleanSourceTree(root);
    if (sourceTreeDigest(root, head) !== sourceTree) fail(`${issued.suite}/${issued.profile} changed the full source tree during execution`);
    let counts;
    try { counts = observedCounts(run, observed, issued); } catch (error) { counts = { assertions: 0, passed: 0, failed: 1, skipped: 0, skip_reasons: {}, planned_files: issued.files.length, completed_files: 0, protocol_error: error.message }; observed.exit_code ||= 1; }
    const transcriptRelative = relative(directory, transcriptPath);
    const completion = { schema: RUN_COMPLETION_SCHEMA, run_id: runId, nonce, observed: { exit_code: observed.exit_code, signal: observed.signal, transcript: transcriptRelative, transcript_sha256: contentDigest(await readFile(transcriptPath)), counts, files: issued.files } };
    const completionPath = resolve(directory, `${runId}.completion.json`); await writeNew(completionPath, completion);
    const receipt = { schema: 'pdpp.test-receipt/v3', run_id: runId, nonce, suite: issued.suite, profile: issued.profile, issued_at: issued.issued_at, started_at: startedAt, ended_at: endedAt, expires_at: issued.expires_at, base_sha: issued.base_sha, head_sha: issued.head_sha, source_tree_sha256: issued.source_tree_sha256, selection_tree_sha256: issued.selection_tree_sha256, manifest_sha256: issued.manifest_sha256, cwd: issued.cwd, argv: issued.argv, files: issued.files, transcript: transcriptRelative, transcript_sha256: completion.observed.transcript_sha256, exit_code: observed.exit_code, signal: observed.signal, counts, authority_sha256: contentDigest(await readFile(authorityPath)), completion_sha256: contentDigest(await readFile(completionPath)) };
    receipt.binding_sha256 = receiptBinding(receipt);
    await writeNew(resolve(directory, `${runId}.receipt.json`), receipt); receipts.push(receipt);
  }
  return { directory, result: await verifyReceipts(manifest, files, receipts, { root, head, authorityDirectory: directory, sourceTree, requiredKeys: runs.map((run) => `${run.suite.id}/${run.profile.id}`) }) };
}

async function main() {
  const input = parseArgs(process.argv.slice(2)); const result = await runAuthority({ suites: input.suites, profile: input.profile, base: input.base });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
