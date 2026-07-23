// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizePath, stable } from './inventory.mjs';

const PACKET_SCHEMA = 'pdpp.test-accounting.task-packet/v3';
const LEASE_SCHEMA = 'pdpp.test-accounting.lease/v2';
const hash = (value) => createHash('sha256').update(value).digest('hex');

function fail(message) { throw new Error(`task packet: ${message}`); }
function safePath(root, path) {
  const rootReal = realpathSync(root); const candidate = resolve(rootReal, normalizePath(path));
  let target; try { target = realpathSync(candidate); } catch { fail(`missing path: ${path}`); }
  if (target !== rootReal && !target.startsWith(`${rootReal}/`)) fail(`path escapes repository: ${path}`);
  return target;
}
function safeLeasePath(directory, file) {
  const real = realpathSync(directory); const target = resolve(real, file);
  if (target !== real && !target.startsWith(`${real}/`)) fail(`lease path escapes authority directory: ${file}`);
  return target;
}
export function fileDigest(root, path) { return hash(readFileSync(safePath(root, path))); }
function pathSet(paths, label) {
  if (!Array.isArray(paths) || paths.length === 0) fail(`${label} must be a non-empty path array`);
  const normalized = paths.map(normalizePath).sort(); if (new Set(normalized).size !== normalized.length) fail(`${label} has duplicates`);
  return normalized;
}
function materialization(packet) {
  if (typeof packet.packet_path !== 'string') fail('packet_path is required');
  const packetPath = normalizePath(packet.packet_path); const retired = Array.isArray(packet.retired_paths) ? packet.retired_paths.map(normalizePath).sort() : fail('retired_paths must be an array');
  if (new Set(retired).size !== retired.length || retired.includes(packetPath)) fail('retired_paths are invalid');
  return { packet_path: packetPath, retired_paths: retired };
}
function overlaps(left, right) { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }

function tokens(source) {
  const result = [];
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === '/' && source[index + 1] === '/') { index = source.indexOf('\n', index + 2); if (index < 0) break; continue; }
    if (char === '/' && source[index + 1] === '*') { const end = source.indexOf('*/', index + 2); if (end < 0) fail('unterminated source comment'); index = end + 2; continue; }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char; let value = ''; let interpolated = false; index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') index += 1;
        if (quote === '`' && source[index] === '$' && source[index + 1] === '{') interpolated = true;
        value += source[index] ?? ''; index += 1;
      }
      if (source[index] !== quote) fail('unterminated source string'); result.push({ type: interpolated ? 'template' : 'string', value }); index += 1; continue;
    }
    if (/[A-Za-z_$]/.test(char)) { let value = char; index += 1; while (/[A-Za-z0-9_$]/.test(source[index] ?? '')) { value += source[index]; index += 1; } result.push({ type: 'word', value }); continue; }
    result.push({ type: 'punctuation', value: char }); index += 1;
  }
  return result;
}
function resolveSpecifier(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const path = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (path.startsWith('../') || path === '..') fail(`runtime target escapes repository: ${specifier}`);
  return normalizePath(path);
}
function importTargets(from, stream, kind) {
  const values = new Set();
  for (let index = 0; index < stream.length; index += 1) {
    const token = stream[index]; if (token.type !== 'word') continue;
    if (kind === 'dynamic' && token.value === 'import' && stream[index + 1]?.value === '(' && stream[index + 2]?.type === 'string') values.add(resolveSpecifier(from, stream[index + 2].value));
    if (kind === 'literal' && token.value === 'import') {
      if (stream[index + 1]?.type === 'string') values.add(resolveSpecifier(from, stream[index + 1].value));
      for (let next = index + 1; next < Math.min(stream.length, index + 80) && stream[next].value !== ';'; next += 1) if (stream[next].value === 'from' && stream[next + 1]?.type === 'string') values.add(resolveSpecifier(from, stream[next + 1].value));
    }
    if (kind === 'literal' && token.value === 'export') for (let next = index + 1; next < Math.min(stream.length, index + 80) && stream[next].value !== ';'; next += 1) if (stream[next].value === 'from' && stream[next + 1]?.type === 'string') values.add(resolveSpecifier(from, stream[next + 1].value));
    if (kind === 'literal' && token.value === 'require' && stream[index + 1]?.value === '(' && stream[index + 2]?.type === 'string') values.add(resolveSpecifier(from, stream[index + 2].value));
  }
  return values;
}
function spawnTargets(from, stream) {
  const values = new Set();
  for (let index = 0; index < stream.length; index += 1) {
    if (stream[index].type !== 'word' || !['spawn', 'execFile', 'execFileSync'].includes(stream[index].value) || stream[index + 1]?.value !== '(') continue;
    let depth = 0;
    for (let next = index + 2; next < stream.length; next += 1) {
      if (stream[next].value === '(' || stream[next].value === '[') depth += 1;
      if (stream[next].value === ')' || stream[next].value === ']') { if (depth === 0 && stream[next].value === ')') break; depth -= 1; }
      if (stream[next].type === 'string') values.add(resolveSpecifier(from, stream[next].value));
    }
  }
  return values;
}
function manifestCommandTargets(root, from) {
  const source = tokens(readFileSync(safePath(root, from), 'utf8'));
  if (!source.some((token, index) => token.value === 'spawn' && source[index + 1]?.value === '(')) fail(`${from} does not spawn manifest commands`);
  const manifest = JSON.parse(readFileSync(safePath(root, 'test-accounting.manifest.json'), 'utf8'));
  const values = [];
  for (const suite of manifest.suites ?? []) {
    for (const argument of suite.command ?? []) {
      if (typeof argument !== 'string' || !/\.(?:[cm]?js|ts)$/.test(argument)) continue;
      const target = normalizePath(posix.join(suite.cwd, argument));
      safePath(root, target); values.push({ target, declaration: suite.id });
    }
  }
  return values;
}
export function sourceResolvesEdge(root, edge) {
  if (!edge || !['literal', 'dynamic', 'spawn', 'manifest-command'].includes(edge.kind)) fail('runtime edge kind is invalid');
  const from = normalizePath(edge.from); const target = normalizePath(edge.target); const source = readFileSync(safePath(root, from), 'utf8'); safePath(root, target);
  const stream = tokens(source);
  if (edge.kind === 'manifest-command') {
    const resolved = manifestCommandTargets(root, from);
    if (!resolved.some((value) => value.target === target && value.declaration === edge.declaration)) fail(`runtime edge is not source-resolved: ${from} -> ${target}`);
    return { from, target, kind: edge.kind, declaration: edge.declaration, from_sha256: hash(source), target_sha256: fileDigest(root, target) };
  }
  const resolved = edge.kind === 'spawn' ? spawnTargets(from, stream) : importTargets(from, stream, edge.kind);
  if (!resolved.has(target)) fail(`runtime edge is not source-resolved: ${from} -> ${target}`);
  return { from, target, kind: edge.kind, declaration: edge.declaration ?? null, from_sha256: hash(source), target_sha256: fileDigest(root, target) };
}
function canonicalGenerated(generated) {
  if (!Array.isArray(generated)) fail('generated_artifacts must be an array');
  return generated.map((artifact) => {
    if (!artifact || typeof artifact !== 'object' || !Array.isArray(artifact.check_command) || artifact.check_command.length < 2 || artifact.check_command.some((part) => typeof part !== 'string' || !part) || typeof artifact.generator !== 'string' || typeof artifact.output !== 'string' || typeof artifact.sha256 !== 'string') fail('generated artifact is malformed');
    return { output: normalizePath(artifact.output), generator: normalizePath(artifact.generator), check_command: artifact.check_command, sha256: artifact.sha256 };
  }).sort((left, right) => stable(left).localeCompare(stable(right)));
}
function requiredManifestEdges(root) {
  const authority = 'scripts/test-accounting/authority.mjs';
  if (!existsSync(resolve(root, authority))) return [];
  return manifestCommandTargets(root, authority).map((edge) => ({ from: authority, target: edge.target, kind: 'manifest-command', declaration: edge.declaration }));
}
function assertCompleteManifestEdges(root, edges) {
  for (const expected of requiredManifestEdges(root)) {
    if (!edges.some((edge) => edge.from === expected.from && edge.target === expected.target && edge.kind === expected.kind && edge.declaration === expected.declaration)) fail(`runtime edge is missing from packet: ${expected.from} -> ${expected.target} (${expected.declaration})`);
  }
}
export function closureDigest(packet, root) {
  const owned = pathSet(packet.owned_paths, 'owned_paths').map((path) => [path, fileDigest(root, path)]);
  const forbidden = pathSet(packet.forbidden_paths, 'forbidden_paths');
  const materialized = materialization(packet);
  const declared = packet.runtime_edges ?? []; if (!Array.isArray(declared)) fail('runtime_edges must be an array');
  assertCompleteManifestEdges(root, declared);
  const edges = declared.map((edge) => sourceResolvesEdge(root, edge)).sort((a, b) => stable(a).localeCompare(stable(b)));
  const generated = canonicalGenerated(packet.generated_artifacts ?? []);
  if (!packet.test_manifest?.path || typeof packet.test_manifest.sha256 !== 'string') fail('test manifest is malformed');
  return hash(stable({ base_sha: packet.base_sha, owned, forbidden, materialized, edges, generated, test_manifest: [packet.test_manifest.path, packet.test_manifest.sha256, fileDigest(root, packet.test_manifest.path)] }));
}
function validateGenerated(root, generated) {
  for (const artifact of canonicalGenerated(generated ?? [])) {
    const generator = normalizePath(artifact.generator); safePath(root, generator); safePath(root, artifact.output);
    if (normalizePath(artifact.check_command[1]) !== generator) fail(`generated artifact command does not directly execute its canonical generator: ${artifact.output}`);
    const isolated = mkdtempSync(join(tmpdir(), 'pdpp-generator-'));
    try {
      cpSync(root, isolated, { recursive: true, filter: (path) => !path.split('/').includes('.git') && !path.endsWith('/node_modules') });
      const output = resolve(isolated, normalizePath(artifact.output)); rmSync(output, { force: true });
      const result = spawnSync(artifact.check_command[0], artifact.check_command.slice(1), { cwd: isolated, encoding: 'utf8' });
      if (result.error || result.status !== 0 || !existsSync(output)) fail(`canonical generator did not recreate output: ${artifact.output}`);
      if (hash(readFileSync(output)) !== artifact.sha256 || fileDigest(root, artifact.output) !== artifact.sha256) fail(`generated artifact bytes drifted: ${artifact.output}`);
    } finally { rmSync(isolated, { recursive: true, force: true }); }
  }
}
export function claimPacketLease(packet, { root, leaseDirectory }) {
  const closure = closureDigest(packet, root); mkdirSync(leaseDirectory, { recursive: true });
  const id = `${packet.base_sha}-${closure}`; const target = safeLeasePath(leaseDirectory, `${id}.json`); let fd;
  try { fd = openSync(target, 'wx'); } catch { fail(`lease already claimed: ${id}`); }
  const lease = { schema: LEASE_SCHEMA, id, nonce: randomUUID(), base_sha: packet.base_sha, closure_sha256: closure, owned_paths: pathSet(packet.owned_paths, 'owned_paths'), forbidden_paths: pathSet(packet.forbidden_paths, 'forbidden_paths'), materialization: materialization(packet), generated_artifacts: canonicalGenerated(packet.generated_artifacts ?? []) };
  writeFileSync(fd, `${JSON.stringify(lease)}\n`); return lease;
}
export function validatePacket(packet, { head, root, leaseDirectory }) {
  if (packet.schema !== PACKET_SCHEMA) fail('schema is invalid');
  if (typeof packet.base_sha !== 'string' || !/^[0-9a-f]{40}$/.test(packet.base_sha)) fail('base SHA is invalid');
  const materialized = materialization(packet);
  if (packet.base_sha !== head) {
    let parent;
    try { parent = execFileSync('git', ['rev-parse', `${head}^`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { fail(`base ${packet.base_sha} does not match ${head}`); }
    if (parent !== packet.base_sha) fail(`base ${packet.base_sha} does not directly materialize ${head}`);
    safePath(root, materialized.packet_path);
    const changed = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', packet.base_sha, head], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(normalizePath); const allowed = new Set([...pathSet(packet.owned_paths, 'owned_paths'), materialized.packet_path, ...materialized.retired_paths]);
    if (!changed.includes(materialized.packet_path) || changed.some((path) => !allowed.has(path))) fail('direct child does not exclusively materialize this packet');
  }
  const owned = pathSet(packet.owned_paths, 'owned_paths'); const forbidden = pathSet(packet.forbidden_paths, 'forbidden_paths');
  for (const path of owned) for (const blocked of forbidden) if (overlaps(path, blocked)) fail(`owned/forbidden paths overlap: ${path} / ${blocked}`);
  for (const path of [...owned, ...forbidden]) safePath(root, path);
  if (!packet.test_manifest?.path || !packet.test_manifest?.sha256 || fileDigest(root, packet.test_manifest.path) !== packet.test_manifest.sha256) fail('test manifest changed or is malformed');
  const closure = closureDigest(packet, root); if (packet.closure_sha256 !== closure) fail('content closure hash is stale');
  validateGenerated(root, packet.generated_artifacts);
  if (!packet.lease_receipt?.id || !packet.lease_receipt?.nonce || !leaseDirectory) fail('atomic lease receipt is required');
  const lease = JSON.parse(readFileSync(safeLeasePath(leaseDirectory, `${packet.lease_receipt.id}.json`), 'utf8'));
  if (lease.schema !== LEASE_SCHEMA || lease.id !== packet.lease_receipt.id || lease.base_sha !== packet.base_sha || lease.closure_sha256 !== closure || lease.nonce !== packet.lease_receipt.nonce || stable(lease.owned_paths) !== stable(owned) || stable(lease.forbidden_paths) !== stable(forbidden) || stable(lease.materialization) !== stable(materialized) || stable(lease.generated_artifacts) !== stable(canonicalGenerated(packet.generated_artifacts ?? []))) fail('atomic lease receipt does not bind this packet');
  return { base_sha: packet.base_sha, closure_sha256: closure, lease: lease.id };
}
export function gitHead(root) { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
function parseArgs(argv) {
  const value = {}; for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]; if (!['--claim', '--validate'].includes(arg) || value.mode) fail('use exactly one of --claim or --validate followed by PACKET');
    const packet = argv[index + 1]; if (!packet || packet.startsWith('--')) fail(`${arg} requires PACKET`); value.mode = arg; value.packet = packet; index += 1;
    while (index + 1 < argv.length) { const flag = argv[index + 1]; if (flag !== '--lease-directory') break; const item = argv[index + 2]; if (!item || item.startsWith('--') || value[flag]) fail(`${flag} requires exactly one value`); value[flag] = item; index += 2; }
  } return value;
}
function main() {
  const input = parseArgs(process.argv.slice(2)); const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); const packet = JSON.parse(readFileSync(safePath(root, input.packet), 'utf8'));
  if (input['--lease-directory']) fail('--lease-directory is not available from the production CLI');
  const leaseDirectory = resolve(root, execFileSync('git', ['rev-parse', '--git-path', 'test-accounting/leases'], { cwd: root, encoding: 'utf8' }).trim());
  if (input.mode === '--claim') process.stdout.write(`${JSON.stringify(claimPacketLease(packet, { root, leaseDirectory }))}\n`);
  else process.stdout.write(`${JSON.stringify(validatePacket(packet, { root, head: gitHead(root), leaseDirectory }))}\n`);
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
