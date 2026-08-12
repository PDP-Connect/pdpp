// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REFERENCE_ROOT = dirname(SCRIPT_DIR);
export const SEAM_ROOT = resolve(REFERENCE_ROOT, "test/seam-spike");
export const RECEIPT_PATH = resolve(SEAM_ROOT, "artifacts/pr89-receipt.json");
const GENERATED_SEGMENTS = new Set(["artifacts"]);
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const CASE_ORACLES = {
  "case-1": "equal",
  "case-2": "partial_approval",
  "case-3": "context_resolved",
  "case-4": "response_only",
  "case-5": "races_and_refresh",
  "case-6": "authorization_state.unsupported_legacy_shape",
  "case-7": "gnap_map",
} as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Json)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function filesBelow(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  const childDirectories: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    const pathFromRoot = relative(root, absolute);
    if (pathFromRoot.split("/").some((segment) => GENERATED_SEGMENTS.has(segment))) {
      continue;
    }
    if (entry.isDirectory()) {
      childDirectories.push(absolute);
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  const nested = await Promise.all(childDirectories.map((child) => filesBelow(root, child)));
  return files.concat(nested.flat()).sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

export async function treeDigest(root = SEAM_ROOT, pathPrefix = ""): Promise<string> {
  const files = (await filesBelow(root)).filter((file) => relative(root, file).startsWith(pathPrefix));
  const data = files.map((file) => `${relative(root, file)}\0${readFileSync(file)}\0`).join("");
  return hash(data);
}

function requireRecord(value: Json, path: string): { [key: string]: Json } {
  if (!isObject(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function requireValue(object: { [key: string]: Json }, property: string, expected: Json): void {
  if (canonicalJson(object[property] as Json) !== canonicalJson(expected)) {
    throw new Error(`${property} must equal ${canonicalJson(expected)}`);
  }
}

function requireExactKeys(record: { [key: string]: Json }, expected: readonly string[], path: string): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(sortedExpected)) {
    throw new Error(`${path} keys must be exactly ${sortedExpected.join(", ")}`);
  }
}

function requireDigest(object: { [key: string]: Json }, property: string): void {
  if (typeof object[property] !== "string" || !SHA256_DIGEST.test(object[property])) {
    throw new Error(`${property} must be a sha256 digest`);
  }
}

export async function verifyReceipt(receiptPath = RECEIPT_PATH, seamRoot = SEAM_ROOT): Promise<void> {
  if (!existsSync(receiptPath)) {
    throw new Error(`PR89 receipt is missing: ${receiptPath}`);
  }
  const raw = readFileSync(receiptPath, "utf8").trim();
  const receipt = requireRecord(JSON.parse(raw) as Json, "receipt");
  if (raw !== canonicalJson(receipt)) {
    throw new Error("receipt must use canonical lexicographic JSON key ordering");
  }
  rejectForbiddenMarkers(canonicalJson(receipt));
  requireExactKeys(
    receipt,
    [
      "assertions",
      "backend",
      "cases",
      "clock",
      "command",
      "decisions",
      "fixtures_digest",
      "hardening",
      "relevant_file_tree_digest",
      "response_envelopes_digest",
      "schema",
      "undecided_common_schemas",
    ],
    "receipt"
  );
  requireValue(receipt, "schema", "pdpp.pr89.receipt.v1");
  requireValue(
    receipt,
    "command",
    "pnpm --filter pdpp-reference-implementation test:seam:pr89 -- --backend postgresql"
  );
  requireValue(receipt, "clock", "2026-08-11T12:00:00Z");
  requireValue(receipt, "backend", "postgresql");
  requireValue(receipt, "undecided_common_schemas", true);
  requireDigest(receipt, "fixtures_digest");
  requireDigest(receipt, "response_envelopes_digest");
  requireDigest(receipt, "relevant_file_tree_digest");
  if (receipt.relevant_file_tree_digest !== (await treeDigest(seamRoot))) {
    throw new Error("relevant_file_tree_digest is stale or includes generated receipt artifacts");
  }

  const cases = requireRecord(receipt.cases as Json, "cases");
  requireExactKeys(cases, Object.keys(CASE_ORACLES), "cases");
  for (const [caseId, oracle] of Object.entries(CASE_ORACLES)) {
    const row = requireRecord(cases[caseId] as Json, caseId);
    requireExactKeys(row, ["oracle_code", "status"], caseId);
    requireValue(row, "status", "pass");
    requireValue(row, "oracle_code", oracle);
  }

  const assertions = requireRecord(receipt.assertions as Json, "assertions");
  requireExactKeys(
    assertions,
    [
      "authenticated_http_introspection",
      "fresh_authorization_required",
      "no_in_process_fallback",
      "postgresql_races",
      "refresh_family_revoked_on_replay",
      "response_only_enforcement",
    ],
    "assertions"
  );
  for (const key of Object.keys(assertions)) {
    requireValue(assertions, key, true);
  }

  const decisions = requireRecord(receipt.decisions as Json, "decisions");
  requireExactKeys(
    decisions,
    ["approved_authorization_shape", "authorization_context_composition", "binding_separation"],
    "decisions"
  );
  for (const key of Object.keys(decisions)) {
    requireValue(decisions, key, "pass");
  }

  const hardening = requireRecord(receipt.hardening as Json, "hardening");
  requireExactKeys(
    hardening,
    ["code_reuse_revocation", "dpop", "keyless_recovery", "refresh_rotation", "security_profile_floor"],
    "hardening"
  );
  requireValue(hardening, "refresh_rotation", "pass");
  requireValue(hardening, "code_reuse_revocation", "separately_reported");
  requireValue(hardening, "dpop", "not_demonstrated");
  requireValue(hardening, "keyless_recovery", "deferred");
  requireValue(hardening, "security_profile_floor", "deferred");

  rejectForbiddenMarkers(canonicalJson(receipt));
}

function rejectForbiddenMarkers(serialized: string): void {
  if (serialized.includes('"duplicated_rights"') || serialized.includes('"rights_duplicated"')) {
    throw new Error("receipt must not include duplicated rights markers");
  }
  if (serialized.includes('"in_process_fallback":true') || serialized.includes('"fallback":"in_process"')) {
    throw new Error("receipt must not include in-process fallback markers");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyReceipt();
  process.stdout.write("PR89 receipt is current and valid.\n");
}
