// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { normalizePath, stable } from "./inventory.ts";

const PACKET_SCHEMA = "pdpp.test-accounting.task-packet/v3";
const LEASE_SCHEMA = "pdpp.test-accounting.lease/v2";
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SCRIPT_EXTENSION_PATTERN = /\.(?:[cm]?js|ts)$/;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fail(message: string): never {
  throw new Error(`task packet: ${message}`);
}
function safePath(root: string, path: string): string {
  const rootReal = realpathSync(root);
  const candidate = resolve(rootReal, normalizePath(path));
  let target: string;
  try {
    target = realpathSync(candidate);
  } catch {
    fail(`missing path: ${path}`);
  }
  if (target !== rootReal && !target.startsWith(`${rootReal}/`)) {
    fail(`path escapes repository: ${path}`);
  }
  return target;
}
function safeLeasePath(directory: string, file: string): string {
  const real = realpathSync(directory);
  const target = resolve(real, file);
  if (target !== real && !target.startsWith(`${real}/`)) {
    fail(`lease path escapes authority directory: ${file}`);
  }
  return target;
}
export function fileDigest(root: string, path: string): string {
  return hash(readFileSync(safePath(root, path)));
}
function pathSet(paths: unknown, label: string): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    fail(`${label} must be a non-empty path array`);
  }
  const normalized = paths.map(normalizePath).sort();
  if (new Set(normalized).size !== normalized.length) {
    fail(`${label} has duplicates`);
  }
  return normalized;
}
interface Materialization {
  packet_path: string;
  retired_paths: string[];
}
function materialization(packet: { packet_path?: unknown; retired_paths?: unknown }): Materialization {
  if (typeof packet.packet_path !== "string") {
    fail("packet_path is required");
  }
  const packetPath = normalizePath(packet.packet_path);
  const retired = Array.isArray(packet.retired_paths)
    ? packet.retired_paths.map(normalizePath).sort()
    : fail("retired_paths must be an array");
  if (new Set(retired).size !== retired.length || retired.includes(packetPath)) {
    fail("retired_paths are invalid");
  }
  return { packet_path: packetPath, retired_paths: retired };
}
function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

interface Token {
  type: "template" | "string" | "word" | "punctuation";
  value: string;
}
const WHITESPACE_PATTERN = /\s/;
const WORD_START_PATTERN = /[A-Za-z_$]/;
const WORD_CONTINUE_PATTERN = /[A-Za-z0-9_$]/;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is a hand-rolled JS/TS tokenizer and import/spawn-edge resolver carried over unchanged from the .mjs source; the branching mirrors the surface syntax it must recognize.
function tokens(source: string): Token[] {
  const result: Token[] = [];
  for (let index = 0; index < source.length; ) {
    const char = source[index];
    if (char === undefined) {
      break;
    }
    if (WHITESPACE_PATTERN.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) {
        break;
      }
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) {
        fail("unterminated source comment");
      }
      index = end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      let value = "";
      let interpolated = false;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") {
          index += 1;
        }
        if (quote === "`" && source[index] === "$" && source[index + 1] === "{") {
          interpolated = true;
        }
        value += source[index] ?? "";
        index += 1;
      }
      if (source[index] !== quote) {
        fail("unterminated source string");
      }
      result.push({ type: interpolated ? "template" : "string", value });
      index += 1;
      continue;
    }
    if (WORD_START_PATTERN.test(char)) {
      let value = char;
      index += 1;
      while (WORD_CONTINUE_PATTERN.test(source[index] ?? "")) {
        value += source[index];
        index += 1;
      }
      result.push({ type: "word", value });
      continue;
    }
    result.push({ type: "punctuation", value: char });
    index += 1;
  }
  return result;
}
function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const path = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (path.startsWith("../") || path === "..") {
    fail(`runtime target escapes repository: ${specifier}`);
  }
  return normalizePath(path);
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is a hand-rolled JS/TS tokenizer and import/spawn-edge resolver carried over unchanged from the .mjs source; the branching mirrors the surface syntax it must recognize.
function importTargets(from: string, stream: Token[], kind: "literal" | "dynamic"): Set<string | null> {
  const values = new Set<string | null>();
  for (let index = 0; index < stream.length; index += 1) {
    const token = stream[index];
    if (token?.type !== "word") {
      continue;
    }
    if (
      kind === "dynamic" &&
      token.value === "import" &&
      stream[index + 1]?.value === "(" &&
      stream[index + 2]?.type === "string"
    ) {
      const argument = stream[index + 2];
      if (argument) {
        values.add(resolveSpecifier(from, argument.value));
      }
    }
    if (kind === "literal" && token.value === "import") {
      const next1 = stream[index + 1];
      if (next1?.type === "string") {
        values.add(resolveSpecifier(from, next1.value));
      }
      for (let next = index + 1; next < Math.min(stream.length, index + 80) && stream[next]?.value !== ";"; next += 1) {
        const fromToken = stream[next];
        const specToken = stream[next + 1];
        if (fromToken?.value === "from" && specToken?.type === "string") {
          values.add(resolveSpecifier(from, specToken.value));
        }
      }
    }
    if (kind === "literal" && token.value === "export") {
      for (let next = index + 1; next < Math.min(stream.length, index + 80) && stream[next]?.value !== ";"; next += 1) {
        const fromToken = stream[next];
        const specToken = stream[next + 1];
        if (fromToken?.value === "from" && specToken?.type === "string") {
          values.add(resolveSpecifier(from, specToken.value));
        }
      }
    }
    if (
      kind === "literal" &&
      token.value === "require" &&
      stream[index + 1]?.value === "(" &&
      stream[index + 2]?.type === "string"
    ) {
      const argument = stream[index + 2];
      if (argument) {
        values.add(resolveSpecifier(from, argument.value));
      }
    }
  }
  return values;
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is a hand-rolled JS/TS tokenizer and import/spawn-edge resolver carried over unchanged from the .mjs source; the branching mirrors the surface syntax it must recognize.
function spawnTargets(from: string, stream: Token[]): Set<string | null> {
  const values = new Set<string | null>();
  for (let index = 0; index < stream.length; index += 1) {
    const token = stream[index];
    if (
      token?.type !== "word" ||
      !["spawn", "execFile", "execFileSync"].includes(token.value) ||
      stream[index + 1]?.value !== "("
    ) {
      continue;
    }
    let depth = 0;
    for (let next = index + 2; next < stream.length; next += 1) {
      const current = stream[next];
      if (!current) {
        continue;
      }
      if (current.value === "(" || current.value === "[") {
        depth += 1;
      }
      if (current.value === ")" || current.value === "]") {
        if (depth === 0 && current.value === ")") {
          break;
        }
        depth -= 1;
      }
      if (current.type === "string") {
        values.add(resolveSpecifier(from, current.value));
      }
    }
  }
  return values;
}
interface ManifestCommandTarget {
  declaration: string;
  target: string;
}
function manifestCommandTargets(root: string, from: string): ManifestCommandTarget[] {
  const source = tokens(readFileSync(safePath(root, from), "utf8"));
  if (!source.some((token, index) => token.value === "spawn" && source[index + 1]?.value === "(")) {
    fail(`${from} does not spawn manifest commands`);
  }
  const manifest: { suites?: { execution?: string; command?: unknown[]; cwd: string; id: string }[] } = JSON.parse(
    readFileSync(safePath(root, "test-accounting.manifest.json"), "utf8")
  );
  const values: ManifestCommandTarget[] = [];
  for (const suite of manifest.suites ?? []) {
    if (suite.execution === "direct") {
      continue;
    }
    for (const argument of suite.command ?? []) {
      if (typeof argument !== "string" || !SCRIPT_EXTENSION_PATTERN.test(argument)) {
        continue;
      }
      const target = normalizePath(posix.join(suite.cwd, argument));
      safePath(root, target);
      values.push({ target, declaration: suite.id });
    }
  }
  return values;
}
interface RuntimeEdge {
  declaration?: string | null;
  from: string;
  kind: "literal" | "dynamic" | "spawn" | "manifest-command";
  target: string;
}
type ResolvedEdge = Omit<RuntimeEdge, "declaration"> & {
  declaration?: string | null | undefined;
  from_sha256: string;
  target_sha256: string;
};
export function sourceResolvesEdge(root: string, edge: RuntimeEdge): ResolvedEdge {
  if (!(edge && ["literal", "dynamic", "spawn", "manifest-command"].includes(edge.kind))) {
    fail("runtime edge kind is invalid");
  }
  const from = normalizePath(edge.from);
  const target = normalizePath(edge.target);
  const source = readFileSync(safePath(root, from), "utf8");
  safePath(root, target);
  const stream = tokens(source);
  if (edge.kind === "manifest-command") {
    const resolved = manifestCommandTargets(root, from);
    if (!resolved.some((value) => value.target === target && value.declaration === edge.declaration)) {
      fail(`runtime edge is not source-resolved: ${from} -> ${target}`);
    }
    return {
      from,
      target,
      kind: edge.kind,
      declaration: edge.declaration,
      from_sha256: hash(source),
      target_sha256: fileDigest(root, target),
    };
  }
  const resolved = edge.kind === "spawn" ? spawnTargets(from, stream) : importTargets(from, stream, edge.kind);
  if (!resolved.has(target)) {
    fail(`runtime edge is not source-resolved: ${from} -> ${target}`);
  }
  return {
    from,
    target,
    kind: edge.kind,
    declaration: edge.declaration ?? null,
    from_sha256: hash(source),
    target_sha256: fileDigest(root, target),
  };
}
interface GeneratedArtifact {
  check_command: string[];
  generator: string;
  output: string;
  sha256: string;
}
function canonicalGenerated(generated: unknown): GeneratedArtifact[] {
  if (!Array.isArray(generated)) {
    fail("generated_artifacts must be an array");
  }
  return generated
    .map((artifact) => {
      if (
        !artifact ||
        typeof artifact !== "object" ||
        !Array.isArray(artifact.check_command) ||
        artifact.check_command.length < 2 ||
        artifact.check_command.some((part: unknown) => typeof part !== "string" || !part) ||
        typeof artifact.generator !== "string" ||
        typeof artifact.output !== "string" ||
        typeof artifact.sha256 !== "string"
      ) {
        fail("generated artifact is malformed");
      }
      return {
        output: normalizePath(artifact.output),
        generator: normalizePath(artifact.generator),
        check_command: artifact.check_command,
        sha256: artifact.sha256,
      };
    })
    .sort((left, right) => stable(left).localeCompare(stable(right)));
}
function requiredManifestEdges(
  root: string
): { from: string; target: string; kind: "manifest-command"; declaration: string }[] {
  const authority = "scripts/test-accounting/authority.ts";
  if (!existsSync(resolve(root, authority))) {
    return [];
  }
  return manifestCommandTargets(root, authority).map((edge) => ({
    from: authority,
    target: edge.target,
    kind: "manifest-command" as const,
    declaration: edge.declaration,
  }));
}
function assertCompleteManifestEdges(root: string, edges: RuntimeEdge[]): void {
  for (const expected of requiredManifestEdges(root)) {
    if (
      !edges.some(
        (edge) =>
          edge.from === expected.from &&
          edge.target === expected.target &&
          edge.kind === expected.kind &&
          edge.declaration === expected.declaration
      )
    ) {
      fail(`runtime edge is missing from packet: ${expected.from} -> ${expected.target} (${expected.declaration})`);
    }
  }
}
export interface Packet {
  base_sha: string;
  closure_sha256?: string;
  forbidden_paths: unknown;
  generated_artifacts?: unknown;
  lease_receipt?: { id?: string; nonce?: string };
  owned_paths: unknown;
  packet_path?: unknown;
  retired_paths?: unknown;
  runtime_edges?: unknown;
  schema?: string;
  test_manifest?: { path?: string; sha256?: string };
}
export function closureDigest(packet: Packet, root: string): string {
  const owned = pathSet(packet.owned_paths, "owned_paths").map((path) => [path, fileDigest(root, path)]);
  const forbidden = pathSet(packet.forbidden_paths, "forbidden_paths");
  const materialized = materialization(packet);
  const declared = packet.runtime_edges ?? [];
  if (!Array.isArray(declared)) {
    fail("runtime_edges must be an array");
  }
  assertCompleteManifestEdges(root, declared);
  const edges = declared
    .map((edge: RuntimeEdge) => sourceResolvesEdge(root, edge))
    .sort((a: ResolvedEdge, b: ResolvedEdge) => stable(a).localeCompare(stable(b)));
  const generated = canonicalGenerated(packet.generated_artifacts ?? []);
  if (!packet.test_manifest?.path || typeof packet.test_manifest.sha256 !== "string") {
    fail("test manifest is malformed");
  }
  return hash(
    stable({
      base_sha: packet.base_sha,
      owned,
      forbidden,
      materialized,
      edges,
      generated,
      test_manifest: [
        packet.test_manifest.path,
        packet.test_manifest.sha256,
        fileDigest(root, packet.test_manifest.path),
      ],
    })
  );
}
function validateGenerated(root: string, generated: unknown): void {
  for (const artifact of canonicalGenerated(generated ?? [])) {
    const generator = normalizePath(artifact.generator);
    safePath(root, generator);
    safePath(root, artifact.output);
    if (normalizePath(artifact.check_command[1] ?? "") !== generator) {
      fail(`generated artifact command does not directly execute its canonical generator: ${artifact.output}`);
    }
    const isolated = mkdtempSync(join(tmpdir(), "pdpp-generator-"));
    try {
      cpSync(root, isolated, {
        recursive: true,
        filter: (path) => !(path.split("/").includes(".git") || path.endsWith("/node_modules")),
      });
      const output = resolve(isolated, normalizePath(artifact.output));
      rmSync(output, { force: true });
      const result = spawnSync(artifact.check_command[0] ?? "", artifact.check_command.slice(1), {
        cwd: isolated,
        encoding: "utf8",
      });
      if (result.error || result.status !== 0 || !existsSync(output)) {
        fail(`canonical generator did not recreate output: ${artifact.output}`);
      }
      if (hash(readFileSync(output)) !== artifact.sha256 || fileDigest(root, artifact.output) !== artifact.sha256) {
        fail(`generated artifact bytes drifted: ${artifact.output}`);
      }
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  }
}
interface Lease {
  base_sha: string;
  closure_sha256: string;
  forbidden_paths: string[];
  generated_artifacts: GeneratedArtifact[];
  id: string;
  materialization: Materialization;
  nonce: string;
  owned_paths: string[];
  schema: string;
}
export function claimPacketLease(
  packet: Packet,
  { root, leaseDirectory }: { root: string; leaseDirectory: string }
): Lease {
  const closure = closureDigest(packet, root);
  mkdirSync(leaseDirectory, { recursive: true });
  const id = `${packet.base_sha}-${closure}`;
  const target = safeLeasePath(leaseDirectory, `${id}.json`);
  let fd: number;
  try {
    fd = openSync(target, "wx");
  } catch {
    fail(`lease already claimed: ${id}`);
  }
  const lease: Lease = {
    schema: LEASE_SCHEMA,
    id,
    nonce: randomUUID(),
    base_sha: packet.base_sha,
    closure_sha256: closure,
    owned_paths: pathSet(packet.owned_paths, "owned_paths"),
    forbidden_paths: pathSet(packet.forbidden_paths, "forbidden_paths"),
    materialization: materialization(packet),
    generated_artifacts: canonicalGenerated(packet.generated_artifacts ?? []),
  };
  writeFileSync(fd, `${JSON.stringify(lease)}\n`);
  return lease;
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the packet-validation invariant chain (schema, base SHA, materialization, ownership overlap, closure hash, generated artifacts, lease binding), carried over unchanged from the .mjs source; each check is an independently audited security boundary.
export function validatePacket(
  packet: Packet,
  { head, root, leaseDirectory }: { head: string; root: string; leaseDirectory: string }
): { base_sha: string; closure_sha256: string; lease: string } {
  if (packet.schema !== PACKET_SCHEMA) {
    fail("schema is invalid");
  }
  if (typeof packet.base_sha !== "string" || !COMMIT_SHA_PATTERN.test(packet.base_sha)) {
    fail("base SHA is invalid");
  }
  const materialized = materialization(packet);
  if (packet.base_sha !== head) {
    let parent: string;
    try {
      parent = execFileSync("git", ["rev-parse", `${head}^`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      fail(`base ${packet.base_sha} does not match ${head}`);
    }
    if (parent !== packet.base_sha) {
      fail(`base ${packet.base_sha} does not directly materialize ${head}`);
    }
    safePath(root, materialized.packet_path);
    const changed = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", packet.base_sha, head], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(normalizePath);
    const allowed = new Set([
      ...pathSet(packet.owned_paths, "owned_paths"),
      materialized.packet_path,
      ...materialized.retired_paths,
    ]);
    if (!changed.includes(materialized.packet_path) || changed.some((path) => !allowed.has(path))) {
      fail("direct child does not exclusively materialize this packet");
    }
  }
  const owned = pathSet(packet.owned_paths, "owned_paths");
  const forbidden = pathSet(packet.forbidden_paths, "forbidden_paths");
  for (const path of owned) {
    for (const blocked of forbidden) {
      if (overlaps(path, blocked)) {
        fail(`owned/forbidden paths overlap: ${path} / ${blocked}`);
      }
    }
  }
  for (const path of [...owned, ...forbidden]) {
    safePath(root, path);
  }
  if (
    !(packet.test_manifest?.path && packet.test_manifest?.sha256) ||
    fileDigest(root, packet.test_manifest.path) !== packet.test_manifest.sha256
  ) {
    fail("test manifest changed or is malformed");
  }
  const closure = closureDigest(packet, root);
  if (packet.closure_sha256 !== closure) {
    fail("content closure hash is stale");
  }
  validateGenerated(root, packet.generated_artifacts);
  if (!(packet.lease_receipt?.id && packet.lease_receipt?.nonce && leaseDirectory)) {
    fail("atomic lease receipt is required");
  }
  const lease: Lease = JSON.parse(
    readFileSync(safeLeasePath(leaseDirectory, `${packet.lease_receipt.id}.json`), "utf8")
  );
  if (
    lease.schema !== LEASE_SCHEMA ||
    lease.id !== packet.lease_receipt.id ||
    lease.base_sha !== packet.base_sha ||
    lease.closure_sha256 !== closure ||
    lease.nonce !== packet.lease_receipt.nonce ||
    stable(lease.owned_paths) !== stable(owned) ||
    stable(lease.forbidden_paths) !== stable(forbidden) ||
    stable(lease.materialization) !== stable(materialized) ||
    stable(lease.generated_artifacts) !== stable(canonicalGenerated(packet.generated_artifacts ?? []))
  ) {
    fail("atomic lease receipt does not bind this packet");
  }
  return { base_sha: packet.base_sha, closure_sha256: closure, lease: lease.id };
}
export function gitHead(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}
interface PacketArgs {
  "--lease-directory"?: string;
  mode?: string;
  packet?: string;
}
function parseArgs(argv: string[]): PacketArgs {
  const value: PacketArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!(arg && ["--claim", "--validate"].includes(arg)) || value.mode) {
      fail("use exactly one of --claim or --validate followed by PACKET");
    }
    const packet = argv[index + 1];
    if (!packet || packet.startsWith("--")) {
      fail(`${arg} requires PACKET`);
    }
    value.mode = arg;
    value.packet = packet;
    index += 1;
    while (index + 1 < argv.length) {
      const flag = argv[index + 1];
      if (flag !== "--lease-directory") {
        break;
      }
      const item = argv[index + 2];
      if (!item || item.startsWith("--") || value[flag]) {
        fail(`${flag} requires exactly one value`);
      }
      value[flag] = item;
      index += 2;
    }
  }
  return value;
}
function main() {
  const input = parseArgs(process.argv.slice(2));
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const packet: Packet = JSON.parse(readFileSync(safePath(root, input.packet ?? ""), "utf8"));
  if (input["--lease-directory"]) {
    fail("--lease-directory is not available from the production CLI");
  }
  const leaseDirectory = resolve(
    root,
    execFileSync("git", ["rev-parse", "--git-path", "test-accounting/leases"], { cwd: root, encoding: "utf8" }).trim()
  );
  if (input.mode === "--claim") {
    process.stdout.write(`${JSON.stringify(claimPacketLease(packet, { root, leaseDirectory }))}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(validatePacket(packet, { root, head: gitHead(root), leaseDirectory }))}\n`);
  }
}
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
