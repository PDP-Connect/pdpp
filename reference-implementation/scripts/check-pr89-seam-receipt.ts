// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CASE_DEFINITIONS,
  CASE_EVIDENCE_SCHEMA,
  CASE_IDS,
  CASE_OUTPUT_SCHEMA,
  type CaseDefinition,
  type CaseEvidence,
  type CaseId,
  type CaseOutput,
  canonicalJson,
  digest,
  exactSortedValues,
  FIXED_CLOCK,
  type Json,
  RECEIPT_ASSERTION_CASES,
  RECEIPT_COMMAND,
  RECEIPT_DECISION_CASES,
  RECEIPT_SCHEMA,
  RECEIPT_STATIC_PATHS,
} from "./pr89-seam-evidence-contract.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REFERENCE_ROOT = dirname(SCRIPT_DIR);
export const REPOSITORY_ROOT = dirname(REFERENCE_ROOT);
export const SEAM_ROOT = resolve(REFERENCE_ROOT, "test/seam-spike");
export const ARTIFACT_ROOT = resolve(SEAM_ROOT, "artifacts");
export const EVIDENCE_ROOT = resolve(ARTIFACT_ROOT, "evidence");
export const RECEIPT_PATH = resolve(ARTIFACT_ROOT, "pr89-receipt.json");

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_RESPONSE_KEYS = new Set([
  "access_token",
  "api_key",
  "authorization",
  "client_assertion",
  "client_secret",
  "code",
  "code_verifier",
  "cookie",
  "credentials",
  "id_token",
  "password",
  "refresh_token",
  "set-cookie",
  "token",
]);
const FORBIDDEN_RESPONSE_KEY_PARTS = new Set(["bearer", "cookie", "credentials", "password", "secret", "token"]);
const TOKEN_VALUE_PATTERN = /\b(?:rt|tok)_[A-Za-z0-9_-]{12,}\b/;
const DYNAMIC_LOCAL_PORT_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/;

interface ReceiptCase {
  case_output_digest: string;
  evidence_digest: string;
  fixtures_digest: string;
  implementation_inputs_digest: string;
  oracle_code: string;
  status: "pass";
  terminal_events_digest: string;
  test_file_digest: string;
}

interface Receipt {
  assertions: Record<string, true>;
  backend: "postgresql";
  cases: Record<CaseId, ReceiptCase>;
  clock: string;
  command: string;
  decisions: Record<string, "pass">;
  evidence_tree_digest: string;
  fixtures_digest: string;
  hardening: {
    code_reuse_revocation: "separately_reported";
    dpop: "not_demonstrated";
    keyless_recovery: "deferred";
    refresh_rotation: "pass";
    security_profile_floor: "deferred";
  };
  implementation_inputs_digest: string;
  relevant_file_tree_digest: string;
  response_envelopes_digest: string;
  schema: string;
  undecided_common_schemas: true;
}

function fail(message: string): never {
  throw new Error(`PR89 receipt: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(record).sort();
  const wanted = exactSortedValues(expected);
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    fail(`${path} keys must be exactly ${wanted.join(", ")}`);
  }
}

function requireDigest(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    fail(`${path} must be a sha256 digest`);
  }
}

function requireRepositoryPath(repositoryRoot: string, path: string): string {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    fail(`invalid repository-relative path: ${path}`);
  }
  const absolute = resolve(repositoryRoot, path);
  const pathFromRoot = relative(repositoryRoot, absolute);
  if (pathFromRoot.startsWith("..") || pathFromRoot === "") {
    fail(`path escapes repository: ${path}`);
  }
  if (!existsSync(absolute)) {
    fail(`required evidence input is missing: ${path}`);
  }
  return absolute;
}

export async function fileSetDigest(repositoryRoot: string, paths: Iterable<string>): Promise<string> {
  const uniquePaths = exactSortedValues(new Set(paths));
  const files = await Promise.all(
    uniquePaths.map(
      async (path) => [path, digest(await readFile(requireRepositoryPath(repositoryRoot, path)))] as const
    )
  );
  return digest(canonicalJson(files as unknown as Json));
}

function assertSafeResponseValue(value: Json, path = "response_envelopes"): void {
  if (typeof value === "string") {
    if (TOKEN_VALUE_PATTERN.test(value) || DYNAMIC_LOCAL_PORT_PATTERN.test(value)) {
      fail(`${path} contains a token or dynamic local origin`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertSafeResponseValue(entry, `${path}[${index}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const keyParts = normalizedKey.split("_").filter(Boolean);
      const secretBearingKey =
        FORBIDDEN_RESPONSE_KEYS.has(normalizedKey) ||
        keyParts.some((part) => FORBIDDEN_RESPONSE_KEY_PARTS.has(part)) ||
        (keyParts.includes("authorization") && keyParts.includes("header")) ||
        (keyParts.includes("api") && keyParts.includes("key")) ||
        (keyParts.includes("client") && keyParts.includes("assertion"));
      if (secretBearingKey) {
        fail(`${path} contains forbidden secret-bearing key '${key}'`);
      }
      assertSafeResponseValue(entry, `${path}.${key}`);
    }
  }
}

export function parseCaseOutput(value: unknown, caseId: CaseId, definition = CASE_DEFINITIONS[caseId]): CaseOutput {
  if (!isRecord(value)) {
    fail(`${caseId} output must be an object`);
  }
  requireExactKeys(value, ["case_id", "observations", "oracle_code", "response_envelopes", "schema"], caseId);
  if (value.schema !== CASE_OUTPUT_SCHEMA || value.case_id !== caseId || value.oracle_code !== definition.oracleCode) {
    fail(`${caseId} output identity does not match its case definition`);
  }
  if (!Array.isArray(value.observations) || value.observations.some((entry) => typeof entry !== "string")) {
    fail(`${caseId}.observations must be a string array`);
  }
  const observations = value.observations as string[];
  if (
    new Set(observations).size !== observations.length ||
    canonicalJson(observations) !== canonicalJson(exactSortedValues(definition.observations))
  ) {
    fail(`${caseId}.observations must be the exact sorted case observations`);
  }
  if (!Array.isArray(value.response_envelopes)) {
    fail(`${caseId}.response_envelopes must be an array`);
  }
  if (definition.responseEnvelopesRequired && value.response_envelopes.length === 0) {
    fail(`${caseId}.response_envelopes must contain executed response projections`);
  }
  assertSafeResponseValue(value.response_envelopes as Json[]);
  return value as unknown as CaseOutput;
}

function expectedCaseCommand(definition: CaseDefinition): string[] {
  return [
    "node",
    "--test",
    "--import",
    "tsx",
    "--test-reporter",
    "scripts/test-accounting/node-reporter.ts",
    definition.testFile,
  ];
}

function evidencePath(caseId: CaseId, evidenceRoot: string): string {
  return resolve(evidenceRoot, `${caseId}.json`);
}

async function readCanonicalJson(path: string, label: string): Promise<{ raw: string; value: unknown }> {
  if (!existsSync(path)) {
    fail(`${label} is missing: ${path}`);
  }
  const raw = (await readFile(path, "utf8")).trim();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail(`${label} is not valid JSON`);
  }
  if (canonicalJson(value as Json) !== raw) {
    fail(`${label} must use canonical lexicographic JSON key ordering`);
  }
  return { raw, value };
}

export async function readCaseEvidence({
  caseId,
  evidenceRoot = EVIDENCE_ROOT,
  repositoryRoot = REPOSITORY_ROOT,
}: {
  caseId: CaseId;
  evidenceRoot?: string;
  repositoryRoot?: string;
}): Promise<CaseEvidence> {
  const definition = CASE_DEFINITIONS[caseId];
  const { raw, value } = await readCanonicalJson(evidencePath(caseId, evidenceRoot), `${caseId} evidence`);
  if (!isRecord(value)) {
    fail(`${caseId} evidence must be an object`);
  }
  requireExactKeys(
    value,
    [
      "backend",
      "case_id",
      "case_output",
      "case_output_digest",
      "command",
      "fixtures_digest",
      "implementation_inputs_digest",
      "oracle_code",
      "schema",
      "status",
      "terminal_events",
      "terminal_events_digest",
      "test_file_digest",
    ],
    `${caseId} evidence`
  );
  if (
    value.schema !== CASE_EVIDENCE_SCHEMA ||
    value.backend !== "postgresql" ||
    value.case_id !== caseId ||
    value.oracle_code !== definition.oracleCode ||
    value.status !== "pass"
  ) {
    fail(`${caseId} evidence identity or status is invalid`);
  }
  if (canonicalJson(value.command as Json) !== canonicalJson(expectedCaseCommand(definition))) {
    fail(`${caseId} evidence command does not match the executed case definition`);
  }
  const output = parseCaseOutput(value.case_output, caseId, definition);
  requireDigest(value.case_output_digest, `${caseId}.case_output_digest`);
  if (value.case_output_digest !== digest(canonicalJson(output as unknown as Json))) {
    fail(`${caseId}.case_output_digest is stale`);
  }
  if (!Array.isArray(value.terminal_events) || value.terminal_events.length === 0) {
    fail(`${caseId}.terminal_events must be a nonempty array`);
  }
  const events = value.terminal_events.map((entry, index) => {
    if (!isRecord(entry)) {
      return fail(`${caseId}.terminal_events[${index}] must be an object`);
    }
    requireExactKeys(entry, ["name", "status"], `${caseId}.terminal_events[${index}]`);
    if (typeof entry.name !== "string" || entry.status !== "pass") {
      return fail(`${caseId}.terminal_events[${index}] is not a passing named test`);
    }
    return { name: entry.name, status: "pass" as const };
  });
  const eventNames = events.map(({ name }) => name);
  if (
    new Set(eventNames).size !== eventNames.length ||
    canonicalJson(eventNames) !== canonicalJson(exactSortedValues(eventNames))
  ) {
    fail(`${caseId}.terminal_events must have unique lexicographically sorted names`);
  }
  for (const requiredName of definition.requiredTestNames) {
    if (!eventNames.includes(requiredName)) {
      fail(`${caseId} did not execute required test: ${requiredName}`);
    }
  }
  requireDigest(value.terminal_events_digest, `${caseId}.terminal_events_digest`);
  if (value.terminal_events_digest !== digest(canonicalJson(events))) {
    fail(`${caseId}.terminal_events_digest is stale`);
  }
  const expectedTestDigest = await fileSetDigest(repositoryRoot, [definition.testFile]);
  requireDigest(value.test_file_digest, `${caseId}.test_file_digest`);
  if (value.test_file_digest !== expectedTestDigest) {
    fail(`${caseId}.test_file_digest is stale`);
  }
  const expectedImplementationDigest = await fileSetDigest(repositoryRoot, definition.implementationInputPaths);
  requireDigest(value.implementation_inputs_digest, `${caseId}.implementation_inputs_digest`);
  if (value.implementation_inputs_digest !== expectedImplementationDigest) {
    fail(`${caseId}.implementation_inputs_digest is stale`);
  }
  const expectedFixturesDigest = await fileSetDigest(repositoryRoot, definition.fixturePaths);
  requireDigest(value.fixtures_digest, `${caseId}.fixtures_digest`);
  if (value.fixtures_digest !== expectedFixturesDigest) {
    fail(`${caseId}.fixtures_digest is stale`);
  }
  rejectForbiddenMarkers(raw);
  return value as unknown as CaseEvidence;
}

function allCasePaths(selector: (definition: CaseDefinition) => readonly string[]): string[] {
  return CASE_IDS.flatMap((caseId) => selector(CASE_DEFINITIONS[caseId]));
}

function relevantPaths(): string[] {
  return exactSortedValues([
    ...RECEIPT_STATIC_PATHS,
    ...allCasePaths((definition) => definition.fixturePaths),
    ...allCasePaths((definition) => definition.implementationInputPaths),
    ...CASE_IDS.map((caseId) => CASE_DEFINITIONS[caseId].testFile),
  ]);
}

export async function buildReceipt({
  evidenceRoot = EVIDENCE_ROOT,
  repositoryRoot = REPOSITORY_ROOT,
}: {
  evidenceRoot?: string;
  repositoryRoot?: string;
} = {}): Promise<Receipt> {
  const evidenceEntries = await Promise.all(
    CASE_IDS.map(async (caseId) => [caseId, await readCaseEvidence({ caseId, evidenceRoot, repositoryRoot })] as const)
  );
  const evidence = Object.fromEntries(evidenceEntries) as Record<CaseId, CaseEvidence>;
  const cases = Object.fromEntries(
    CASE_IDS.map((caseId) => {
      const row = evidence[caseId];
      return [
        caseId,
        {
          case_output_digest: row.case_output_digest,
          evidence_digest: digest(canonicalJson(row as unknown as Json)),
          fixtures_digest: row.fixtures_digest,
          implementation_inputs_digest: row.implementation_inputs_digest,
          oracle_code: row.oracle_code,
          status: "pass" as const,
          terminal_events_digest: row.terminal_events_digest,
          test_file_digest: row.test_file_digest,
        },
      ];
    })
  ) as Record<CaseId, ReceiptCase>;
  const assertions = Object.fromEntries(
    Object.entries(RECEIPT_ASSERTION_CASES).map(([claim, requiredCases]) => {
      for (const caseId of requiredCases) {
        if (evidence[caseId].status !== "pass") {
          fail(`${claim} lacks passing ${caseId} evidence`);
        }
      }
      return [claim, true];
    })
  ) as Record<string, true>;
  const decisions = Object.fromEntries(
    Object.entries(RECEIPT_DECISION_CASES).map(([decision, requiredCases]) => {
      for (const caseId of requiredCases) {
        if (evidence[caseId].status !== "pass") {
          fail(`${decision} lacks passing ${caseId} evidence`);
        }
      }
      return [decision, "pass"];
    })
  ) as Record<string, "pass">;
  return {
    assertions,
    backend: "postgresql",
    cases,
    clock: FIXED_CLOCK,
    command: RECEIPT_COMMAND,
    decisions,
    evidence_tree_digest: digest(
      canonicalJson(Object.fromEntries(CASE_IDS.map((caseId) => [caseId, cases[caseId].evidence_digest])))
    ),
    fixtures_digest: await fileSetDigest(
      repositoryRoot,
      allCasePaths((definition) => definition.fixturePaths)
    ),
    hardening: {
      code_reuse_revocation: "separately_reported",
      dpop: "not_demonstrated",
      keyless_recovery: "deferred",
      refresh_rotation: "pass",
      security_profile_floor: "deferred",
    },
    implementation_inputs_digest: await fileSetDigest(
      repositoryRoot,
      allCasePaths((definition) => definition.implementationInputPaths)
    ),
    relevant_file_tree_digest: await fileSetDigest(repositoryRoot, relevantPaths()),
    response_envelopes_digest: digest(
      canonicalJson(
        Object.fromEntries(CASE_IDS.map((caseId) => [caseId, evidence[caseId].case_output.response_envelopes]))
      )
    ),
    schema: RECEIPT_SCHEMA,
    undecided_common_schemas: true,
  };
}

export async function generateReceipt({
  evidenceRoot = EVIDENCE_ROOT,
  receiptPath = RECEIPT_PATH,
  repositoryRoot = REPOSITORY_ROOT,
}: {
  evidenceRoot?: string;
  receiptPath?: string;
  repositoryRoot?: string;
} = {}): Promise<void> {
  const receipt = await buildReceipt({ evidenceRoot, repositoryRoot });
  await mkdir(dirname(receiptPath), { recursive: true });
  const temporaryPath = `${receiptPath}.tmp`;
  await writeFile(temporaryPath, `${canonicalJson(receipt as unknown as Json)}\n`, "utf8");
  await rename(temporaryPath, receiptPath);
}

export async function verifyReceipt({
  evidenceRoot = EVIDENCE_ROOT,
  receiptPath = RECEIPT_PATH,
  repositoryRoot = REPOSITORY_ROOT,
}: {
  evidenceRoot?: string;
  receiptPath?: string;
  repositoryRoot?: string;
} = {}): Promise<void> {
  const { raw, value } = await readCanonicalJson(receiptPath, "receipt");
  const expected = await buildReceipt({ evidenceRoot, repositoryRoot });
  const canonicalExpected = canonicalJson(expected as unknown as Json);
  if (raw !== canonicalExpected || canonicalJson(value as Json) !== canonicalExpected) {
    fail("receipt is stale or contains a claim not derived from current case evidence");
  }
  rejectForbiddenMarkers(raw);
}

function rejectForbiddenMarkers(serialized: string): void {
  if (serialized.includes('"duplicated_rights"') || serialized.includes('"rights_duplicated"')) {
    fail("receipt must not include duplicated rights markers");
  }
  if (serialized.includes('"in_process_fallback":true') || serialized.includes('"fallback":"in_process"')) {
    fail("receipt must not include in-process fallback markers");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyReceipt();
  process.stdout.write("PR89 receipt is current and derived from executed case evidence.\n");
}
