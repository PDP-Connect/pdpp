// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { claimPacketLease, closureDigest, fileDigest, sourceResolvesEdge, validatePacket } from './packet.mjs';

const base = '1111111111111111111111111111111111111111';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pdpp-packet-')); await mkdir(join(root, 'generated'), { recursive: true });
  await writeFile(join(root, 'runner.mjs'), '// target-a.mjs is not an edge\nawait import("./target-b.mjs");\nspawn("node", ["./target-b.mjs"]);\n');
  await writeFile(join(root, 'target-a.mjs'), 'export const target = "a";\n'); await writeFile(join(root, 'target-b.mjs'), 'export const target = "b";\n');
  await writeFile(join(root, 'generated', 'artifact.json'), '{"version":1}\n');
  await writeFile(join(root, 'generator.mjs'), 'import { writeFile } from "node:fs/promises"; await writeFile("generated/artifact.json", "{\\"version\\":1}\\n");\n');
  await writeFile(join(root, 'manifest.json'), '{}\n'); return root;
}
function packet(root, overrides = {}) {
  const value = { schema: 'pdpp.test-accounting.task-packet/v3', base_sha: base, packet_path: 'packet.json', retired_paths: [], owned_paths: ['runner.mjs'], forbidden_paths: ['generated'], runtime_edges: [{ from: 'runner.mjs', target: 'target-b.mjs', kind: 'dynamic' }, { from: 'runner.mjs', target: 'target-b.mjs', kind: 'spawn' }], generated_artifacts: [], test_manifest: { path: 'manifest.json', sha256: fileDigest(root, 'manifest.json') }, ...overrides };
  value.closure_sha256 = closureDigest(value, root); const lease = claimPacketLease(value, { root, leaseDirectory: join(root, 'leases') }); return { ...value, lease_receipt: { id: lease.id, nonce: lease.nonce } };
}
test('rejects stale bases and duplicate atomic leases', async () => {
  const root = await fixture(); const value = packet(root); assert.throws(() => validatePacket(value, { root, head: 'next', leaseDirectory: join(root, 'leases') }), /base/); assert.throws(() => claimPacketLease(value, { root, leaseDirectory: join(root, 'leases') }), /already claimed/);
});
test('accepts only the direct packet materialization commit and rejects its descendant', async () => {
  const root = await fixture(); execFileSync('git', ['init', '-q'], { cwd: root }); execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root }); execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: root }); execFileSync('git', ['add', '.'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const materializedBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); await writeFile(join(root, 'runner.mjs'), '// materialized\nawait import("./target-b.mjs");\nspawn("node", ["./target-b.mjs"]);\n');
  const value = packet(root, { base_sha: materializedBase }); await writeFile(join(root, 'packet.json'), JSON.stringify(value)); execFileSync('git', ['add', 'runner.mjs', 'packet.json'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'materialize'], { cwd: root }); const materializedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(validatePacket(value, { root, head: materializedHead, leaseDirectory: join(root, 'leases') }).base_sha, materializedBase);
  await writeFile(join(root, 'target-a.mjs'), 'export const target = "later";\n'); execFileSync('git', ['add', 'target-a.mjs'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'unrelated descendant'], { cwd: root }); const descendant = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.throws(() => validatePacket(value, { root, head: descendant, leaseDirectory: join(root, 'leases') }), /directly materialize/);
});
test('source-resolves literal dynamic and spawn targets rather than accepting comments', async () => {
  const root = await fixture(); assert.equal(sourceResolvesEdge(root, { from: 'runner.mjs', target: 'target-b.mjs', kind: 'dynamic' }).target, 'target-b.mjs'); assert.equal(sourceResolvesEdge(root, { from: 'runner.mjs', target: 'target-b.mjs', kind: 'spawn' }).target, 'target-b.mjs');
  assert.throws(() => sourceResolvesEdge(root, { from: 'runner.mjs', target: 'target-a.mjs', kind: 'dynamic' }), /source-resolved/);
  await writeFile(join(root, 'runner.mjs'), 'await import(`./target-${kind}.mjs`);\nspawn("node", [`./target-${kind}.mjs`]);\n'); assert.throws(() => sourceResolvesEdge(root, { from: 'runner.mjs', target: 'target-b.mjs', kind: 'dynamic' }), /source-resolved/); assert.throws(() => sourceResolvesEdge(root, { from: 'runner.mjs', target: 'target-b.mjs', kind: 'spawn' }), /source-resolved/);
  await writeFile(join(root, 'runner.mjs'), 'await import("./target-a.mjs");\nspawn("node", ["./target-a.mjs"]);\n'); const value = packet(root, { runtime_edges: [{ from: 'runner.mjs', target: 'target-a.mjs', kind: 'dynamic' }, { from: 'runner.mjs', target: 'target-a.mjs', kind: 'spawn' }] }); await writeFile(join(root, 'runner.mjs'), 'await import("./target-b.mjs");\nspawn("node", ["./target-b.mjs"]);\n'); assert.throws(() => validatePacket(value, { root, head: base, leaseDirectory: join(root, 'leases') }), /source-resolved|stale/);
});
test('requires every authority manifest command edge instead of trusting a partial declaration', async () => {
  const root = await fixture(); await mkdir(join(root, 'scripts', 'test-accounting'), { recursive: true });
  await writeFile(join(root, 'scripts', 'test-accounting', 'authority.mjs'), 'const command = ["node", "scripts/test-accounting/execute.mjs"]; spawn(command[0], command.slice(1));\n');
  await writeFile(join(root, 'scripts', 'test-accounting', 'execute.mjs'), 'export const runner = true;\n');
  await writeFile(join(root, 'test-accounting.manifest.json'), JSON.stringify({ suites: [{ id: 'root-node', cwd: '.', command: ['node', 'scripts/test-accounting/execute.mjs'] }] }));
  assert.throws(() => packet(root), /runtime edge is missing/);
  const edge = { from: 'scripts/test-accounting/authority.mjs', target: 'scripts/test-accounting/execute.mjs', kind: 'manifest-command', declaration: 'root-node' };
  assert.equal(sourceResolvesEdge(root, edge).target, edge.target);
  const value = packet(root, { runtime_edges: [{ from: 'runner.mjs', target: 'target-b.mjs', kind: 'dynamic' }, { from: 'runner.mjs', target: 'target-b.mjs', kind: 'spawn' }, edge] });
  assert.deepEqual(validatePacket(value, { root, head: base, leaseDirectory: join(root, 'leases') }).base_sha, base);
});
test('executes the canonical generator in an empty output location and compares recreated bytes', async () => {
  const root = await fixture(); const artifact = { output: 'generated/artifact.json', sha256: fileDigest(root, 'generated/artifact.json'), generator: 'generator.mjs', check_command: ['node', 'generator.mjs'] }; const value = packet(root, { generated_artifacts: [artifact] });
  assert.deepEqual(validatePacket(value, { root, head: base, leaseDirectory: join(root, 'leases') }).base_sha, base);
  const noop = await fixture(); await writeFile(join(noop, 'generator.mjs'), 'process.exitCode = 0;\n'); const noOutput = packet(noop, { generated_artifacts: [{ ...artifact }] }); assert.throws(() => validatePacket(noOutput, { root: noop, head: base, leaseDirectory: join(noop, 'leases') }), /did not recreate output/);
  const inert = await fixture(); await writeFile(join(inert, 'generator.mjs'), 'process.exitCode = 0;\n'); const inertCommand = packet(inert, { generated_artifacts: [{ ...artifact, check_command: ['node', '-e', 'require("node:fs").writeFileSync("generated/artifact.json", "{\\\"version\\\":1}\\n")', 'generator.mjs'] }] }); assert.throws(() => validatePacket(inertCommand, { root: inert, head: base, leaseDirectory: join(inert, 'leases') }), /directly execute/);
});
test('binds forbidden paths and generated artifacts into both closure and lease', async () => {
  const root = await fixture(); const artifact = { output: 'generated/artifact.json', sha256: fileDigest(root, 'generated/artifact.json'), generator: 'generator.mjs', check_command: ['node', 'generator.mjs'] }; const value = packet(root, { generated_artifacts: [artifact] });
  assert.throws(() => validatePacket({ ...value, forbidden_paths: ['target-a.mjs'] }, { root, head: base, leaseDirectory: join(root, 'leases') }), /stale/);
  assert.throws(() => validatePacket({ ...value, generated_artifacts: [] }, { root, head: base, leaseDirectory: join(root, 'leases') }), /stale/);
  assert.throws(() => validatePacket({ ...value, test_manifest: { ...value.test_manifest, sha256: '0'.repeat(64) } }, { root, head: base, leaseDirectory: join(root, 'leases') }), /changed or is malformed/);
});
test('rejects symlink escapes, stale content, overlapping ownership, and forged lease paths', async () => {
  const root = await fixture(); await symlink('/etc/hosts', join(root, 'escape.mjs')); assert.throws(() => sourceResolvesEdge(root, { from: 'runner.mjs', target: 'escape.mjs', kind: 'dynamic' }), /escapes repository|source-resolved/);
  const conflict = packet(root, { owned_paths: ['generated/artifact.json'], forbidden_paths: ['generated'] }); assert.throws(() => validatePacket(conflict, { root, head: base, leaseDirectory: join(root, 'leases') }), /overlap/);
  const value = packet(root); await writeFile(join(root, 'target-b.mjs'), 'export const target = "changed";\n'); assert.throws(() => validatePacket(value, { root, head: base, leaseDirectory: join(root, 'leases') }), /stale/);
  const other = await fixture(); const forged = { ...packet(other), lease_receipt: { id: '../outside', nonce: 'x' } }; assert.throws(() => validatePacket(forged, { root: other, head: base, leaseDirectory: join(other, 'leases') }), /escapes/);
});
