// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const EXECUTABLE_TEST_SUFFIX = /\.(?:test|spec)\.(?:js|mjs|cjs|ts|tsx|py|sh)$/;
export const EXECUTABLE_SMOKES = new Set(['packages/mcp-server/test/smoke-stdio.mjs']);
export const MANIFEST_SCHEMA = 'pdpp.test-accounting/v3';
export const RECEIPT_SCHEMA = 'pdpp.test-receipt/v3';
export const RUN_AUTHORITY_SCHEMA = 'pdpp.test-run-authority/v1';
export const RUN_COMPLETION_SCHEMA = 'pdpp.test-run-completion/v1';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const genericSkipReasons = new Set(['', 'true', 'unknown', 'unspecified', 'node-tap-no-reason']);

function fail(message) { throw new Error(`test accounting: ${message}`); }
function git(args, cwd = process.cwd()) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }
export function gitRoot(cwd = process.cwd()) { return git(['rev-parse', '--show-toplevel'], cwd).trim(); }
export function gitHead(cwd = process.cwd()) { return git(['rev-parse', 'HEAD'], cwd).trim(); }
export function gitPath(path, cwd = process.cwd()) { return resolve(cwd, git(['rev-parse', '--git-path', path], cwd).trim()); }
export function trackedFiles(cwd = process.cwd()) { return git(['ls-files', '-z'], cwd).split('\0').filter(Boolean).map(normalizePath).sort(); }

export function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) fail('path must be a non-empty string');
  const path = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (path.startsWith('/') || path.split('/').includes('..')) fail(`path must be repository-relative: ${value}`);
  return path;
}

export function containedPath(root, path, { existing = false, label = 'path' } = {}) {
  const rootReal = realpathSync(root);
  const candidate = resolve(rootReal, normalizePath(path));
  if (candidate !== rootReal && !candidate.startsWith(`${rootReal}/`)) fail(`${label} escapes repository: ${path}`);
  if (!existing) return candidate;
  let target;
  try { target = realpathSync(candidate); } catch { fail(`${label} is missing: ${path}`); }
  if (target !== rootReal && !target.startsWith(`${rootReal}/`)) fail(`${label} escapes repository: ${path}`);
  return target;
}

export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function contentDigest(value) { return hash(value); }
export function fileDigest(root, path) { return hash(readFileSync(containedPath(root, path, { existing: true, label: 'file' }))); }
export function treeDigest(root, head, files) {
  return hash(stable({ head, files: [...files].map(normalizePath).sort().map((path) => [path, fileDigest(root, path)]) }));
}
export function sourceTreeDigest(root, head = gitHead(root)) {
  const entries = git(['ls-tree', '-rz', '--full-tree', head], root).split('\0').filter(Boolean);
  return hash(stable({ head, entries }));
}
export function assertCleanSourceTree(root = gitRoot()) {
  try { git(['diff', '--quiet', 'HEAD', '--'], root); } catch { fail('worktree must be clean before accounting execution'); }
  try { git(['diff', '--cached', '--quiet', '--'], root); } catch { fail('index must be clean before accounting execution'); }
  const status = git(['status', '--porcelain=v1'], root).split('\n').filter(Boolean);
  if (status.length) fail(`worktree has untracked or changed paths: ${status.join(', ')}`);
}

export function receiptBinding(receipt) {
  const fields = ['run_id', 'nonce', 'suite', 'profile', 'issued_at', 'started_at', 'ended_at', 'expires_at', 'base_sha', 'head_sha', 'source_tree_sha256', 'selection_tree_sha256', 'manifest_sha256', 'cwd', 'argv', 'files', 'transcript', 'transcript_sha256', 'exit_code', 'signal', 'counts', 'authority_sha256', 'completion_sha256'];
  return hash(stable(Object.fromEntries(fields.map((field) => [field, receipt[field] ?? null]))));
}

export function classifyTrackedPath(path) {
  const normalized = normalizePath(path);
  return { path: normalized, kind: EXECUTABLE_TEST_SUFFIX.test(normalized) || EXECUTABLE_SMOKES.has(normalized) ? 'executable' : normalized.split('/').some((part) => part === 'test' || part === 'tests') ? 'helper-or-fixture' : 'other' };
}
function globToRegExp(glob) {
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') { if (glob[index + 1] === '*') { index += 1; if (glob[index + 1] === '/') { index += 1; source += '(?:.*/)?'; } else source += '.*'; } else source += '[^/]*'; }
    else if (char === '?') source += '[^/]'; else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}
export function matchesGlob(path, glob) { return globToRegExp(normalizePath(glob)).test(normalizePath(path)); }
function profileId(profile) { return typeof profile === 'string' ? profile : profile?.id; }
function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}
export function validInstant(value) { return typeof value === 'string' && !Number.isNaN(new Date(value).valueOf()) && new Date(value).toISOString() === value; }
function suiteProfiles(suite) {
  const ids = suite.profiles.map(profileId);
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) fail(`${suite.id} has invalid or duplicate profiles`);
  return ids;
}
function zeroTestSuite(suite) { return suite.zero_tests === true; }
function validateSkipReasons(reasons, label) {
  if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) fail(`${label} skip_reasons must be an object`);
  for (const [reason, count] of Object.entries(reasons)) {
    if (genericSkipReasons.has(reason.trim().toLowerCase()) || !Number.isInteger(count) || count < 0) fail(`${label} has a generic or invalid skip reason: ${reason}`);
  }
}
export async function readManifest(manifestPath = 'test-accounting.manifest.json', { root = process.cwd(), intendedBase } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schema !== MANIFEST_SCHEMA) fail(`unsupported manifest schema in ${manifestPath}`);
  if (typeof manifest.inventory_base_sha !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.inventory_base_sha)) fail('inventory_base_sha is required');
  if (intendedBase && manifest.inventory_base_sha !== intendedBase) fail(`inventory_base_sha does not match intended integration base ${intendedBase}`);
  try { git(['rev-parse', '--verify', `${manifest.inventory_base_sha}^{commit}`], root); } catch { fail(`inventory_base_sha is not a commit: ${manifest.inventory_base_sha}`); }
  try { git(['merge-base', '--is-ancestor', manifest.inventory_base_sha, gitHead(root)], root); } catch { fail(`inventory_base_sha ${manifest.inventory_base_sha} is not an ancestor of the current integration SHA`); }
  if (!Array.isArray(manifest.suites) || manifest.suites.length === 0) fail('manifest must declare suites');
  const ids = new Set();
  for (const suite of manifest.suites) {
    if (typeof suite.id !== 'string' || !suite.id || ids.has(suite.id)) fail(`invalid or duplicate suite id: ${suite.id}`);
    ids.add(suite.id); suiteProfiles(suite);
    if (!Array.isArray(suite.include) || (!zeroTestSuite(suite) && suite.include.length === 0) || (zeroTestSuite(suite) && suite.include.length !== 0)) fail(`${suite.id} must declare the correct inventory plan`);
    if (zeroTestSuite(suite)) {
      if (suite.execution !== 'zero-test-declaration' || suite.command !== null) fail(`${suite.id} zero-test declaration is malformed`);
    } else if (!Array.isArray(suite.command) || suite.command.length === 0 || suite.command.some((part) => typeof part !== 'string' || !part) || suite.command[0] === 'false') fail(`${suite.id} must declare a real command`);
    if (!['--authority', '--accounting-authority', null].includes(suite.authority_argument)) fail(`${suite.id} must declare a supported authority argument`);
    if (suite.execution === undefined) suite.execution = suite.authority_argument ? 'authority-runner' : 'direct';
    if (!['direct', 'authority-runner', 'zero-test-declaration'].includes(suite.execution)) fail(`${suite.id} must declare a supported execution mode`);
    if (zeroTestSuite(suite) && !suite.profiles.every((entry) => entry.zero_tests === true)) fail(`${suite.id} zero-test profiles must be declared`);
    if (!zeroTestSuite(suite) && suite.execution === 'direct' && suite.authority_argument !== null) fail(`${suite.id} direct leaf must not call authority`);
    if (typeof suite.cwd !== 'string' || !suite.cwd || suite.cwd.startsWith('/') || suite.cwd.includes('..')) fail(`${suite.id} must declare a repository-relative cwd`);
    if (!['node-test', 'python-unittest', 'shell'].includes(suite.loader)) fail(`${suite.id} must declare a supported loader`);
    for (const entry of suite.profiles) validateSkipReasons(entry.skip_reasons ?? {}, `${suite.id}/${profileId(entry)}`);
  }
  return manifest;
}
function selectedSuites(manifest, ids) {
  if (ids.length === 0 || ids.includes('all')) return manifest.suites;
  const wanted = new Set(ids); const suites = manifest.suites.filter((suite) => wanted.has(suite.id));
  if (suites.length !== wanted.size) fail(`unknown suite: ${[...wanted].find((id) => !suites.some((suite) => suite.id === id))}`);
  return suites;
}
function exclusionsFor(manifest, path) { return (manifest.exclusions ?? []).filter((entry) => entry.path === path); }
function validateExclusions(manifest, tracked) {
  const paths = new Set();
  for (const exclusion of manifest.exclusions ?? []) {
    for (const key of ['path', 'reason', 'owner', 'suite', 'profile', 'expires']) if (typeof exclusion[key] !== 'string' || !exclusion[key]) fail(`exclusion requires ${key}`);
    exclusion.path = normalizePath(exclusion.path);
    if (paths.has(exclusion.path)) fail(`duplicate exclusion: ${exclusion.path}`); paths.add(exclusion.path);
    if (!validDate(exclusion.expires)) fail(`exclusion expiry is malformed: ${exclusion.path}`);
    if (new Date(`${exclusion.expires}T00:00:00.000Z`) < new Date()) fail(`exclusion expired: ${exclusion.path}`);
    const suite = manifest.suites.find((entry) => entry.id === exclusion.suite);
    if (!suite || !suiteProfiles(suite).includes(exclusion.profile)) fail(`exclusion has unknown suite/profile: ${exclusion.path}`);
    if (!tracked.has(exclusion.path)) fail(`exclusion is not tracked: ${exclusion.path}`);
  }
}
export function planFor(manifest, files, suiteIds = []) {
  const suites = selectedSuites(manifest, suiteIds); const executable = files.filter((path) => classifyTrackedPath(path).kind === 'executable');
  const plans = new Map(); const owners = new Map();
  for (const suite of suites) {
    if (zeroTestSuite(suite)) { plans.set(suite.id, []); continue; }
    const plan = executable.filter((path) => suite.include.some((glob) => matchesGlob(path, glob)) && exclusionsFor(manifest, path).length === 0).sort();
    if (plan.length === 0) fail(`${suite.id} selects no executable tests`);
    plans.set(suite.id, plan);
    for (const path of plan) { if (owners.has(path)) fail(`${path} is planned by both ${owners.get(path)} and ${suite.id}`); owners.set(path, suite.id); }
  }
  return { executable, owners, plans, suites };
}
export function selectedRuns(manifest, files, { suites = [], profile } = {}) {
  const plan = planFor(manifest, files, suites);
  const runs = [];
  for (const suite of plan.suites) for (const entry of suite.profiles) {
    const id = profileId(entry);
    if (!profile || id === profile) runs.push({ suite, profile: entry, files: plan.plans.get(suite.id) });
  }
  if (profile && runs.length === 0) fail(`unknown selected profile: ${profile}`);
  return { ...plan, runs };
}
export function checkInventory(manifest, files, suiteIds = [], options = {}) {
  validateExclusions(manifest, new Set(files));
  const { executable, owners, plans, suites } = planFor(manifest, files, suiteIds);
  for (const path of executable) {
    const ownership = (owners.has(path) ? 1 : 0) + exclusionsFor(manifest, path).length;
    if (ownership > 1) fail(`${path} has multiple accounting owners`);
  }
  const unknown = executable.filter((path) => !owners.has(path) && exclusionsFor(manifest, path).length === 0);
  if ((suiteIds.length === 0 || suiteIds.includes('all') || options.failOnUnknown) && unknown.length) fail(`unaccounted executable tests: ${unknown.join(', ')}`);
  if (options.failOnEmpty && suites.some((suite) => !zeroTestSuite(suite) && !plans.get(suite.id).length)) fail('a suite selected no executable tests');
  return { executable, helpers: files.filter((path) => classifyTrackedPath(path).kind === 'helper-or-fixture'), plans: Object.fromEntries(plans), suites: suites.map((suite) => suite.id), unaccounted: unknown };
}
function sortedUnique(paths, label) {
  if (!Array.isArray(paths)) fail(`${label} must be a path array`); const normalized = paths.map(normalizePath);
  if (stable(normalized) !== stable([...normalized].sort()) || new Set(normalized).size !== normalized.length) fail(`${label} must be sorted and unique`); return normalized;
}
function profile(suite, id) { return suite.profiles.find((entry) => profileId(entry) === id); }
function authorityContained(directory, path, label) {
  const directoryReal = realpathSync(directory);
  const candidate = resolve(directoryReal, normalizePath(path));
  if (candidate !== directoryReal && !candidate.startsWith(`${directoryReal}/`)) fail(`${label} is outside its authority directory`);
  let target;
  try { target = realpathSync(candidate); } catch { fail(`${label} is missing: ${path}`); }
  if (target !== directoryReal && !target.startsWith(`${directoryReal}/`)) fail(`${label} is outside its authority directory`);
  return target;
}
function readAuthorityRecord(root, directory, runId, suffix) {
  if (typeof runId !== 'string' || !/^[a-f0-9-]{36}$/.test(runId)) fail('run_id is invalid');
  const path = authorityContained(directory, `${runId}.${suffix}.json`, `authority ${suffix}`);
  return { path, value: JSON.parse(readFileSync(path, 'utf8')) };
}
function verifyTranscript(receipt, root, authorityDirectory) {
  const transcriptPath = authorityContained(authorityDirectory, receipt.transcript, 'transcript');
  const body = readFileSync(transcriptPath); if (hash(body) !== receipt.transcript_sha256) fail(`${receipt.suite} transcript digest does not match`);
  const lines = body.toString('utf8').split('\n').filter(Boolean); let first; let last;
  try { first = JSON.parse(lines[0]); last = JSON.parse(lines.at(-1)); } catch { fail(`${receipt.suite} transcript envelope is malformed`); }
  if (first.event !== 'start' || last.event !== 'end' || first.run_id !== receipt.run_id || last.run_id !== receipt.run_id || last.exit_code !== receipt.exit_code || last.signal !== receipt.signal) fail(`${receipt.suite} transcript does not bind the receipt`);
}
function assertCounts(counts, key) {
  if (!counts || typeof counts !== 'object') fail(`${key} has no structured counts`);
  if (counts.zero_test_declaration === true) {
    if (counts.assertions !== 0 || counts.passed !== 0 || counts.failed !== 0 || counts.skipped !== 0 || counts.planned_files !== 0 || counts.completed_files !== 0 || Object.keys(counts.skip_reasons ?? {}).length !== 0) fail(`${key} zero-test declaration has observed tests`);
    return;
  }
  for (const field of ['assertions', 'passed', 'failed', 'skipped', 'planned_files', 'completed_files']) if (!Number.isInteger(counts[field]) || counts[field] < 0) fail(`${key} has invalid ${field}`);
  if (counts.assertions === 0 || counts.assertions !== counts.passed + counts.failed + counts.skipped) fail(`${key} has incomplete structured assertion counts`);
  validateSkipReasons(counts.skip_reasons ?? {}, key);
  if (counts.skipped !== Object.values(counts.skip_reasons ?? {}).reduce((sum, count) => sum + count, 0)) fail(`${key} skip count does not match skip reasons`);
}
function consumeRun(root, authorityDirectory, receipt) {
  const ledger = resolve(authorityDirectory, 'verified');
  const target = resolve(ledger, `${receipt.run_id}.json`);
  return mkdir(ledger, { recursive: true }).then(() => open(target, 'wx').then(async (fd) => {
    await fd.writeFile(`${JSON.stringify({ run_id: receipt.run_id, nonce: receipt.nonce, verified_at: new Date().toISOString() })}\n`);
    await fd.close();
  }).catch(() => fail(`${receipt.suite}/${receipt.profile} receipt was already verified or replayed`)));
}
export async function verifyReceipts(manifest, files, receipts, { head = gitHead(), root = gitRoot(), authorityDirectory, now = new Date(), consume = true, sourceTree = sourceTreeDigest(root, head), requiredKeys } = {}) {
  if (!authorityDirectory || !existsSync(authorityDirectory)) fail('verifier-issued authority directory is required');
  const { plans } = planFor(manifest, files, []); const suites = new Map(manifest.suites.map((suite) => [suite.id, suite])); const seen = new Set();
  const manifestHash = fileDigest(root, 'test-accounting.manifest.json'); const base = manifest.inventory_base_sha;
  const verified = [];
  for (const receipt of receipts) {
    if (receipt.schema !== RECEIPT_SCHEMA || typeof receipt.run_id !== 'string' || typeof receipt.nonce !== 'string') fail('receipt schema, run_id, or nonce is invalid');
    const key = `${receipt.suite}/${receipt.profile}`; if (seen.has(key)) fail(`duplicate receipt for ${key}`); seen.add(key);
    const suite = suites.get(receipt.suite); if (!suite) fail(`receipt has unknown suite: ${receipt.suite}`); const selected = profile(suite, receipt.profile); if (!selected) fail(`receipt profile is undeclared: ${key}`);
    const authority = readAuthorityRecord(root, authorityDirectory, receipt.run_id, 'authority');
    const completion = readAuthorityRecord(root, authorityDirectory, receipt.run_id, 'completion');
    if (authority.value.schema !== RUN_AUTHORITY_SCHEMA || completion.value.schema !== RUN_COMPLETION_SCHEMA) fail(`${key} authority records have invalid schemas`);
    if (receipt.authority_sha256 !== hash(readFileSync(authority.path)) || receipt.completion_sha256 !== hash(readFileSync(completion.path))) fail(`${key} authority provenance changed`);
    const issued = authority.value;
    if (issued.nonce !== receipt.nonce || completion.value.nonce !== receipt.nonce || completion.value.run_id !== receipt.run_id) fail(`${key} authority nonce does not bind receipt`);
    if (!validInstant(receipt.issued_at) || !validInstant(receipt.started_at) || !validInstant(receipt.ended_at) || !validInstant(receipt.expires_at) || receipt.started_at > receipt.ended_at || receipt.ended_at > receipt.expires_at || new Date(receipt.expires_at) < now) fail(`${key} receipt is expired or has invalid times`);
    if (stable({ suite: receipt.suite, profile: receipt.profile, files: receipt.files, cwd: receipt.cwd, argv: receipt.argv, base_sha: receipt.base_sha, head_sha: receipt.head_sha, source_tree_sha256: receipt.source_tree_sha256, selection_tree_sha256: receipt.selection_tree_sha256, manifest_sha256: receipt.manifest_sha256, issued_at: receipt.issued_at, expires_at: receipt.expires_at }) !== stable({ suite: issued.suite, profile: issued.profile, files: issued.files, cwd: issued.cwd, argv: issued.argv, base_sha: issued.base_sha, head_sha: issued.head_sha, source_tree_sha256: issued.source_tree_sha256, selection_tree_sha256: issued.selection_tree_sha256, manifest_sha256: issued.manifest_sha256, issued_at: issued.issued_at, expires_at: issued.expires_at })) fail(`${key} receipt does not match issued authority`);
    if (receipt.base_sha !== base || receipt.head_sha !== head || receipt.manifest_sha256 !== manifestHash || receipt.source_tree_sha256 !== sourceTree) fail(`${key} has stale base, SHA, tree, or manifest`);
    const planned = plans.get(suite.id); const paths = sortedUnique(receipt.files, `${key} files`); if (stable(paths) !== stable(planned)) fail(`${key} files do not match its plan`);
    if (receipt.selection_tree_sha256 !== treeDigest(root, head, planned)) fail(`${key} selected test tree changed`);
    if (receipt.binding_sha256 !== receiptBinding(receipt)) fail(`${key} receipt binding is invalid`); verifyTranscript(receipt, root, authorityDirectory);
    if (stable(completion.value.observed) !== stable({ exit_code: receipt.exit_code, signal: receipt.signal, transcript: receipt.transcript, transcript_sha256: receipt.transcript_sha256, counts: receipt.counts, files: receipt.files })) fail(`${key} completion does not bind observed child result`);
    if (!Number.isInteger(receipt.exit_code) || receipt.exit_code !== 0 || receipt.signal !== null) fail(`${key} did not pass`);
    assertCounts(receipt.counts, key);
    const expectedSkips = selected.skip_reasons ?? {};
    if (stable(receipt.counts.skip_reasons) !== stable(expectedSkips)) fail(`${key} skips do not exactly match the profile baseline`);
    if (selected.zero_tests === true) {
      if (receipt.files.length !== 0 || receipt.counts.zero_test_declaration !== true) fail(`${key} zero-test declaration is not exact`);
    } else if (receipt.counts.planned_files !== planned.length || receipt.counts.completed_files !== planned.length) fail(`${key} child selection was not completely observed`);
    verified.push(receipt);
  }
  const required = requiredKeys ?? manifest.suites.flatMap((suite) => suite.profiles.filter((entry) => entry.required !== false).map((entry) => `${suite.id}/${profileId(entry)}`));
  if (!Array.isArray(required) || new Set(required).size !== required.length || required.some((key) => !/^[^/]+\/[^/]+$/.test(key))) fail('required receipt selection is invalid');
  const missing = required.filter((key) => !seen.has(key)); if (missing.length) fail(`missing required receipts: ${missing.join(', ')}`);
  if (consume) for (const receipt of verified) await consumeRun(root, authorityDirectory, receipt);
  return { verified: [...seen].sort(), required };
}

export function parseInventoryArgs(argv) {
  const result = { suites: [], receipts: [], failOnEmpty: false, failOnUnknown: false };
  const take = (index, flag) => { const value = argv[index + 1]; if (!value || value.startsWith('--')) fail(`${flag} requires exactly one value`); return value; };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check' || arg === '--plan' || arg === '--verify') { if (result.mode) fail('choose exactly one mode'); result.mode = arg.slice(2); }
    else if (arg === '--suite') { result.suites.push(take(index, arg)); index += 1; }
    else if (arg === '--manifest') { result.manifest = take(index, arg); index += 1; }
    else if (arg === '--json') { result.json = take(index, arg); index += 1; }
    else if (arg === '--receipt') { result.receipts.push(take(index, arg)); index += 1; }
    else if (arg === '--fail-on-empty') result.failOnEmpty = true;
    else if (arg === '--fail-on-unaccounted') result.failOnUnknown = true;
    else if (arg === '--sha' || arg === '--base' || arg === '--profile') { result[arg.slice(2).replaceAll('-', '_')] = take(index, arg); index += 1; }
    else fail(`unknown argument: ${arg}`);
  }
  if (!result.mode) fail('choose exactly one of --check, --plan, or --verify');
  if (new Set(result.suites).size !== result.suites.length || (result.suites.includes('all') && result.suites.length !== 1)) fail('suite selection must be unique and cannot combine all with other suites');
  return result;
}
async function main() {
  const args = parseInventoryArgs(process.argv.slice(2)); const root = gitRoot(); const head = gitHead(root);
  if (args.sha && args.sha !== head) fail(`requested SHA ${args.sha} does not match ${head}`);
  const manifest = await readManifest(resolve(root, args.manifest ?? 'test-accounting.manifest.json'), { root, intendedBase: args.base });
  try { git(['merge-base', '--is-ancestor', manifest.inventory_base_sha, head], root); } catch { fail(`inventory_base_sha ${manifest.inventory_base_sha} is not an ancestor of ${head}`); }
  const files = trackedFiles(root); assertCleanSourceTree(root);
  if (args.mode === 'verify') {
    if (!args.receipts.length) fail('--verify needs at least one --receipt');
    const directory = resolve(gitPath('test-accounting', root), 'runs');
    const receipts = await Promise.all(args.receipts.map(async (path) => JSON.parse(await readFile(authorityContained(directory, path, 'receipt'), 'utf8'))));
    process.stdout.write(`${JSON.stringify(await verifyReceipts(manifest, files, receipts, { head, root, authorityDirectory: directory }))}\n`); return;
  }
  const outcome = checkInventory(manifest, files, args.suites, args); const selected = selectedRuns(manifest, files, { suites: args.suites, profile: args.profile });
  const value = { ...outcome, runs: selected.runs.map((run) => ({ suite: run.suite.id, profile: profileId(run.profile), files: run.files })) };
  if (args.json) await writeFile(containedPath(root, args.json, { label: 'plan output' }), `${JSON.stringify(value, null, 2)}\n`);
  const planned = Object.values(outcome.plans).reduce((sum, plan) => sum + plan.length, 0); process.stdout.write(`test accounting: ${outcome.executable.length} executable, ${outcome.helpers.length} helpers, ${planned} planned, ${outcome.executable.length - planned} excluded\n`);
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
