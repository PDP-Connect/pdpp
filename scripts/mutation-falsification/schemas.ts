// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Versioned artifact schemas for the mutation-falsification evidence
 * program: intent packet, attempt receipt, triage receipt. See
 * openspec/changes/add-mutation-falsification-evidence/design.md Decision #3.
 *
 * Hand-rolled narrow validators (no schema-validation library), matching
 * the existing repo pattern in scripts/test-accounting/inventory.ts's
 * manual type guards for Manifest/Receipt/etc. Every validator fails
 * closed: malformed or missing-field input throws, it is never coerced or
 * defaulted.
 *
 * `killed`/`survived`/`inconclusive` are NEVER fields on AttemptReceipt —
 * those are computed projections (see projection.ts) derived from the
 * observations recorded here, never accepted as caller input.
 */

import { digestOf } from "./canonicalize.ts";

export const INTENT_SCHEMA = "mutation-falsification.intent/v1";
export const ATTEMPT_SCHEMA = "mutation-falsification.attempt/v1";
export const TRIAGE_SCHEMA = "mutation-falsification.triage/v1";

const HEX40_PATTERN = /^[0-9a-f]{40}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  throw new Error(`mutation-falsification schema: ${message}`);
}
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}
function requireStringOrNull(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  return requireString(value, label);
}
function requirePattern(value: unknown, pattern: RegExp, label: string): string {
  const str = requireString(value, label);
  if (!pattern.test(str)) {
    fail(`${label} has an invalid format: ${str}`);
  }
  return str;
}
function requireInteger(value: unknown, label: string, { min = 0 }: { min?: number } = {}): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    fail(`${label} must be an integer >= ${min}`);
  }
  return value;
}
function requireInstant(value: unknown, label: string): string {
  const str = requireString(value, label);
  if (Number.isNaN(new Date(str).valueOf()) || new Date(str).toISOString() !== str) {
    fail(`${label} must be an ISO-8601 instant`);
  }
  return str;
}
function requireArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  return value as T[];
}
function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────
// Intent packet
// ─────────────────────────────────────────────────────────────────────────

export interface RequestedBudget {
  /** Direct-output byte cap for the adapter's own structured evidence. */
  directOutputByteCap: number;
  /** Wall-clock milliseconds before the adapter-local deadline fires. */
  wallTimeMs: number;
}

export interface IntentPacket {
  /** Requested adapter identifier, e.g. "test-migration-oracle/v1" or "groupme-cursor-frontier/v1". */
  adapterId: string;
  adapterVersion: string;
  /** Base commit SHA the attempt must run against. */
  baseCommitSha: string;
  /**
   * Derived digest of every OTHER field in this packet — never
   * caller-supplied. Computed by `deriveIntentDigest`/`freezeIntentPacket`.
   */
  intentDigest: string;
  /**
   * Registered operator id, or null for adapters with no discrete operator
   * registry entry (the migration oracle: its mutation scenarios are all
   * internal to mutation-oracle.ts's own fixed lifecycle, not externally
   * selectable, so there is no separate operator identifier to name).
   */
  operatorId: string | null;
  requestedBudget: RequestedBudget;
  /** Requested risk id this attempt is meant to produce evidence about (freeform, adapter-scoped). */
  requestedRisk: string;
  schema: typeof INTENT_SCHEMA;
}

/** Computes the caller-independent digest of every IntentPacket field except `intentDigest` itself. */
export function deriveIntentDigest(packet: Omit<IntentPacket, "intentDigest">): string {
  return digestOf(packet);
}

/** Builds a complete, self-consistent IntentPacket, deriving `intentDigest` — callers never supply it directly. */
export function freezeIntentPacket(fields: Omit<IntentPacket, "intentDigest">): IntentPacket {
  return { ...fields, intentDigest: deriveIntentDigest(fields) };
}

export function validateIntentPacket(value: unknown): IntentPacket {
  const record = requireObject(value, "intent packet");
  if (record.schema !== INTENT_SCHEMA) {
    fail(`intent packet has unsupported schema: ${String(record.schema)}`);
  }
  const requestedRisk = requireString(record.requestedRisk, "intent packet requestedRisk");
  const adapterId = requireString(record.adapterId, "intent packet adapterId");
  const adapterVersion = requireString(record.adapterVersion, "intent packet adapterVersion");
  const operatorId = requireStringOrNull(record.operatorId ?? null, "intent packet operatorId");
  const baseCommitSha = requirePattern(record.baseCommitSha, HEX40_PATTERN, "intent packet baseCommitSha");
  const budget = requireObject(record.requestedBudget, "intent packet requestedBudget");
  const requestedBudget: RequestedBudget = {
    wallTimeMs: requireInteger(budget.wallTimeMs, "requestedBudget.wallTimeMs", { min: 1 }),
    directOutputByteCap: requireInteger(budget.directOutputByteCap, "requestedBudget.directOutputByteCap", {
      min: 1,
    }),
  };
  const intentDigest = requirePattern(record.intentDigest, HEX64_PATTERN, "intent packet intentDigest");
  const withoutDigest: Omit<IntentPacket, "intentDigest"> = {
    schema: INTENT_SCHEMA,
    requestedRisk,
    adapterId,
    adapterVersion,
    operatorId,
    baseCommitSha,
    requestedBudget,
  };
  if (deriveIntentDigest(withoutDigest) !== intentDigest) {
    fail("intent packet intentDigest does not match its own derived digest — caller-tampered or malformed");
  }
  return { ...withoutDigest, intentDigest };
}

// ─────────────────────────────────────────────────────────────────────────
// Attempt receipt
// ─────────────────────────────────────────────────────────────────────────

/** A single named axis observation: either a clean pass, or a specific named failure — never a boolean. */
export type AxisObservation =
  | { status: "ok" }
  | { detail: string; failure: string; status: "failed" }
  | { status: "not_applicable" }
  | { status: "not_run_focused_kill" };

export interface EvidenceArtifact {
  byteSize: number;
  relativePath: string;
  sha256: string;
}

export interface AttemptAxes {
  backstop: AxisObservation;
  baseline: AxisObservation;
  cleanup: AxisObservation;
  focused: AxisObservation;
  materialization: AxisObservation;
  reachability: AxisObservation | { status: "not_exercised" } | { status: "unknown" };
}

export interface AttemptReceipt {
  /** Random per-execution identifier — every run gets a distinct one, even for the same trialKey. */
  attemptId: string;
  attemptStatus: { exitCode: number | null; signal: string | null };
  /** Every named axis this attempt observed. No `killed`/`survived`/`inconclusive` field anywhere on this type. */
  axes: AttemptAxes;
  baseCommitSha: string;
  /** Bounded, digest-and-size-described evidence files retained in the evidence store. */
  evidenceArtifacts: EvidenceArtifact[];
  /** List of environment variable NAMES only — never values. */
  environmentProfile: string[];
  /**
   * The exact `intentDigest` of the IntentPacket this attempt was ISSUED
   * against (see `issueAttemptMarker`). `publishCompleteReceipt` requires
   * this to match the issued marker's own `intentDigest` byte-for-byte
   * before accepting the receipt — a completion can never be bound to any
   * intent other than the one it was actually issued under.
   */
  intentDigest: string;
  judgeIdentity: string;
  mutantIdentity: string | null;
  policyVersion: string;
  /** run_ids of any test-accounting authority receipts this attempt's backstop/baseline referenced. */
  referencedAccountingRunIds: string[];
  runtimeMs: number;
  schema: typeof ATTEMPT_SCHEMA;
  /** Deterministic key binding intent digest, repo tree, adapter version, policy version, and mutation identity. */
  trialKey: string;
}

function validateAxisObservation(value: unknown, label: string): AxisObservation {
  const record = requireObject(value, label);
  const status = record.status;
  if (status === "ok" || status === "not_applicable" || status === "not_run_focused_kill") {
    return { status };
  }
  if (status === "failed") {
    return {
      status: "failed",
      failure: requireString(record.failure, `${label}.failure`),
      detail: requireString(record.detail, `${label}.detail`),
    };
  }
  fail(`${label} has an unrecognized status: ${String(status)}`);
}
function validateReachability(value: unknown, label: string): AttemptAxes["reachability"] {
  const record = requireObject(value, label);
  if (record.status === "not_exercised" || record.status === "unknown") {
    return { status: record.status };
  }
  return validateAxisObservation(value, label);
}
function validateEvidenceArtifact(value: unknown, label: string): EvidenceArtifact {
  const record = requireObject(value, label);
  return {
    relativePath: requireString(record.relativePath, `${label}.relativePath`),
    byteSize: requireInteger(record.byteSize, `${label}.byteSize`, { min: 0 }),
    sha256: requirePattern(record.sha256, HEX64_PATTERN, `${label}.sha256`),
  };
}

export function validateAttemptReceipt(value: unknown): AttemptReceipt {
  const record = requireObject(value, "attempt receipt");
  if (record.schema !== ATTEMPT_SCHEMA) {
    fail(`attempt receipt has unsupported schema: ${String(record.schema)}`);
  }
  if ("killed" in record || "survived" in record || "inconclusive" in record) {
    fail("attempt receipt must not carry a projection field — projections are computed, never stored as input");
  }
  const attemptId = requirePattern(record.attemptId, UUID_PATTERN, "attempt receipt attemptId");
  const trialKey = requirePattern(record.trialKey, HEX64_PATTERN, "attempt receipt trialKey");
  const intentDigest = requirePattern(record.intentDigest, HEX64_PATTERN, "attempt receipt intentDigest");
  const policyVersion = requireString(record.policyVersion, "attempt receipt policyVersion");
  const baseCommitSha = requirePattern(record.baseCommitSha, HEX40_PATTERN, "attempt receipt baseCommitSha");
  const mutantIdentity =
    record.mutantIdentity === null ? null : requireString(record.mutantIdentity, "attempt receipt mutantIdentity");
  const judgeIdentity = requireString(record.judgeIdentity, "attempt receipt judgeIdentity");
  const environmentProfile = requireArray<unknown>(record.environmentProfile, "attempt receipt environmentProfile").map(
    (name, index) => requireString(name, `attempt receipt environmentProfile[${index}]`)
  );
  const evidenceArtifacts = requireArray<unknown>(record.evidenceArtifacts, "attempt receipt evidenceArtifacts").map(
    (artifact, index) => validateEvidenceArtifact(artifact, `attempt receipt evidenceArtifacts[${index}]`)
  );
  const axesRecord = requireObject(record.axes, "attempt receipt axes");
  const axes: AttemptAxes = {
    baseline: validateAxisObservation(axesRecord.baseline, "axes.baseline"),
    materialization: validateAxisObservation(axesRecord.materialization, "axes.materialization"),
    focused: validateAxisObservation(axesRecord.focused, "axes.focused"),
    backstop: validateAxisObservation(axesRecord.backstop, "axes.backstop"),
    reachability: validateReachability(axesRecord.reachability, "axes.reachability"),
    cleanup: validateAxisObservation(axesRecord.cleanup, "axes.cleanup"),
  };
  const runtimeMs = requireInteger(record.runtimeMs, "attempt receipt runtimeMs", { min: 0 });
  const attemptStatusRecord = requireObject(record.attemptStatus, "attempt receipt attemptStatus");
  const exitCode = attemptStatusRecord.exitCode;
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) {
    fail("attempt receipt attemptStatus.exitCode must be an integer or null");
  }
  const signal = attemptStatusRecord.signal;
  if (signal !== null && typeof signal !== "string") {
    fail("attempt receipt attemptStatus.signal must be a string or null");
  }
  const referencedAccountingRunIds = requireArray<unknown>(
    record.referencedAccountingRunIds,
    "attempt receipt referencedAccountingRunIds"
  ).map((id, index) => requireString(id, `attempt receipt referencedAccountingRunIds[${index}]`));

  return {
    schema: ATTEMPT_SCHEMA,
    attemptId,
    trialKey,
    intentDigest,
    policyVersion,
    baseCommitSha,
    mutantIdentity,
    judgeIdentity,
    environmentProfile,
    evidenceArtifacts,
    axes,
    runtimeMs,
    attemptStatus: { exitCode: exitCode as number | null, signal: signal as string | null },
    referencedAccountingRunIds,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Triage receipt
// ─────────────────────────────────────────────────────────────────────────

export type TriageDisposition = "actionable" | "likely_equivalent" | "uninteresting" | "deferred" | "invalid_fault";
const TRIAGE_DISPOSITIONS = new Set<TriageDisposition>([
  "actionable",
  "likely_equivalent",
  "uninteresting",
  "deferred",
  "invalid_fault",
]);

export interface TriageReceipt {
  /** Digest reference binding this triage to exactly one attempt receipt (digestOf the AttemptReceipt). */
  attemptDigest: string;
  disposition: TriageDisposition;
  evidenceText: string;
  reasonText: string;
  /**
   * Freeform reviewer-claimed identity. Explicitly NOT authenticated: version
   * one has no signer, no login, no platform attestation binding this string
   * to any real reviewer — it is a claim, recorded as a claim.
   */
  reviewerClaim: string;
  schema: typeof TRIAGE_SCHEMA;
  timestamp: string;
}

export function validateTriageReceipt(value: unknown): TriageReceipt {
  const record = requireObject(value, "triage receipt");
  if (record.schema !== TRIAGE_SCHEMA) {
    fail(`triage receipt has unsupported schema: ${String(record.schema)}`);
  }
  const attemptDigest = requirePattern(record.attemptDigest, HEX64_PATTERN, "triage receipt attemptDigest");
  const reviewerClaim = requireString(record.reviewerClaim, "triage receipt reviewerClaim");
  const disposition = record.disposition;
  if (typeof disposition !== "string" || !TRIAGE_DISPOSITIONS.has(disposition as TriageDisposition)) {
    fail(`triage receipt has an invalid disposition: ${String(disposition)}`);
  }
  const evidenceText = requireString(record.evidenceText, "triage receipt evidenceText");
  const reasonText = requireString(record.reasonText, "triage receipt reasonText");
  const timestamp = requireInstant(record.timestamp, "triage receipt timestamp");
  return {
    schema: TRIAGE_SCHEMA,
    attemptDigest,
    reviewerClaim,
    disposition: disposition as TriageDisposition,
    evidenceText,
    reasonText,
    timestamp,
  };
}
