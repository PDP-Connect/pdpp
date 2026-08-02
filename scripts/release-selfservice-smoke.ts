#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Clean-environment release gate for the self-hosted owner journey.
//
// This is deliberately an orchestrator, not a second protocol harness. The
// release matrix proves package artifacts under its pinned Node/Docker rows;
// owner-journey proves the shipped command surface; hosted-mcp-oauth proves
// the in-process OAuth contract; and railway-mcp-query-smoke drives the same
// public HTTP surface against a fresh Compose deployment with deterministic,
// non-secret records.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  classifyAnonymousMcpStatus,
  type LiveSmokeResult,
  runLiveSmoke,
  SEED_RECORDS
} from "./railway-mcp-query-smoke.ts";
import { currentSnapshot, PACKAGE_NAMES, type Snapshot, sourceClosure } from "./release-package-matrix.ts";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILE = path.join(REPOSITORY_ROOT, "deploy/docker/docker-compose.yml");
const LANDING_FILE = path.join(REPOSITORY_ROOT, "apps/site/src/app/reference/page.tsx");
const MIN_NODE_VERSION = "22.14.0";
const RECEIPT_SCHEMA = "pdpp.release-selfservice-smoke/v1";
const DIGEST_IMAGE_PATTERN = /^[^\s@]+(?:\/[^\s@]+)*@sha256:[a-f0-9]{64}$/;
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const OWNER_REDIRECT_STATUSES = new Set([303, 307, 308]);
const COMPOSE_SERVICES = ["postgres", "reference", "web"] as const;

export interface LandingArtifactVerdict {
  findings: string[];
  ok: boolean;
}

/**
 * The public reference page is documentation, not a hosted PDPP node. A live
 * card that derives `/mcp` from the docs origin is therefore a broken release
 * handoff even when the operator console itself is healthy.
 */
export function inspectLandingArtifact(source: string): LandingArtifactVerdict {
  const findings: string[] = [];
  if (/<ConnectAgentCard\b[^>]*\bmode\s*=\s*(?:"live"|'live'|\{"live"\})/s.test(source)) {
    findings.push("public landing artifact renders a live MCP card");
  }
  if (/\bgetRequestOrigin\b|x-forwarded-host|x-forwarded-proto/.test(source)) {
    findings.push("public landing artifact derives its connection origin from the docs request");
  }
  if (/<ConnectAgentCard\b[^>]*providerUrl\s*=\s*\{providerUrl\}/s.test(source)) {
    findings.push("public landing artifact passes the docs origin into the MCP card");
  }
  return { findings, ok: findings.length === 0 };
}

export function assertLandingArtifact(source: string): void {
  const verdict = inspectLandingArtifact(source);
  assert.equal(
    verdict.ok,
    true,
    `landing artifact/origin failed: ${verdict.findings.join("; ")}. The public docs origin has no hosted /mcp route.`
  );
}

export function isPinnedImageReference(value: string | undefined): value is string {
  return typeof value === "string" && DIGEST_IMAGE_PATTERN.test(value.trim());
}

export function assertPinnedImageReferences(images: Record<string, string | undefined>): void {
  const missing = Object.entries(images)
    .filter(([, value]) => !isPinnedImageReference(value))
    .map(([name, value]) => `${name}=${value ?? "(missing)"}`);
  assert.equal(
    missing.length,
    0,
    `published Docker artifacts must use immutable @sha256 references: ${missing.join(", ")}`
  );
}

function parseVersion(value: string): [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  assert.ok(match, `invalid Node version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNodeVersionAtLeast(version: string, minimum = MIN_NODE_VERSION): boolean {
  const actual = parseVersion(version);
  const floor = parseVersion(minimum);
  return (
    actual[0] > floor[0] ||
    (actual[0] === floor[0] && (actual[1] > floor[1] || (actual[1] === floor[1] && actual[2] >= floor[2])))
  );
}

export function assertNodeVersion(version = process.version): void {
  assert.equal(
    isNodeVersionAtLeast(version),
    true,
    `Node ${MIN_NODE_VERSION}+ is required for the release smoke; received ${version}`
  );
}

export interface ComposeMetadataDocuments {
  authorizationServer: Record<string, unknown>;
  protectedResource: Record<string, unknown>;
}

export function metadataFindings(origin: string, documents: ComposeMetadataDocuments): string[] {
  const findings: string[] = [];
  const as = documents.authorizationServer;
  const rs = documents.protectedResource;
  if (as.issuer !== origin) {
    findings.push(`authorization-server issuer must be ${origin}, got ${String(as.issuer)}`);
  }
  if (rs.resource !== origin) {
    findings.push(`protected-resource resource must be ${origin}, got ${String(rs.resource)}`);
  }
  const servers = rs.authorization_servers;
  if (!Array.isArray(servers) || servers[0] !== origin) {
    findings.push(`protected-resource authorization_servers[0] must be ${origin}`);
  }
  for (const [name, value] of Object.entries({
    "authorization-server authorization_endpoint": as.authorization_endpoint,
    "authorization-server token_endpoint": as.token_endpoint
  })) {
    if (typeof value !== "string" || !value.startsWith(`${origin}/`)) {
      findings.push(`${name} must stay on the composed public origin`);
    }
  }
  const serialized = JSON.stringify({ as, rs });
  for (const internal of ["reference:", "web:", "http://reference", "http://web"]) {
    if (serialized.includes(internal)) {
      findings.push(`metadata leaked internal Docker URL fragment ${internal}`);
    }
  }
  return findings;
}

export function assertComposeMetadata(origin: string, documents: ComposeMetadataDocuments): void {
  const findings = metadataFindings(origin, documents);
  assert.equal(findings.length, 0, `metadata boundary failed: ${findings.join("; ")}`);
}

export interface OwnerLoginBoundary {
  location: string | null;
  origin?: string;
  status: number;
}

export function ownerLoginBoundaryFinding(boundary: OwnerLoginBoundary): string | null {
  if (!OWNER_REDIRECT_STATUSES.has(boundary.status)) {
    return `unauthenticated owner surface must redirect with 303/307/308, got ${boundary.status}`;
  }
  if (!boundary.location) {
    return "unauthenticated owner surface redirect did not include Location";
  }
  const expectedOrigin = boundary.origin ?? "http://owner-boundary.invalid";
  let expectedOriginUrl: URL;
  let location: URL;
  try {
    expectedOriginUrl = new URL(expectedOrigin);
    location = new URL(boundary.location, expectedOriginUrl);
  } catch {
    return `unauthenticated owner surface returned an invalid Location: ${boundary.location}`;
  }
  if (location.origin !== expectedOriginUrl.origin) {
    return `unauthenticated owner surface redirect escaped ${expectedOrigin}, got ${location.origin}`;
  }
  if (location.pathname !== "/owner/login") {
    return `unauthenticated owner surface must redirect to /owner/login, got ${location.pathname}`;
  }
  return null;
}

export interface ComposeServiceStatus {
  Health?: string;
  Service?: string;
  State?: string;
  health?: string;
  service?: string;
  state?: string;
}

export function parseComposePsJson(output: string): ComposeServiceStatus[] {
  const text = output.trim();
  if (!text) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as ComposeServiceStatus[]) : [parsed as ComposeServiceStatus];
  } catch {
    return text
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as ComposeServiceStatus;
        } catch {
          return {};
        }
      })
      .filter((entry) => Object.keys(entry).length > 0);
  }
}

function statusField(status: ComposeServiceStatus, field: "service" | "state" | "health"): string {
  const key = field[0]?.toUpperCase() + field.slice(1);
  return String(status[field] ?? status[key as keyof ComposeServiceStatus] ?? "").toLowerCase();
}

export function composeReadinessFindings(statuses: readonly ComposeServiceStatus[]): string[] {
  const findings: string[] = [];
  for (const service of COMPOSE_SERVICES) {
    const status = statuses.find((candidate) => statusField(candidate, "service") === service);
    if (!status) {
      findings.push(`Compose service ${service} is missing from ps output`);
      continue;
    }
    if (statusField(status, "state") !== "running") {
      findings.push(`Compose service ${service} is not running`);
    }
    if (service !== "web" && statusField(status, "health") !== "healthy") {
      findings.push(`Compose service ${service} is not healthy`);
    }
  }
  return findings;
}

export function assertComposeReadiness(statuses: readonly ComposeServiceStatus[]): void {
  const findings = composeReadinessFindings(statuses);
  assert.equal(findings.length, 0, `Compose readiness failed: ${findings.join("; ")}`);
}

export interface LiveBoundaryEvidence {
  anonymousMcpStatus: number;
  clientRefreshAfterRevokeStatus: number | null;
  clientRevokedMcpStatus: number | null;
  ownerBearerMcpStatus: number | null;
  queryReturnedKeys: readonly string[];
  expectedRecordKeys: readonly string[];
}

export function liveBoundaryFindings(evidence: LiveBoundaryEvidence): string[] {
  const findings: string[] = [];
  if (!classifyAnonymousMcpStatus(evidence.anonymousMcpStatus).refused || evidence.anonymousMcpStatus !== 401) {
    findings.push(`anonymous /mcp must return 401, got ${evidence.anonymousMcpStatus}`);
  }
  if (evidence.ownerBearerMcpStatus !== 403) {
    findings.push(`owner bearer /mcp must return 403, got ${evidence.ownerBearerMcpStatus}`);
  }
  if (evidence.clientRevokedMcpStatus !== 403) {
    findings.push(`revoked client bearer /mcp must return 403, got ${evidence.clientRevokedMcpStatus}`);
  }
  if (evidence.clientRefreshAfterRevokeStatus !== 400) {
    findings.push(`revoked refresh token must return 400, got ${evidence.clientRefreshAfterRevokeStatus}`);
  }
  const expected = [...evidence.expectedRecordKeys].sort();
  const actual = [...evidence.queryReturnedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    findings.push(`scoped MCP query returned ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`);
  }
  return findings;
}

export function assertLiveBoundaryEvidence(evidence: LiveBoundaryEvidence): void {
  const findings = liveBoundaryFindings(evidence);
  assert.equal(findings.length, 0, `auth/query boundary failed: ${findings.join("; ")}`);
}

export function assertConfiguredImages(output: string, expected: readonly string[]): void {
  const configured = new Set(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const missing = expected.filter((image) => !configured.has(image));
  assert.equal(missing.length, 0, `Compose resolved image references drifted: ${missing.join(", ")}`);
}

export interface PublishedPackageMetadata {
  dist?: { shasum?: string; tarball?: string };
  shasum?: string;
  version?: string;
}

export function parseNpmViewMetadata(output: string): PublishedPackageMetadata {
  const parsed: unknown = JSON.parse(output.trim());
  if (Array.isArray(parsed)) {
    return (parsed[0] ?? {}) as PublishedPackageMetadata;
  }
  return parsed as PublishedPackageMetadata;
}

export function assertPublishedPackageMetadata(
  packageName: string,
  requestedVersion: string,
  metadata: PublishedPackageMetadata
): void {
  assert.equal(
    metadata.version,
    requestedVersion,
    `${packageName}@${requestedVersion} is unavailable or resolved to ${String(metadata.version)}`
  );
  assert.ok(
    typeof metadata.dist?.tarball === "string" ||
      typeof metadata.dist?.shasum === "string" ||
      typeof metadata.shasum === "string",
    `${packageName}@${requestedVersion} did not return published tarball metadata`
  );
}

interface SmokeCommandReceipt {
  command: string[];
  cwd: string;
  exitCode: number;
  resultSha256: string;
}

interface SmokeCheckReceipt {
  detail: string;
  id: string;
  status: "failed" | "passed";
}

interface PublishedArtifactReceipt {
  name: string;
  sha1: string;
  sha256: string;
  tarball: string;
  version: string;
}

interface LiveReceiptEvidence {
  anonymousMcpStatus: number;
  clientRefreshAfterRevokeStatus: number;
  clientRevokedMcpStatus: number;
  expectedRecordKeys: string[];
  ownerBearerMcpStatus: number;
  queryReturnedKeys: string[];
  seedConnectorId: string;
  seedStream: string;
}

export interface SelfServiceReceipt {
  artifacts: {
    images: Record<string, string>;
    npm: PublishedArtifactReceipt[];
    releaseVersion: string;
    releaseMatrixReceiptSha256: string;
  };
  checks: SmokeCheckReceipt[];
  commands: SmokeCommandReceipt[];
  compose: {
    fileSha256: string;
    projectName: string;
  };
  createdAt: string;
  failure: string | null;
  headSha: string;
  live: LiveReceiptEvidence | null;
  receiptSha256: string;
  replayCommand: string;
  schema: string;
  sourceClosureSha256: string;
  status: "failed" | "passed";
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha1File(file: string): string {
  return createHash("sha1").update(readFileSync(file)).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }
  return value;
}

export function receiptDigest(receipt: Omit<SelfServiceReceipt, "receiptSha256"> | SelfServiceReceipt): string {
  const { receiptSha256: _ignored, ...body } = receipt as SelfServiceReceipt;
  return sha256(JSON.stringify(stableValue(body)));
}

export function assertReceiptIntegrity(receipt: SelfServiceReceipt): void {
  assert.equal(receipt.schema, RECEIPT_SCHEMA, "release smoke receipt schema drifted");
  assert.equal(receipt.receiptSha256, receiptDigest(receipt), "release smoke receipt mutated or digest mismatch");
  assert.equal(
    receipt.status,
    "passed",
    `release smoke receipt is ${receipt.status}: ${receipt.failure ?? "unknown failure"}`
  );
  assert.ok(receipt.headSha.length > 0, "receipt must bind a committed head SHA");
  assert.match(receipt.sourceClosureSha256, /^[a-f0-9]{64}$/, "receipt must bind source closure bytes");
  assertPinnedImageReferences(receipt.artifacts.images);
  assert.deepEqual(
    Object.keys(receipt.artifacts.images).sort(),
    ["postgres", "reference", "web"],
    "receipt Docker artifact set drifted"
  );
  assert.deepEqual(
    receipt.artifacts.npm.map((artifact) => artifact.name).sort(),
    [...PACKAGE_NAMES].sort(),
    "receipt npm package set drifted"
  );
  assert.ok(
    receipt.artifacts.npm.every((artifact) => artifact.version === receipt.artifacts.releaseVersion),
    "receipt npm artifacts must share the exact release version"
  );
  assert.ok(receipt.live, "receipt must carry live boundary evidence");
  assertLiveBoundaryEvidence(receipt.live);
  assert.ok(receipt.replayCommand.includes("release:selfservice-smoke"), "receipt must carry a replay command");
}

interface CommandRunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

class SmokeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeFailure";
  }
}

function tail(value: string): string {
  const lines = value.trim().split("\n");
  return lines.slice(Math.max(0, lines.length - 8)).join("\n");
}

function runCommand(
  commands: SmokeCommandReceipt[],
  command: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; recordedCommand?: string[]; recordedCwd?: string } = {}
): CommandRunResult {
  const result = spawnSync(command[0] ?? "", command.slice(1), {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = String(result.stdout ?? "");
  const spawnError = result.error instanceof Error ? result.error.message : result.error ? String(result.error) : "";
  const stderr = [String(result.stderr ?? ""), spawnError].filter(Boolean).join("\n");
  const exitCode = typeof result.status === "number" ? result.status : 1;
  commands.push({
    command: options.recordedCommand ?? command,
    cwd: options.recordedCwd ?? options.cwd ?? REPOSITORY_ROOT,
    exitCode,
    resultSha256: sha256(`${exitCode}\0${stdout}\0${stderr}`)
  });
  return { exitCode, stderr, stdout };
}

function requireCommand(
  commands: SmokeCommandReceipt[],
  command: string[],
  label: string,
  options = {}
): CommandRunResult {
  const result = runCommand(commands, command, options);
  if (result.exitCode !== 0) {
    const detail = tail(result.stderr || result.stdout);
    throw new SmokeFailure(`${label} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

async function waitForUrl(url: string, label: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new SmokeFailure(`timed out waiting for ${label} at ${url}: ${lastError}`);
}

async function fetchJson(origin: string, pathname: string): Promise<{ body: Record<string, unknown>; status: number }> {
  const response = await fetch(`${origin}${pathname}`, { redirect: "manual" });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  } catch {
    throw new SmokeFailure(`${pathname} returned non-JSON HTTP ${response.status}`);
  }
  if (response.status !== 200) {
    throw new SmokeFailure(`${pathname} returned HTTP ${response.status}`);
  }
  return { body, status: response.status };
}

function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function parsePackJson(output: string): { filename: string } {
  const start = output.indexOf("[");
  assert.ok(start >= 0, "npm pack did not emit JSON metadata");
  const parsed = JSON.parse(output.slice(start)) as Array<{ filename?: unknown }>;
  assert.equal(typeof parsed[0]?.filename, "string", "npm pack did not return a tarball filename");
  return { filename: parsed[0]?.filename as string };
}

function publishedArtifactChecks(
  commands: SmokeCommandReceipt[],
  version: string,
  artifactDir: string
): PublishedArtifactReceipt[] {
  const artifacts: PublishedArtifactReceipt[] = [];
  for (const name of PACKAGE_NAMES) {
    const specifier = `${name}@${version}`;
    const view = requireCommand(
      commands,
      ["npm", "view", specifier, "version", "dist.tarball", "dist.shasum", "--json"],
      `published artifact metadata for ${specifier}`,
      {
        recordedCommand: [
          "npm",
          "view",
          "<package>@<release-version>",
          "version",
          "dist.tarball",
          "dist.shasum",
          "--json"
        ]
      }
    );
    const metadata = parseNpmViewMetadata(view.stdout);
    assertPublishedPackageMetadata(name, version, metadata);
    const packed = requireCommand(
      commands,
      ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", artifactDir, specifier],
      `published artifact download for ${specifier}`,
      {
        recordedCommand: [
          "npm",
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          "<artifact-dir>",
          "<package>@<release-version>"
        ]
      }
    );
    const tarball = parsePackJson(packed.stdout).filename;
    const tarballPath = path.join(artifactDir, tarball);
    assert.ok(existsSync(tarballPath), `${specifier} tarball was not written by npm pack`);
    const sha1 = sha1File(tarballPath);
    const expectedSha1 = metadata.dist?.shasum ?? metadata.shasum;
    if (expectedSha1 && sha1 !== expectedSha1) {
      throw new SmokeFailure(`${specifier} tarball SHA-1 drifted: registry ${expectedSha1}, downloaded ${sha1}`);
    }
    artifacts.push({ name, sha1, sha256: sha256(readFileSync(tarballPath)), tarball, version });
  }
  return artifacts;
}

function releaseMatrixChecks(commands: SmokeCommandReceipt[], receiptPath: string): string {
  const policy = requireCommand(commands, ["pnpm", "release:policy-check"], "release policy check");
  if (!policy.stdout.includes("release policy OK")) {
    throw new SmokeFailure("release policy check did not emit its success marker");
  }
  requireCommand(
    commands,
    ["pnpm", "--silent", "release:matrix", "--", "--receipt", receiptPath],
    "pinned release matrix",
    { recordedCommand: ["pnpm", "--silent", "release:matrix", "--", "--receipt", "<release-matrix-receipt>"] }
  );
  requireCommand(
    commands,
    ["pnpm", "--silent", "release:matrix", "--", "--verify-receipt", receiptPath],
    "release matrix receipt replay",
    { recordedCommand: ["pnpm", "--silent", "release:matrix", "--", "--verify-receipt", "<release-matrix-receipt>"] }
  );
  assert.ok(existsSync(receiptPath), "release matrix did not emit its receipt");
  return sha256(readFileSync(receiptPath));
}

function parseLeadingJson(output: string): unknown {
  const start = output.search(/[\[{]/);
  assert.ok(start >= 0, "command did not emit JSON");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const character = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(output.slice(start, index + 1)) as unknown;
    }
  }
  throw new SmokeFailure("command emitted incomplete JSON");
}

function assertDistTagJson(
  output: string,
  version: string,
  expectedPackageNames: readonly string[] = PACKAGE_NAMES
): void {
  const parsed = parseLeadingJson(output) as {
    results?: Array<{ distTags?: { latest?: string }; packageName?: string; status?: string }>;
  };
  const results = parsed.results ?? [];
  assert.equal(
    results.length,
    expectedPackageNames.length,
    `dist-tag check returned ${results.length} package(s); expected ${expectedPackageNames.length}`
  );
  for (const packageName of expectedPackageNames) {
    const result = results.find((candidate) => candidate.packageName === packageName);
    assert.ok(result, `dist-tag check omitted ${packageName}`);
    if (result.status !== "ok" || result.distTags?.latest !== version) {
      throw new SmokeFailure(
        `published latest dist-tag for ${result.packageName ?? packageName} is not ${version}; run release:dist-tag-check --require-reachable`
      );
    }
  }
}

function makeComposeEnv({
  images,
  origin,
  ownerPassword,
  port,
  projectName
}: {
  images: Record<string, string>;
  origin: string;
  ownerPassword: string;
  port: number;
  projectName: string;
}): { envFile: string; tempRoot: string } {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pdpp-release-selfservice-"));
  const envFile = path.join(tempRoot, "compose.env");
  writeFileSync(
    envFile,
    [
      `COMPOSE_PROJECT_NAME=${projectName}`,
      `PDPP_REFERENCE_IMAGE=${images.reference}`,
      `PDPP_WEB_IMAGE=${images.web}`,
      `PDPP_POSTGRES_IMAGE=${images.postgres}`,
      `PDPP_REFERENCE_ORIGIN=${origin}`,
      `PDPP_WEB_PORT=${port}`,
      `PDPP_OWNER_PASSWORD=${ownerPassword}`,
      `PDPP_CREDENTIAL_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`,
      `PDPP_POSTGRES_PASSWORD=${randomBytes(24).toString("base64url")}`,
      "PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0",
      ""
    ].join("\n"),
    { mode: 0o600 }
  );
  chmodSync(envFile, 0o600);
  return { envFile, tempRoot };
}

async function runComposeJourney(
  commands: SmokeCommandReceipt[],
  images: Record<string, string>,
  snapshot: Snapshot,
  checks: SmokeCheckReceipt[]
): Promise<{ composeProjectName: string; composeFileSha256: string; live: LiveSmokeResult }> {
  assertPinnedImageReferences(images);
  const port = await pickPort();
  const origin = `http://127.0.0.1:${port}`;
  const projectName = `pdpp-release-smoke-${snapshot.headSha.slice(0, 12)}`;
  const ownerPassword = randomBytes(24).toString("base64url");
  const { envFile, tempRoot } = makeComposeEnv({ images, origin, ownerPassword, port, projectName });
  const composeArgs = ["docker", "compose", "--project-name", projectName, "--env-file", envFile, "-f", COMPOSE_FILE];
  const recordedComposeArgs = [
    "docker",
    "compose",
    "--project-name",
    "<project>",
    "--env-file",
    "<compose-env>",
    "-f",
    "deploy/docker/docker-compose.yml"
  ];
  let started = false;
  try {
    const config = requireCommand(commands, [...composeArgs, "config", "--quiet"], "Compose config", {
      recordedCommand: [...recordedComposeArgs, "config", "--quiet"]
    });
    void config;
    const imagesResult = requireCommand(commands, [...composeArgs, "config", "--images"], "Compose image resolution", {
      recordedCommand: [...recordedComposeArgs, "config", "--images"]
    });
    assertConfiguredImages(imagesResult.stdout, Object.values(images));
    started = true;
    requireCommand(commands, [...composeArgs, "down", "--volumes", "--remove-orphans"], "Compose pre-clean", {
      recordedCommand: [...recordedComposeArgs, "down", "--volumes", "--remove-orphans"]
    });
    requireCommand(commands, [...composeArgs, "pull", "--quiet"], "published Docker artifact pull", {
      recordedCommand: [...recordedComposeArgs, "pull", "--quiet"]
    });
    requireCommand(commands, [...composeArgs, "up", "-d", "--remove-orphans"], "Compose start", {
      recordedCommand: [...recordedComposeArgs, "up", "-d", "--remove-orphans"]
    });
    await waitForUrl(origin, "operator console");
    await waitForUrl(`${origin}/.well-known/oauth-authorization-server`, "authorization metadata");
    await waitForUrl(`${origin}/.well-known/oauth-protected-resource`, "protected-resource metadata");

    const ps = requireCommand(
      commands,
      [...composeArgs, "ps", "--all", "--format", "json"],
      "Compose readiness status",
      { recordedCommand: [...recordedComposeArgs, "ps", "--all", "--format", "json"] }
    );
    const statuses = parseComposePsJson(ps.stdout);
    assertComposeReadiness(statuses);
    checks.push({ id: "compose-readiness", status: "passed", detail: "postgres and reference healthy; web running" });

    const as = await fetchJson(origin, "/.well-known/oauth-authorization-server");
    const rs = await fetchJson(origin, "/.well-known/oauth-protected-resource");
    assertComposeMetadata(origin, { authorizationServer: as.body, protectedResource: rs.body });
    checks.push({ id: "metadata", status: "passed", detail: "AS/RS metadata is bound to the composed origin" });

    const ownerResponse = await fetch(origin, { redirect: "manual" });
    const ownerFinding = ownerLoginBoundaryFinding({
      origin,
      status: ownerResponse.status,
      location: ownerResponse.headers.get("location")
    });
    assert.equal(ownerFinding, null, ownerFinding ?? "owner login boundary failed");
    checks.push({
      id: "owner-login-boundary",
      status: "passed",
      detail: "unauthenticated owner surface redirects to /owner/login"
    });

    const live = await runLiveSmoke({
      logger: () => undefined,
      origin,
      ownerPassword,
      subjectId: "owner_release_smoke",
      seed: true
    });
    assertLiveBoundaryEvidence({
      anonymousMcpStatus: live.anonymousMcpStatus,
      clientRefreshAfterRevokeStatus: live.clientRefreshAfterRevokeStatus,
      clientRevokedMcpStatus: live.clientRevokedMcpStatus,
      ownerBearerMcpStatus: live.ownerBearerMcpStatus,
      queryReturnedKeys: live.queryReturnedKeys,
      expectedRecordKeys: SEED_RECORDS.map((record) => record.key)
    });
    checks.push({
      id: "connector-and-hosted-mcp",
      status: "passed",
      detail: "deterministic seed, PKCE OAuth, scoped query, owner-bearer rejection, and revocation passed"
    });
    return { composeFileSha256: sha256File(COMPOSE_FILE), composeProjectName: projectName, live };
  } catch (error) {
    if (started) {
      // Keep the receipt useful without echoing application logs that could
      // contain operator-provided values. The command result is hashed into
      // the receipt; Docker's own failure is already surfaced by the failed
      // command's stderr tail.
      runCommand(commands, [...composeArgs, "logs", "--no-color", "--tail", "80"], {
        recordedCommand: [...recordedComposeArgs, "logs", "--no-color", "--tail", "80"]
      });
    }
    throw error;
  } finally {
    try {
      if (started) {
        requireCommand(commands, [...composeArgs, "down", "--volumes", "--remove-orphans"], "Compose cleanup", {
          recordedCommand: [...recordedComposeArgs, "down", "--volumes", "--remove-orphans"]
        });
        const remaining = requireCommand(
          commands,
          [...composeArgs, "ps", "--all", "--quiet"],
          "Compose residue check",
          { recordedCommand: [...recordedComposeArgs, "ps", "--all", "--quiet"] }
        );
        if (remaining.stdout.trim()) {
          throw new SmokeFailure(`Compose cleanup left container residue: ${remaining.stdout.trim()}`);
        }
        checks.push({
          id: "cleanup",
          status: "passed",
          detail: "Compose volumes, containers, and orphans were removed"
        });
      }
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  }
}

function sha256File(file: string): string {
  return sha256(readFileSync(file));
}

function makeReplayCommand(version: string, images: Record<string, string>): string {
  return [
    "pnpm release:selfservice-smoke --",
    `--version ${version}`,
    `--reference-image ${images.reference}`,
    `--web-image ${images.web}`,
    `--postgres-image ${images.postgres}`,
    "--receipt /tmp/pdpp-release-selfservice-replay.json"
  ].join(" ");
}

function resolveOption(value: string | undefined, envName: string): string | undefined {
  return value ?? process.env[envName];
}

interface ParsedArgs {
  help: boolean;
  postgresImage?: string;
  receipt?: string;
  referenceImage?: string;
  verifyReceipt?: string;
  version?: string;
  webImage?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false };
  const nextValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new SmokeFailure(`${flag} requires a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--version") parsed.version = nextValue(index++, arg);
    else if (arg === "--reference-image") parsed.referenceImage = nextValue(index++, arg);
    else if (arg === "--web-image") parsed.webImage = nextValue(index++, arg);
    else if (arg === "--postgres-image") parsed.postgresImage = nextValue(index++, arg);
    else if (arg === "--receipt") parsed.receipt = nextValue(index++, arg);
    else if (arg === "--verify-receipt") parsed.verifyReceipt = nextValue(index++, arg);
    else throw new SmokeFailure(`unknown argument ${arg}`);
  }
  return parsed;
}

function receiptPathOutsideRepository(receiptPath: string): string {
  const absolute = path.resolve(receiptPath);
  const relative = path.relative(REPOSITORY_ROOT, absolute);
  assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`), "receipt path must be outside the worktree");
  return absolute;
}

function currentHeadSha(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  return result.status === 0 ? String(result.stdout).trim() : "unknown";
}

function writeReceipt(pathname: string, receipt: SelfServiceReceipt): void {
  const absolute = receiptPathOutsideRepository(pathname);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  chmodSync(absolute, 0o600);
}

function verifyReceipt(pathname: string): void {
  const receipt = JSON.parse(readFileSync(receiptPathOutsideRepository(pathname), "utf8")) as SelfServiceReceipt;
  assertReceiptIntegrity(receipt);
  const snapshot = currentSnapshot();
  assert.equal(receipt.headSha, snapshot.headSha, "receipt head SHA is stale; rerun the smoke on this commit");
  assert.equal(receipt.sourceClosureSha256, snapshot.sourceClosure.sha256, "receipt source closure drifted");
  process.stdout.write(`Release self-service smoke receipt is current: ${pathname}\n`);
}

const USAGE = `Usage: pnpm release:selfservice-smoke -- [options]

Required for a deterministic run:
  --version <published-version>       exact npm release version
  --reference-image <image@sha256>    published reference image digest
  --web-image <image@sha256>          published operator image digest
  --postgres-image <image@sha256>     pinned Compose database image digest

Options:
  --receipt <path>                    receipt outside the worktree (default: /tmp)
  --verify-receipt <path>             verify receipt SHA/source closure without running Docker
  -h, --help                          show this help

The deterministic gate uses a fixture source and no external credentials. Gmail plus
Claude Code is a separate live UAT and is never simulated by this command.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.verifyReceipt) {
    verifyReceipt(args.verifyReceipt);
    return;
  }

  const version = resolveOption(args.version, "PDPP_RELEASE_VERSION");
  const images = {
    postgres: resolveOption(args.postgresImage, "PDPP_POSTGRES_IMAGE"),
    reference: resolveOption(args.referenceImage, "PDPP_REFERENCE_IMAGE"),
    web: resolveOption(args.webImage, "PDPP_WEB_IMAGE")
  };
  const head = currentHeadSha();
  const receiptPath =
    args.receipt ?? process.env.PDPP_RELEASE_SMOKE_RECEIPT ?? `/tmp/pdpp-release-selfservice-${head.slice(0, 12)}.json`;
  const commands: SmokeCommandReceipt[] = [];
  const checks: SmokeCheckReceipt[] = [];
  let snapshot: Snapshot | null = null;
  let composeProjectName = "not-started";
  let composeFileSha256 = sha256File(COMPOSE_FILE);
  let npmArtifacts: PublishedArtifactReceipt[] = [];
  let releaseMatrixReceiptSha256 = "";
  let liveEvidence: LiveReceiptEvidence | null = null;
  let failure: string | null = null;
  try {
    assert.ok(
      version && RELEASE_VERSION_PATTERN.test(version),
      "published release version is required (set PDPP_RELEASE_VERSION or --version)"
    );
    assertPinnedImageReferences(images);
    assertNodeVersion();
    snapshot = currentSnapshot();
    checks.push({
      id: "revision-and-node",
      status: "passed",
      detail: `clean worktree at ${snapshot.headSha}; Node ${process.version}`
    });
    requireCommand(commands, ["docker", "version", "--format", "{{.Server.Version}}"], "Docker availability", {
      recordedCommand: ["docker", "version", "--format", "<server-version>"]
    });
    requireCommand(commands, ["docker", "compose", "version", "--short"], "Docker Compose availability", {
      recordedCommand: ["docker", "compose", "version", "--short"]
    });
    assertLandingArtifact(readFileSync(LANDING_FILE, "utf8"));
    checks.push({
      id: "landing-artifact",
      status: "passed",
      detail: "public landing does not advertise a live MCP origin"
    });

    const artifactDir = mkdtempSync(path.join(tmpdir(), "pdpp-release-npm-artifacts-"));
    try {
      npmArtifacts = publishedArtifactChecks(commands, version, artifactDir);
      const distTags = requireCommand(
        commands,
        ["pnpm", "release:dist-tag-check", "--", "--require-reachable", "--json"],
        "published npm dist-tag posture"
      );
      assertDistTagJson(distTags.stdout, version);
      checks.push({
        id: "published-artifacts",
        status: "passed",
        detail: `all ${PACKAGE_NAMES.length} npm packages resolve exact version ${version}`
      });
    } finally {
      rmSync(artifactDir, { force: true, recursive: true });
    }

    const matrixReceiptPath = path.join(
      path.dirname(receiptPathOutsideRepository(receiptPath)),
      `${path.basename(receiptPath)}.release-matrix.json`
    );
    releaseMatrixReceiptSha256 = releaseMatrixChecks(commands, matrixReceiptPath);
    checks.push({
      id: "release-matrix",
      status: "passed",
      detail: "pinned Node/runtime rows and receipt replay passed"
    });

    const ownerJourney = requireCommand(
      commands,
      ["pnpm", "owner-journey:acceptance", "--", "--json", "--no-report", "--clean-shell"],
      "owner-journey acceptance"
    );
    const ownerJourneyResult = JSON.parse(ownerJourney.stdout) as { ok?: boolean };
    assert.equal(ownerJourneyResult.ok, true, "owner-journey acceptance returned a failing result");
    checks.push({
      id: "owner-journey",
      status: "passed",
      detail: "source and clean-shell owner journey checks passed"
    });

    requireCommand(
      commands,
      ["node", "--test", "--import", "tsx", "reference-implementation/test/hosted-mcp-oauth.test.ts"],
      "hosted MCP OAuth tests",
      {
        recordedCommand: ["node", "--test", "--import", "tsx", "reference-implementation/test/hosted-mcp-oauth.test.ts"]
      }
    );
    checks.push({
      id: "hosted-oauth",
      status: "passed",
      detail: "in-process hosted OAuth/PKCE, metadata, scoped MCP, and owner boundary tests passed"
    });

    assert.ok(snapshot, "release smoke snapshot was not captured");
    const compose = await runComposeJourney(commands, images as Record<string, string>, snapshot, checks);
    composeProjectName = compose.composeProjectName;
    composeFileSha256 = compose.composeFileSha256;
    if (
      compose.live.clientRefreshAfterRevokeStatus === null ||
      compose.live.clientRevokedMcpStatus === null ||
      compose.live.ownerBearerMcpStatus === null
    ) {
      throw new SmokeFailure("live smoke omitted a required owner/revocation boundary status");
    }
    liveEvidence = {
      anonymousMcpStatus: compose.live.anonymousMcpStatus,
      clientRefreshAfterRevokeStatus: compose.live.clientRefreshAfterRevokeStatus,
      clientRevokedMcpStatus: compose.live.clientRevokedMcpStatus,
      expectedRecordKeys: compose.live.seed.recordKeys,
      ownerBearerMcpStatus: compose.live.ownerBearerMcpStatus,
      queryReturnedKeys: compose.live.queryReturnedKeys,
      seedConnectorId: compose.live.seed.connectorId,
      seedStream: compose.live.seed.stream
    };
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    checks.push({ id: "gate", status: "failed", detail: failure });
  }

  const effectiveHead = snapshot?.headSha ?? head;
  const effectiveClosure = snapshot?.sourceClosure.sha256 ?? sourceClosure(REPOSITORY_ROOT).sha256;
  const replayVersion = version ?? "<published-version>";
  const replayImages = Object.fromEntries(
    Object.entries(images).map(([key, value]) => [key, value ?? `<${key}-image@sha256:digest>`])
  );
  const receipt: SelfServiceReceipt = {
    artifacts: {
      images: replayImages,
      npm: npmArtifacts,
      releaseMatrixReceiptSha256,
      releaseVersion: replayVersion
    },
    checks,
    commands,
    compose: { fileSha256: composeFileSha256, projectName: composeProjectName },
    createdAt: new Date().toISOString(),
    failure,
    headSha: effectiveHead,
    live: liveEvidence,
    receiptSha256: "",
    replayCommand: makeReplayCommand(replayVersion, replayImages),
    schema: RECEIPT_SCHEMA,
    sourceClosureSha256: effectiveClosure,
    status: failure ? "failed" : "passed"
  };
  receipt.receiptSha256 = receiptDigest(receipt);
  writeReceipt(receiptPath, receipt);
  process.stdout.write(`Release self-service smoke receipt: ${receiptPath}\n`);
  if (failure) {
    throw new SmokeFailure(
      `${failure}\nReplay receipt verification: pnpm release:selfservice-smoke -- --verify-receipt ${receiptPath}`
    );
  }
  process.stdout.write("Release self-service smoke passed.\n");
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
