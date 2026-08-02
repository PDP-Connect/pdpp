#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Clean-environment release gate for the self-hosted owner journey.
//
// This is deliberately an orchestrator, not a second protocol harness. The
// release matrix proves package artifacts under its pinned Node/Docker rows;
// owner-journey proves the shipped command surface; hosted-mcp-oauth proves
// the in-process OAuth contract; and railway-mcp-query-smoke drives the same
// public HTTP surface against a fresh Compose deployment with a stable,
// non-secret fixture corpus.

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
  SEED_RECORDS,
} from "./railway-mcp-query-smoke.ts";
import { currentSnapshot, PACKAGE_NAMES, type Snapshot, sourceClosure } from "./release-package-matrix.ts";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILE = path.join(REPOSITORY_ROOT, "deploy/docker/docker-compose.yml");
const LANDING_FILE = path.join(REPOSITORY_ROOT, "apps/site/src/app/reference/page.tsx");
const MIN_NODE_VERSION = "22.14.0";
const RECEIPT_SCHEMA = "pdpp.release-selfservice-smoke/v2";
const DIGEST_IMAGE_PATTERN = /^[^\s@]+(?:\/[^\s@]+)*@sha256:[a-f0-9]{64}$/;
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const NODE_VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)/;
const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40,64}$/;
const IMAGE_REFERENCE_DIGEST_PATTERN = /@(sha256:[a-f0-9]{64})$/;
const FULL_IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const JSON_START_PATTERN = /\[|{/;
const LIVE_CARD_PATTERN = /<ConnectAgentCard\b[^>]*\bmode\s*=\s*(?:"live"|'live'|\{"live"\})/s;
const REQUEST_ORIGIN_PATTERN = /\bgetRequestOrigin\b|x-forwarded-host|x-forwarded-proto/;
const PROVIDER_ORIGIN_PATTERN = /<ConnectAgentCard\b[^>]*providerUrl\s*=\s*\{providerUrl\}/s;
const COMPOSE_PROJECT_NONCE_PATTERN = /^[a-f0-9]{12}$/;
const COMPOSE_PROJECT_HEAD_PATTERN = /^[a-f0-9]{12,64}$/;
const COMPOSE_PROJECT_NONCE_BYTES = 6;
const OCI_REVISION_LABEL = "org.opencontainers.image.revision";
const OCI_SOURCE_LABEL = "org.opencontainers.image.source";
const FIRST_PARTY_IMAGE_NAMES = new Set(["reference", "web"]);
const RECEIPT_SECRET_PATTERN =
  /(?:ownerPassword|credentialEncryptionKey|postgresPassword|accessToken|refreshToken|sessionCookie|codeVerifier|deviceCode)/;
const RECEIPT_SECRET_ARGUMENT_PATTERN =
  /(?:--owner-password|PDPP_(?:OWNER_PASSWORD|CREDENTIAL_ENCRYPTION_KEY|POSTGRES_PASSWORD)=)/;
const OWNER_REDIRECT_STATUSES = new Set([303, 307, 308]);
const COMPOSE_SERVICES = ["postgres", "reference", "web"] as const;
const STRING_COMPARE = (left: string, right: string): number => left.localeCompare(right);

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
  if (LIVE_CARD_PATTERN.test(source)) {
    findings.push("public landing artifact renders a live MCP card");
  }
  if (REQUEST_ORIGIN_PATTERN.test(source)) {
    findings.push("public landing artifact derives its connection origin from the docs request");
  }
  if (PROVIDER_ORIGIN_PATTERN.test(source)) {
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

export function assertPinnedImageReferences(
  images: Record<string, string | undefined>
): asserts images is Record<string, string> {
  const missing = Object.entries(images)
    .filter(([, value]) => !isPinnedImageReference(value))
    .map(([name, value]) => `${name}=${value ?? "(missing)"}`);
  assert.equal(
    missing.length,
    0,
    `published Docker artifacts must use immutable @sha256 references: ${missing.join(", ")}`
  );
}

export type ImageRevisionBinding = "matches-head" | "does-not-match-head" | "not-advertised";

export interface DockerImageInspection {
  labels: Record<string, string>;
  repoDigests: string[];
}

export interface ImageProvenance {
  requested: string;
  resolvedDigest: string;
  sourceRepository: string | null;
  sourceRevision: string | null;
  sourceRevisionBinding: ImageRevisionBinding;
}

function requestedImageDigest(reference: string): string {
  const match = IMAGE_REFERENCE_DIGEST_PATTERN.exec(reference);
  assert.ok(match, `image reference is missing an immutable digest: ${reference}`);
  const [, digest] = match;
  assert.ok(digest, `image reference is missing an immutable digest: ${reference}`);
  return digest;
}

export function parseDockerImageInspection(output: string): DockerImageInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch (error) {
    throw new SmokeFailure("docker image inspect returned invalid JSON", { cause: error });
  }
  const document = Array.isArray(parsed) ? parsed[0] : parsed;
  assert.ok(document && typeof document === "object", "docker image inspect returned no image document");
  const record = document as {
    Config?: { Labels?: unknown };
    RepoDigests?: unknown;
  };
  const repoDigests = Array.isArray(record.RepoDigests)
    ? record.RepoDigests.filter((value): value is string => typeof value === "string")
    : [];
  const labels =
    record.Config?.Labels && typeof record.Config.Labels === "object"
      ? Object.fromEntries(
          Object.entries(record.Config.Labels)
            .filter((entry) => typeof entry[1] === "string")
            .map(([key, value]) => [key, String(value)])
        )
      : {};
  return { labels, repoDigests };
}

export function imageProvenanceFindings(
  imageName: string,
  requested: string,
  headSha: string,
  inspection: DockerImageInspection
): string[] {
  const expectedDigest = requestedImageDigest(requested);
  const findings: string[] = [];
  if (!inspection.repoDigests.some((digest) => digest.endsWith(`@${expectedDigest}`))) {
    findings.push(`${imageName} resolved digest did not match requested ${expectedDigest}`);
  }
  const sourceRevision = inspection.labels[OCI_REVISION_LABEL];
  if (FIRST_PARTY_IMAGE_NAMES.has(imageName) && sourceRevision && sourceRevision !== headSha) {
    findings.push(`${imageName} image revision label ${sourceRevision} did not match source HEAD ${headSha}`);
  }
  return findings;
}

function imageRevisionBinding(sourceRevision: string | null, headSha: string): ImageRevisionBinding {
  if (!sourceRevision) {
    return "not-advertised";
  }
  return sourceRevision === headSha ? "matches-head" : "does-not-match-head";
}

function imageProvenance(
  imageName: string,
  requested: string,
  headSha: string,
  inspection: DockerImageInspection
): ImageProvenance {
  const findings = imageProvenanceFindings(imageName, requested, headSha, inspection);
  assert.equal(findings.length, 0, `Docker image provenance failed: ${findings.join("; ")}`);
  const sourceRevision = inspection.labels[OCI_REVISION_LABEL] ?? null;
  return {
    requested,
    resolvedDigest: requestedImageDigest(requested),
    sourceRepository: inspection.labels[OCI_SOURCE_LABEL] ?? null,
    sourceRevision,
    sourceRevisionBinding: imageRevisionBinding(sourceRevision, headSha),
  };
}

function resolveImageProvenance(
  commands: SmokeCommandReceipt[],
  images: Record<string, string>,
  headSha: string
): Record<string, ImageProvenance> {
  return Object.fromEntries(
    Object.entries(images).map(([imageName, requested]) => {
      const inspection = requireCommand(
        commands,
        ["docker", "image", "inspect", "--format", "{{json .}}", requested],
        `Docker image inspection for ${imageName}`,
        { recordedCommand: ["docker", "image", "inspect", "--format", "<json>", "<image>"] }
      );
      return [imageName, imageProvenance(imageName, requested, headSha, parseDockerImageInspection(inspection.stdout))];
    })
  );
}

export function makeComposeProjectName(
  headSha: string,
  nonce = randomBytes(COMPOSE_PROJECT_NONCE_BYTES).toString("hex")
): string {
  assert.match(headSha, COMPOSE_PROJECT_HEAD_PATTERN, "Compose project identity must include a committed source HEAD");
  assert.match(nonce, COMPOSE_PROJECT_NONCE_PATTERN, "Compose project nonce must be a bounded 12-character hex value");
  return `pdpp-release-smoke-${headSha.slice(0, 12)}-${nonce}`;
}

function parseVersion(value: string): [number, number, number] {
  const match = NODE_VERSION_PATTERN.exec(value.trim());
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
    "authorization-server token_endpoint": as.token_endpoint,
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
  health?: string;
  Service?: string;
  State?: string;
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
  expectedRecordKeys: readonly string[];
  ownerBearerMcpStatus: number | null;
  queryReturnedKeys: readonly string[];
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
  const expected = [...evidence.expectedRecordKeys].sort(STRING_COMPARE);
  const actual = [...evidence.queryReturnedKeys].sort(STRING_COMPARE);
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
    imageProvenance: Record<string, ImageProvenance>;
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
  failure: string | null;
  headSha: string;
  live: LiveReceiptEvidence | null;
  observedAt: string;
  outcomeSha256: string;
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

export function assertImageProvenance(
  headSha: string,
  images: Record<string, string>,
  provenance: Record<string, ImageProvenance>
): void {
  assert.deepEqual(
    Object.keys(provenance).sort(STRING_COMPARE),
    Object.keys(images).sort(STRING_COMPARE),
    "receipt Docker provenance set drifted"
  );
  for (const [imageName, requested] of Object.entries(images)) {
    const evidence = provenance[imageName];
    assert.ok(evidence, `receipt is missing Docker provenance for ${imageName}`);
    assert.equal(evidence.requested, requested, `${imageName} provenance requested reference drifted`);
    assert.equal(evidence.resolvedDigest, requestedImageDigest(requested), `${imageName} resolved digest drifted`);
    assert.match(evidence.resolvedDigest, FULL_IMAGE_DIGEST_PATTERN, `${imageName} resolved digest is invalid`);
    if (evidence.sourceRevision === null) {
      assert.equal(evidence.sourceRevisionBinding, "not-advertised", `${imageName} omitted provenance status`);
    } else {
      if (FIRST_PARTY_IMAGE_NAMES.has(imageName)) {
        assert.match(
          evidence.sourceRevision,
          SOURCE_REVISION_PATTERN,
          `${imageName} advertised an invalid OCI source revision`
        );
        assert.equal(
          evidence.sourceRevisionBinding,
          "matches-head",
          `${imageName} advertised an OCI source revision that does not match the receipt HEAD`
        );
      }
      assert.equal(
        evidence.sourceRevisionBinding,
        imageRevisionBinding(evidence.sourceRevision, headSha),
        `${imageName} source revision binding is dishonest`
      );
    }
  }
}

function receiptOutcomeValue(receipt: SelfServiceReceipt): unknown {
  const live = receipt.live
    ? {
        ...receipt.live,
        expectedRecordKeys: [...receipt.live.expectedRecordKeys].sort(STRING_COMPARE),
        queryReturnedKeys: [...receipt.live.queryReturnedKeys].sort(STRING_COMPARE),
      }
    : null;
  return {
    artifacts: {
      images: receipt.artifacts.images,
      imageProvenance: receipt.artifacts.imageProvenance,
      npm: [...receipt.artifacts.npm].sort((left, right) => STRING_COMPARE(left.name, right.name)),
      releaseVersion: receipt.artifacts.releaseVersion,
    },
    checks: receipt.checks,
    composeFileSha256: receipt.compose.fileSha256,
    failure: receipt.failure,
    headSha: receipt.headSha,
    live,
    sourceClosureSha256: receipt.sourceClosureSha256,
    status: receipt.status,
  };
}

export function receiptOutcomeDigest(receipt: SelfServiceReceipt): string {
  return sha256(JSON.stringify(stableValue(receiptOutcomeValue(receipt))));
}

export function assertReceiptSecretFree(receipt: SelfServiceReceipt): void {
  const serialized = JSON.stringify(receipt);
  assert.equal(RECEIPT_SECRET_PATTERN.test(serialized), false, "release smoke receipt contains credential material");
  assert.equal(
    receipt.commands.some(({ command }) => command.some((argument) => RECEIPT_SECRET_ARGUMENT_PATTERN.test(argument))),
    false,
    "release smoke receipt records a secret-bearing command"
  );
  assert.equal(receipt.replayCommand.includes("--owner-password"), false, "replay command contains owner credentials");
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
  assertReceiptSecretFree(receipt);
  assert.match(receipt.headSha, SOURCE_REVISION_PATTERN, "receipt must bind a committed head SHA");
  assert.match(receipt.sourceClosureSha256, HEX_DIGEST_PATTERN, "receipt must bind source closure bytes");
  assert.equal(receipt.outcomeSha256, receiptOutcomeDigest(receipt), "receipt stable outcome fields mutated");
  assertPinnedImageReferences(receipt.artifacts.images);
  assertImageProvenance(receipt.headSha, receipt.artifacts.images, receipt.artifacts.imageProvenance);
  assert.deepEqual(
    Object.keys(receipt.artifacts.images).sort(),
    ["postgres", "reference", "web"],
    "receipt Docker artifact set drifted"
  );
  assert.deepEqual(
    receipt.artifacts.npm.map((artifact) => artifact.name).sort(STRING_COMPARE),
    [...PACKAGE_NAMES].sort(STRING_COMPARE),
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
  resultSha256: string;
  stderr: string;
  stdout: string;
}

class SmokeFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SmokeFailure";
  }
}

function receiptFailureMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  return `${name} (detail sha256 ${sha256(message)})`;
}

function spawnErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error) {
    return String(error);
  }
  return "";
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
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = String(result.stdout ?? "");
  const spawnError = spawnErrorMessage(result.error);
  const stderr = [String(result.stderr ?? ""), spawnError].filter(Boolean).join("\n");
  const exitCode = typeof result.status === "number" ? result.status : 1;
  const resultSha256 = sha256(`${exitCode}\0${stdout}\0${stderr}`);
  commands.push({
    command: options.recordedCommand ?? command,
    cwd: options.recordedCwd ?? options.cwd ?? REPOSITORY_ROOT,
    exitCode,
    resultSha256,
  });
  return { exitCode, resultSha256, stderr, stdout };
}

function runCommandSafely(
  commands: SmokeCommandReceipt[],
  command: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; recordedCommand?: string[]; recordedCwd?: string } = {}
): CommandRunResult {
  try {
    return runCommand(commands, command, options);
  } catch (error) {
    const stderr = spawnErrorMessage(error);
    const exitCode = 1;
    const resultSha256 = sha256(`${exitCode}\0\0\0${stderr}`);
    commands.push({
      command: options.recordedCommand ?? command,
      cwd: options.recordedCwd ?? options.cwd ?? REPOSITORY_ROOT,
      exitCode,
      resultSha256,
    });
    return { exitCode, resultSha256, stderr, stdout: "" };
  }
}

function requireCommand(
  commands: SmokeCommandReceipt[],
  command: string[],
  label: string,
  options = {}
): CommandRunResult {
  const result = runCommand(commands, command, options);
  if (result.exitCode !== 0) {
    throw new SmokeFailure(`${label} failed (exit ${result.exitCode}; result ${result.resultSha256})`);
  }
  return result;
}

async function waitForUrlAttempt(url: string, label: string, deadline: number, lastError: string): Promise<void> {
  if (Date.now() >= deadline) {
    throw new SmokeFailure(`timed out waiting for ${label} at ${url}: ${lastError}`);
  }
  let nextError = lastError;
  try {
    const response = await fetch(url, { redirect: "manual" });
    if (response.status >= 200 && response.status < 500) {
      return;
    }
    nextError = `HTTP ${response.status}`;
  } catch (error) {
    nextError = spawnErrorMessage(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return waitForUrlAttempt(url, label, deadline, nextError);
}

function waitForUrl(url: string, label: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return waitForUrlAttempt(url, label, deadline, "no response");
}

async function fetchJson(origin: string, pathname: string): Promise<{ body: Record<string, unknown>; status: number }> {
  const response = await fetch(`${origin}${pathname}`, { redirect: "manual" });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  } catch (error) {
    throw new SmokeFailure(`${pathname} returned non-JSON HTTP ${response.status}`, { cause: error });
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
          "--json",
        ],
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
          "<package>@<release-version>",
        ],
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

interface JsonScanState {
  depth: number;
  escaped: boolean;
  inString: boolean;
}

interface JsonScanResult {
  complete: boolean;
  state: JsonScanState;
}

function advanceJsonScan(state: JsonScanState, character: string): JsonScanResult {
  if (state.inString) {
    if (state.escaped) {
      return { complete: false, state: { ...state, escaped: false } };
    }
    if (character === "\\") {
      return { complete: false, state: { ...state, escaped: true } };
    }
    if (character === '"') {
      return { complete: false, state: { ...state, inString: false } };
    }
    return { complete: false, state };
  }
  if (character === '"') {
    return { complete: false, state: { ...state, inString: true } };
  }
  if (character === "{" || character === "[") {
    return { complete: false, state: { ...state, depth: state.depth + 1 } };
  }
  if (character === "}" || character === "]") {
    const depth = state.depth - 1;
    return { complete: depth === 0, state: { ...state, depth } };
  }
  return { complete: false, state };
}

function findJsonDocumentEnd(output: string, start: number): number | null {
  let state: JsonScanState = { depth: 0, escaped: false, inString: false };
  for (let index = start; index < output.length; index += 1) {
    const { complete, state: nextState } = advanceJsonScan(state, output[index] ?? "");
    state = nextState;
    if (complete) {
      return index;
    }
  }
  return null;
}

function parseLeadingJson(output: string): unknown {
  const start = output.search(JSON_START_PATTERN);
  assert.ok(start >= 0, "command did not emit JSON");
  const end = findJsonDocumentEnd(output, start);
  assert.ok(end !== null, "command emitted incomplete JSON");
  return JSON.parse(output.slice(start, end + 1)) as unknown;
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
  projectName,
}: {
  images: Record<string, string>;
  origin: string;
  ownerPassword: string;
  port: number;
  projectName: string;
}): { envFile: string; tempRoot: string } {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pdpp-release-selfservice-"));
  const envFile = path.join(tempRoot, "compose.env");
  try {
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
        "",
      ].join("\n"),
      { mode: 0o600 }
    );
    chmodSync(envFile, 0o600);
    return { envFile, tempRoot };
  } catch (error) {
    try {
      rmSync(tempRoot, { force: true, recursive: true });
    } catch {
      // Preserve the original setup error; no Compose project exists yet.
    }
    throw new SmokeFailure("Compose environment setup failed", { cause: error });
  }
}

export interface ComposeCleanupCommands {
  containers: string[];
  down: string[];
  volumes: string[];
}

export function composeCleanupCommands(composeArgs: readonly string[], projectName: string): ComposeCleanupCommands {
  const compose = (args: readonly string[]): string[] => [...composeArgs, ...args];
  return {
    down: compose(["down", "--volumes", "--remove-orphans"]),
    containers: compose(["ps", "--all", "--quiet"]),
    volumes: ["docker", "volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${projectName}`],
  };
}

export function signalExitCode(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}

export function installSignalHandlers(onSignal: (signal: NodeJS.Signals) => void): () => void {
  const onInterrupt = (): void => onSignal("SIGINT");
  const onTerminate = (): void => onSignal("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  return () => {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  };
}

function createComposeCleanup(
  commands: SmokeCommandReceipt[],
  composeArgs: readonly string[],
  projectName: string,
  checks: SmokeCheckReceipt[]
): () => SmokeFailure | null {
  let complete = false;
  let cleanupFailure: SmokeFailure | null = null;
  return () => {
    if (complete) {
      return cleanupFailure;
    }
    complete = true;
    const cleanupCommands = composeCleanupCommands(composeArgs, projectName);
    const failures: string[] = [];
    const down = runCommandSafely(commands, cleanupCommands.down, {
      recordedCommand: [
        "docker",
        "compose",
        "--project-name",
        "<project>",
        "--env-file",
        "<compose-env>",
        "-f",
        "deploy/docker/docker-compose.yml",
        "down",
        "--volumes",
        "--remove-orphans",
      ],
    });
    if (down.exitCode !== 0) {
      failures.push(`Compose cleanup failed (exit ${down.exitCode})`);
    }

    const remainingContainers = runCommandSafely(commands, cleanupCommands.containers, {
      recordedCommand: [
        "docker",
        "compose",
        "--project-name",
        "<project>",
        "--env-file",
        "<compose-env>",
        "-f",
        "deploy/docker/docker-compose.yml",
        "ps",
        "--all",
        "--quiet",
      ],
    });
    if (remainingContainers.exitCode !== 0) {
      failures.push(`Compose residue check failed (exit ${remainingContainers.exitCode})`);
    } else if (remainingContainers.stdout.trim()) {
      failures.push(`Compose cleanup left container residue: ${remainingContainers.stdout.trim()}`);
    }

    const remainingVolumes = runCommandSafely(commands, cleanupCommands.volumes, {
      recordedCommand: ["docker", "volume", "ls", "--quiet", "--filter", "label=com.docker.compose.project=<project>"],
    });
    if (remainingVolumes.exitCode !== 0) {
      failures.push(`Compose volume residue check failed (exit ${remainingVolumes.exitCode})`);
    } else if (remainingVolumes.stdout.trim()) {
      failures.push(`Compose cleanup left volume residue: ${remainingVolumes.stdout.trim()}`);
    }

    if (failures.length > 0) {
      cleanupFailure = new SmokeFailure(failures.join("; "));
      return cleanupFailure;
    }
    checks.push({
      id: "cleanup",
      status: "passed",
      detail: "Compose project containers, volumes, and orphans were removed",
    });
    return null;
  };
}

function cleanupComposeSafely(cleanup: () => SmokeFailure | null): SmokeFailure | null {
  try {
    return cleanup();
  } catch (error) {
    return new SmokeFailure("Compose cleanup crashed before residue could be verified", { cause: error });
  }
}

function removeComposeTempRoot(tempRoot: string): SmokeFailure | null {
  try {
    rmSync(tempRoot, { force: true, recursive: true });
    return null;
  } catch (error) {
    return new SmokeFailure(`Compose temporary files could not be removed: ${tempRoot}`, { cause: error });
  }
}

interface ComposeJourneyContext {
  checks: SmokeCheckReceipt[];
  commands: SmokeCommandReceipt[];
  composeArgs: string[];
  images: Record<string, string>;
  origin: string;
  ownerPassword: string;
  projectName: string;
  recordedComposeArgs: string[];
  snapshot: Snapshot;
}

interface ComposeJourneyResult {
  composeFileSha256: string;
  composeProjectName: string;
  imageProvenance: Record<string, ImageProvenance>;
  live: LiveSmokeResult;
}

async function executeComposeJourney(context: ComposeJourneyContext): Promise<ComposeJourneyResult> {
  const { commands, composeArgs, checks, images, ownerPassword, origin, projectName, recordedComposeArgs, snapshot } =
    context;
  requireCommand(commands, [...composeArgs, "config", "--quiet"], "Compose config", {
    recordedCommand: [...recordedComposeArgs, "config", "--quiet"],
  });
  const imagesResult = requireCommand(commands, [...composeArgs, "config", "--images"], "Compose image resolution", {
    recordedCommand: [...recordedComposeArgs, "config", "--images"],
  });
  assertConfiguredImages(imagesResult.stdout, Object.values(images));
  requireCommand(commands, [...composeArgs, "pull", "--quiet"], "published Docker artifact pull", {
    recordedCommand: [...recordedComposeArgs, "pull", "--quiet"],
  });
  const resolvedImageProvenance = resolveImageProvenance(commands, images, snapshot.headSha);
  requireCommand(commands, [...composeArgs, "up", "-d", "--remove-orphans"], "Compose start", {
    recordedCommand: [...recordedComposeArgs, "up", "-d", "--remove-orphans"],
  });
  await waitForUrl(origin, "operator console");
  await waitForUrl(`${origin}/.well-known/oauth-authorization-server`, "authorization metadata");
  await waitForUrl(`${origin}/.well-known/oauth-protected-resource`, "protected-resource metadata");

  const ps = requireCommand(commands, [...composeArgs, "ps", "--all", "--format", "json"], "Compose readiness status", {
    recordedCommand: [...recordedComposeArgs, "ps", "--all", "--format", "json"],
  });
  assertComposeReadiness(parseComposePsJson(ps.stdout));
  checks.push({ id: "compose-readiness", status: "passed", detail: "postgres and reference healthy; web running" });

  const as = await fetchJson(origin, "/.well-known/oauth-authorization-server");
  const rs = await fetchJson(origin, "/.well-known/oauth-protected-resource");
  assertComposeMetadata(origin, { authorizationServer: as.body, protectedResource: rs.body });
  checks.push({ id: "metadata", status: "passed", detail: "AS/RS metadata is bound to the composed origin" });

  const ownerResponse = await fetch(origin, { redirect: "manual" });
  const ownerFinding = ownerLoginBoundaryFinding({
    origin,
    status: ownerResponse.status,
    location: ownerResponse.headers.get("location"),
  });
  assert.equal(ownerFinding, null, ownerFinding ?? "owner login boundary failed");
  checks.push({
    id: "owner-login-boundary",
    status: "passed",
    detail: "unauthenticated owner surface redirects to /owner/login",
  });

  const live = await runLiveSmoke({
    logger: () => undefined,
    origin,
    ownerPassword,
    subjectId: "owner_release_smoke",
    seed: true,
  });
  assertLiveBoundaryEvidence({
    anonymousMcpStatus: live.anonymousMcpStatus,
    clientRefreshAfterRevokeStatus: live.clientRefreshAfterRevokeStatus,
    clientRevokedMcpStatus: live.clientRevokedMcpStatus,
    ownerBearerMcpStatus: live.ownerBearerMcpStatus,
    queryReturnedKeys: live.queryReturnedKeys,
    expectedRecordKeys: SEED_RECORDS.map((record) => record.key),
  });
  checks.push({
    id: "connector-and-hosted-mcp",
    status: "passed",
    detail: "stable fixture corpus, per-run PKCE, scoped query, owner-bearer rejection, and revocation passed",
  });
  return {
    composeFileSha256: sha256File(COMPOSE_FILE),
    composeProjectName: projectName,
    imageProvenance: resolvedImageProvenance,
    live,
  };
}

async function runComposeJourney(
  commands: SmokeCommandReceipt[],
  images: Record<string, string>,
  snapshot: Snapshot,
  checks: SmokeCheckReceipt[]
): Promise<ComposeJourneyResult> {
  assertPinnedImageReferences(images);
  const port = await pickPort();
  const origin = `http://127.0.0.1:${port}`;
  const projectName = makeComposeProjectName(snapshot.headSha);
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
    "deploy/docker/docker-compose.yml",
  ];
  const context: ComposeJourneyContext = {
    commands,
    composeArgs,
    checks,
    images,
    ownerPassword,
    origin,
    projectName,
    recordedComposeArgs,
    snapshot,
  };
  const cleanup = createComposeCleanup(commands, composeArgs, projectName, checks);
  const removeSignalHandlers = installSignalHandlers((signal) => {
    const cleanupError = cleanupComposeSafely(cleanup);
    if (cleanupError) {
      process.stderr.write(`${cleanupError.message}\n`);
    }
    process.exitCode = signalExitCode(signal);
    process.exit(process.exitCode);
  });
  let result: ComposeJourneyResult | null = null;
  let operationError: unknown = null;
  try {
    result = await executeComposeJourney(context);
  } catch (error) {
    operationError = error;
    // Keep the receipt useful without echoing application logs that could
    // contain operator-provided values. The command result is hashed into
    // the receipt; Docker's own failure is represented by the failed command's
    // result hash.
    runCommandSafely(commands, [...composeArgs, "logs", "--no-color", "--tail", "80"], {
      recordedCommand: [...recordedComposeArgs, "logs", "--no-color", "--tail", "80"],
    });
  }
  const cleanupError = cleanupComposeSafely(cleanup);
  const tempRootError = removeComposeTempRoot(tempRoot);
  removeSignalHandlers();
  if (operationError) {
    throw operationError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
  if (tempRootError) {
    throw tempRootError;
  }
  assert.ok(result, "Compose journey completed without a result");
  return result;
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
    "--receipt /tmp/pdpp-release-selfservice-replay.json",
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

type ParsedStringField = Exclude<keyof ParsedArgs, "help">;

const VALUE_FLAGS: Record<string, ParsedStringField> = {
  "--postgres-image": "postgresImage",
  "--receipt": "receipt",
  "--reference-image": "referenceImage",
  "--verify-receipt": "verifyReceipt",
  "--version": "version",
  "--web-image": "webImage",
};

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false };
  const nextValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new SmokeFailure(`${flag} requires a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; ) {
    const arg = argv[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      index += 1;
      continue;
    }
    const field = VALUE_FLAGS[arg];
    if (field) {
      parsed[field] = nextValue(index, arg);
      index += 2;
      continue;
    }
    throw new SmokeFailure(`unknown argument ${arg}`);
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

Required for a replayable run:
  --version <published-version>       exact npm release version
  --reference-image <image@sha256>    published reference image digest
  --web-image <image@sha256>          published operator image digest
  --postgres-image <image@sha256>     pinned Compose database image digest

Options:
  --receipt <path>                    receipt outside the worktree (default: /tmp)
  --verify-receipt <path>             verify receipt SHA/source closure without running Docker
  -h, --help                          show this help

The gate replays a stable fixture source without storing external credentials. The
Compose nonce, loopback port, owner credentials, PKCE verifier, and observation
timestamp are intentionally per-run values. Gmail plus Claude Code is a separate
live UAT and is never simulated by this command.`;

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
    web: resolveOption(args.webImage, "PDPP_WEB_IMAGE"),
  };
  const head = currentHeadSha();
  const receiptPath =
    args.receipt ?? process.env.PDPP_RELEASE_SMOKE_RECEIPT ?? `/tmp/pdpp-release-selfservice-${head.slice(0, 12)}.json`;
  const commands: SmokeCommandReceipt[] = [];
  const checks: SmokeCheckReceipt[] = [];
  let snapshot: Snapshot | null = null;
  let composeProjectName = "not-started";
  let composeFileSha256 = sha256File(COMPOSE_FILE);
  let imageEvidence: Record<string, ImageProvenance> = {};
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
      detail: `clean worktree at ${snapshot.headSha}; Node ${process.version}`,
    });
    requireCommand(commands, ["docker", "version", "--format", "{{.Server.Version}}"], "Docker availability", {
      recordedCommand: ["docker", "version", "--format", "<server-version>"],
    });
    requireCommand(commands, ["docker", "compose", "version", "--short"], "Docker Compose availability", {
      recordedCommand: ["docker", "compose", "version", "--short"],
    });
    assertLandingArtifact(readFileSync(LANDING_FILE, "utf8"));
    checks.push({
      id: "landing-artifact",
      status: "passed",
      detail: "public landing does not advertise a live MCP origin",
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
        detail: `all ${PACKAGE_NAMES.length} npm packages resolve exact version ${version}`,
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
      detail: "pinned Node/runtime rows and receipt replay passed",
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
      detail: "source and clean-shell owner journey checks passed",
    });

    requireCommand(
      commands,
      ["node", "--test", "--import", "tsx", "reference-implementation/test/hosted-mcp-oauth.test.ts"],
      "hosted MCP OAuth tests",
      {
        recordedCommand: [
          "node",
          "--test",
          "--import",
          "tsx",
          "reference-implementation/test/hosted-mcp-oauth.test.ts",
        ],
      }
    );
    checks.push({
      id: "hosted-oauth",
      status: "passed",
      detail: "in-process hosted OAuth/PKCE, metadata, scoped MCP, and owner boundary tests passed",
    });

    assert.ok(snapshot, "release smoke snapshot was not captured");
    const compose = await runComposeJourney(commands, images, snapshot, checks);
    const {
      composeFileSha256: resolvedComposeFileSha256,
      composeProjectName: resolvedComposeProjectName,
      imageProvenance: resolvedImageProvenance,
      live,
    } = compose;
    composeProjectName = resolvedComposeProjectName;
    composeFileSha256 = resolvedComposeFileSha256;
    imageEvidence = resolvedImageProvenance;
    if (
      live.clientRefreshAfterRevokeStatus === null ||
      live.clientRevokedMcpStatus === null ||
      live.ownerBearerMcpStatus === null
    ) {
      throw new SmokeFailure("live smoke omitted a required owner/revocation boundary status");
    }
    liveEvidence = {
      anonymousMcpStatus: live.anonymousMcpStatus,
      clientRefreshAfterRevokeStatus: live.clientRefreshAfterRevokeStatus,
      clientRevokedMcpStatus: live.clientRevokedMcpStatus,
      expectedRecordKeys: live.seed.recordKeys,
      ownerBearerMcpStatus: live.ownerBearerMcpStatus,
      queryReturnedKeys: live.queryReturnedKeys,
      seedConnectorId: live.seed.connectorId,
      seedStream: live.seed.stream,
    };
  } catch (error) {
    failure = receiptFailureMessage(error);
    checks.push({ id: "gate", status: "failed", detail: failure });
  }

  const effectiveHead = snapshot ? snapshot.headSha : head;
  const effectiveClosure = snapshot ? snapshot.sourceClosure.sha256 : sourceClosure(REPOSITORY_ROOT).sha256;
  const replayVersion = version ?? "<published-version>";
  const replayImages = Object.fromEntries(
    Object.entries(images).map(([key, value]) => [key, value ?? `<${key}-image@sha256:digest>`])
  );
  const receipt: SelfServiceReceipt = {
    artifacts: {
      images: replayImages,
      imageProvenance: imageEvidence,
      npm: npmArtifacts,
      releaseMatrixReceiptSha256,
      releaseVersion: replayVersion,
    },
    checks,
    commands,
    compose: { fileSha256: composeFileSha256, projectName: composeProjectName },
    observedAt: new Date().toISOString(),
    failure,
    headSha: effectiveHead,
    live: liveEvidence,
    outcomeSha256: "",
    receiptSha256: "",
    replayCommand: makeReplayCommand(replayVersion, replayImages),
    schema: RECEIPT_SCHEMA,
    sourceClosureSha256: effectiveClosure,
    status: failure ? "failed" : "passed",
  };
  receipt.outcomeSha256 = receiptOutcomeDigest(receipt);
  receipt.receiptSha256 = receiptDigest(receipt);
  assertReceiptSecretFree(receipt);
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
