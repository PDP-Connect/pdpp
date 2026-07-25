// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  claimPacketLease,
  closureDigest,
  fileDigest,
  type Packet,
  sourceResolvesEdge,
  validatePacket,
} from "./packet.ts";

const BASE_PATTERN = /base/;
const ALREADY_CLAIMED_PATTERN = /already claimed/;
const DIRECTLY_MATERIALIZE_PATTERN = /directly materialize/;
const SOURCE_RESOLVED_PATTERN = /source-resolved/;
const SOURCE_RESOLVED_STALE_PATTERN = /source-resolved|stale/;
const RUNTIME_EDGE_IS_MISSING_PATTERN = /runtime edge is missing/;
const DID_NOT_RECREATE_OUTPUT_PATTERN = /did not recreate output/;
const DIRECTLY_EXECUTE_PATTERN = /directly execute/;
const STALE_PATTERN = /stale/;
const CHANGED_OR_IS_MALFORMED_PATTERN = /changed or is malformed/;
const ESCAPES_REPOSITORY_SOURCE_RESOLVED_PATTERN = /escapes repository|source-resolved/;
const OVERLAP_PATTERN = /overlap/;
const ESCAPES_PATTERN = /escapes/;

const base = "1111111111111111111111111111111111111111";
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pdpp-packet-"));
  await mkdir(join(root, "generated"), { recursive: true });
  await writeFile(
    join(root, "runner.mjs"),
    '// target-a.mjs is not an edge\nawait import("./target-b.mjs");\nspawn("node", ["./target-b.mjs"]);\n'
  );
  await writeFile(join(root, "target-a.mjs"), 'export const target = "a";\n');
  await writeFile(join(root, "target-b.mjs"), 'export const target = "b";\n');
  await writeFile(join(root, "generated", "artifact.json"), '{"version":1}\n');
  await writeFile(
    join(root, "generator.mjs"),
    'import { writeFile } from "node:fs/promises"; await writeFile("generated/artifact.json", "{\\"version\\":1}\\n");\n'
  );
  await writeFile(join(root, "manifest.json"), "{}\n");
  return root;
}
function packet(root: string, overrides: Partial<Packet> = {}): Packet {
  const value: Packet = {
    schema: "pdpp.test-accounting.task-packet/v3",
    base_sha: base,
    packet_path: "packet.json",
    retired_paths: [],
    owned_paths: ["runner.mjs"],
    forbidden_paths: ["generated"],
    runtime_edges: [
      { from: "runner.mjs", target: "target-b.mjs", kind: "dynamic" },
      { from: "runner.mjs", target: "target-b.mjs", kind: "spawn" },
    ],
    generated_artifacts: [],
    test_manifest: { path: "manifest.json", sha256: fileDigest(root, "manifest.json") },
    ...overrides,
  };
  value.closure_sha256 = closureDigest(value, root);
  const lease = claimPacketLease(value, { root, leaseDirectory: join(root, "leases") });
  return { ...value, lease_receipt: { id: lease.id, nonce: lease.nonce } };
}
test("rejects stale bases and duplicate atomic leases", async () => {
  const root = await fixture();
  const value = packet(root);
  assert.throws(
    () => validatePacket(value, { root, head: "next", leaseDirectory: join(root, "leases") }),
    BASE_PATTERN
  );
  assert.throws(() => claimPacketLease(value, { root, leaseDirectory: join(root, "leases") }), ALREADY_CLAIMED_PATTERN);
});
test("accepts only the direct packet materialization commit and rejects its descendant", async () => {
  const root = await fixture();
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "fixture"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  const materializedBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  await writeFile(
    join(root, "runner.mjs"),
    '// materialized\nawait import("./target-b.mjs");\nspawn("node", ["./target-b.mjs"]);\n'
  );
  const value = packet(root, { base_sha: materializedBase });
  await writeFile(join(root, "packet.json"), JSON.stringify(value));
  execFileSync("git", ["add", "runner.mjs", "packet.json"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "materialize"], { cwd: root });
  const materializedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(
    validatePacket(value, { root, head: materializedHead, leaseDirectory: join(root, "leases") }).base_sha,
    materializedBase
  );
  await writeFile(join(root, "target-a.mjs"), 'export const target = "later";\n');
  execFileSync("git", ["add", "target-a.mjs"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "unrelated descendant"], { cwd: root });
  const descendant = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.throws(
    () => validatePacket(value, { root, head: descendant, leaseDirectory: join(root, "leases") }),
    DIRECTLY_MATERIALIZE_PATTERN
  );
});
test("source-resolves literal dynamic and spawn targets rather than accepting comments", async () => {
  const root = await fixture();
  assert.equal(
    sourceResolvesEdge(root, { from: "runner.mjs", target: "target-b.mjs", kind: "dynamic" }).target,
    "target-b.mjs"
  );
  assert.equal(
    sourceResolvesEdge(root, { from: "runner.mjs", target: "target-b.mjs", kind: "spawn" }).target,
    "target-b.mjs"
  );
  assert.throws(
    () => sourceResolvesEdge(root, { from: "runner.mjs", target: "target-a.mjs", kind: "dynamic" }),
    SOURCE_RESOLVED_PATTERN
  );
  await writeFile(
    join(root, "runner.mjs"),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is a fixture — a single-quoted string containing real JS source text (its own backtick template literal with an unresolved ${kind} interpolation, deliberately non-literal) written out to a file, not a forgotten template literal here.
    'await import(`./target-${kind}.mjs`);\nspawn("node", [`./target-${kind}.mjs`]);\n'
  );
  assert.throws(
    () => sourceResolvesEdge(root, { from: "runner.mjs", target: "target-b.mjs", kind: "dynamic" }),
    SOURCE_RESOLVED_PATTERN
  );
  assert.throws(
    () => sourceResolvesEdge(root, { from: "runner.mjs", target: "target-b.mjs", kind: "spawn" }),
    SOURCE_RESOLVED_PATTERN
  );
  await writeFile(join(root, "runner.mjs"), 'await import("./target-a.mjs");\nspawn("node", ["./target-a.mjs"]);\n');
  const value = packet(root, {
    runtime_edges: [
      { from: "runner.mjs", target: "target-a.mjs", kind: "dynamic" },
      { from: "runner.mjs", target: "target-a.mjs", kind: "spawn" },
    ],
  });
  await writeFile(join(root, "runner.mjs"), 'await import("./target-b.mjs");\nspawn("node", ["./target-b.mjs"]);\n');
  assert.throws(
    () => validatePacket(value, { root, head: base, leaseDirectory: join(root, "leases") }),
    SOURCE_RESOLVED_STALE_PATTERN
  );
});
test("requires every authority manifest command edge instead of trusting a partial declaration", async () => {
  const root = await fixture();
  await mkdir(join(root, "scripts", "test-accounting"), { recursive: true });
  // packet.ts hardcodes 'scripts/test-accounting/authority.ts' as the
  // required-edge source (see requiredManifestEdges); this isolated fixture
  // root must mirror that exact filename, not the real repo's authority.ts.
  await writeFile(
    join(root, "scripts", "test-accounting", "authority.ts"),
    'const command = ["node", "scripts/test-accounting/leaf.mjs"]; spawn(command[0], command.slice(1));\n'
  );
  await writeFile(join(root, "scripts", "test-accounting", "leaf.mjs"), "export const runner = true;\n");
  await writeFile(
    join(root, "test-accounting.manifest.json"),
    JSON.stringify({ suites: [{ id: "root-node", cwd: ".", command: ["node", "scripts/test-accounting/leaf.mjs"] }] })
  );
  assert.throws(() => packet(root), RUNTIME_EDGE_IS_MISSING_PATTERN);
  const edge = {
    from: "scripts/test-accounting/authority.ts",
    target: "scripts/test-accounting/leaf.mjs",
    kind: "manifest-command" as const,
    declaration: "root-node",
  };
  assert.equal(sourceResolvesEdge(root, edge).target, edge.target);
  const value = packet(root, {
    runtime_edges: [
      { from: "runner.mjs", target: "target-b.mjs", kind: "dynamic" },
      { from: "runner.mjs", target: "target-b.mjs", kind: "spawn" },
      edge,
    ],
  });
  assert.deepEqual(validatePacket(value, { root, head: base, leaseDirectory: join(root, "leases") }).base_sha, base);
});
test("executes the canonical generator in an empty output location and compares recreated bytes", async () => {
  const root = await fixture();
  const artifact = {
    output: "generated/artifact.json",
    sha256: fileDigest(root, "generated/artifact.json"),
    generator: "generator.mjs",
    check_command: ["node", "generator.mjs"],
  };
  const value = packet(root, { generated_artifacts: [artifact] });
  assert.deepEqual(validatePacket(value, { root, head: base, leaseDirectory: join(root, "leases") }).base_sha, base);
  const noop = await fixture();
  await writeFile(join(noop, "generator.mjs"), "process.exitCode = 0;\n");
  const noOutput = packet(noop, { generated_artifacts: [{ ...artifact }] });
  assert.throws(
    () => validatePacket(noOutput, { root: noop, head: base, leaseDirectory: join(noop, "leases") }),
    DID_NOT_RECREATE_OUTPUT_PATTERN
  );
  const inert = await fixture();
  await writeFile(join(inert, "generator.mjs"), "process.exitCode = 0;\n");
  const inertCommand = packet(inert, {
    generated_artifacts: [
      {
        ...artifact,
        check_command: [
          "node",
          "-e",
          'require("node:fs").writeFileSync("generated/artifact.json", "{\\"version\\":1}\\n")',
          "generator.mjs",
        ],
      },
    ],
  });
  assert.throws(
    () => validatePacket(inertCommand, { root: inert, head: base, leaseDirectory: join(inert, "leases") }),
    DIRECTLY_EXECUTE_PATTERN
  );
});
test("binds forbidden paths and generated artifacts into both closure and lease", async () => {
  const root = await fixture();
  const artifact = {
    output: "generated/artifact.json",
    sha256: fileDigest(root, "generated/artifact.json"),
    generator: "generator.mjs",
    check_command: ["node", "generator.mjs"],
  };
  const value = packet(root, { generated_artifacts: [artifact] });
  assert.throws(
    () =>
      validatePacket(
        { ...value, forbidden_paths: ["target-a.mjs"] },
        { root, head: base, leaseDirectory: join(root, "leases") }
      ),
    STALE_PATTERN
  );
  assert.throws(
    () =>
      validatePacket({ ...value, generated_artifacts: [] }, { root, head: base, leaseDirectory: join(root, "leases") }),
    STALE_PATTERN
  );
  assert.throws(
    () =>
      validatePacket(
        { ...value, test_manifest: { ...value.test_manifest, sha256: "0".repeat(64) } },
        { root, head: base, leaseDirectory: join(root, "leases") }
      ),
    CHANGED_OR_IS_MALFORMED_PATTERN
  );
});
test("rejects symlink escapes, stale content, overlapping ownership, and forged lease paths", async () => {
  const root = await fixture();
  await symlink("/etc/hosts", join(root, "escape.mjs"));
  assert.throws(
    () => sourceResolvesEdge(root, { from: "runner.mjs", target: "escape.mjs", kind: "dynamic" }),
    ESCAPES_REPOSITORY_SOURCE_RESOLVED_PATTERN
  );
  const conflict = packet(root, { owned_paths: ["generated/artifact.json"], forbidden_paths: ["generated"] });
  assert.throws(
    () => validatePacket(conflict, { root, head: base, leaseDirectory: join(root, "leases") }),
    OVERLAP_PATTERN
  );
  const value = packet(root);
  await writeFile(join(root, "target-b.mjs"), 'export const target = "changed";\n');
  assert.throws(() => validatePacket(value, { root, head: base, leaseDirectory: join(root, "leases") }), STALE_PATTERN);
  const other = await fixture();
  const forged: Packet = { ...packet(other), lease_receipt: { id: "../outside", nonce: "x" } };
  assert.throws(
    () => validatePacket(forged, { root: other, head: base, leaseDirectory: join(other, "leases") }),
    ESCAPES_PATTERN
  );
});
