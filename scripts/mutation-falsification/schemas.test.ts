// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  ATTEMPT_SCHEMA,
  freezeIntentPacket,
  INTENT_SCHEMA,
  TRIAGE_SCHEMA,
  validateAttemptReceipt,
  validateIntentPacket,
  validateTriageReceipt,
} from "./schemas.ts";

const SAMPLE_BASE_SHA = "a".repeat(40);
const SAMPLE_SHA256 = "b".repeat(64);

function sampleIntentFields() {
  return {
    schema: INTENT_SCHEMA as typeof INTENT_SCHEMA,
    requestedRisk: "groupme-page-ceiling",
    adapterId: "groupme-cursor-frontier/v1",
    adapterVersion: "1",
    operatorId: "groupme-page-ceiling-v1",
    baseCommitSha: SAMPLE_BASE_SHA,
    requestedBudget: { wallTimeMs: 60_000, directOutputByteCap: 1_000_000 },
  };
}

// ── IntentPacket ────────────────────────────────────────────────────────

test("validateIntentPacket: accepts a frozen packet with a correctly derived digest", () => {
  const packet = freezeIntentPacket(sampleIntentFields());
  const validated = validateIntentPacket(packet);
  assert.equal(validated.intentDigest, packet.intentDigest);
});

test("validateIntentPacket: accepts operatorId: null (e.g. migration-oracle has no operator registry)", () => {
  const fields = { ...sampleIntentFields(), operatorId: null };
  const packet = freezeIntentPacket(fields);
  assert.equal(validateIntentPacket(packet).operatorId, null);
});

test("validateIntentPacket: rejects a caller-supplied intentDigest that does not match the derived digest", () => {
  const packet = freezeIntentPacket(sampleIntentFields());
  const tampered = { ...packet, intentDigest: SAMPLE_SHA256 };
  assert.throws(() => validateIntentPacket(tampered));
});

test("validateIntentPacket: rejects a missing requestedRisk field", () => {
  const packet = freezeIntentPacket(sampleIntentFields()) as unknown as Record<string, unknown>;
  const { requestedRisk: _drop, ...rest } = packet;
  assert.throws(() => validateIntentPacket(rest));
});

test("validateIntentPacket: rejects a wrong schema string", () => {
  const packet = freezeIntentPacket(sampleIntentFields());
  assert.throws(() => validateIntentPacket({ ...packet, schema: "mutation-falsification.intent/v0" }));
});

test("validateIntentPacket: rejects a wrong-typed baseCommitSha", () => {
  const packet = freezeIntentPacket(sampleIntentFields());
  assert.throws(() => validateIntentPacket({ ...packet, baseCommitSha: 12345 }));
});

// ── AttemptReceipt ───────────────────────────────────────────────────────

function sampleAttemptReceipt() {
  return {
    schema: ATTEMPT_SCHEMA,
    attemptId: randomUUID(),
    trialKey: SAMPLE_SHA256,
    policyVersion: "v1",
    baseCommitSha: SAMPLE_BASE_SHA,
    mutantIdentity: "b".repeat(40),
    judgeIdentity: "c".repeat(40),
    environmentProfile: ["HOME", "PATH", "NODE_ENV"],
    evidenceArtifacts: [{ relativePath: "focused.log", byteSize: 128, sha256: SAMPLE_SHA256 }],
    axes: {
      baseline: { status: "ok" },
      materialization: { status: "ok" },
      focused: { status: "failed", failure: "assertion_failure", detail: "outcome.failed !== true" },
      backstop: { status: "not_run_focused_kill" },
      reachability: { status: "unknown" },
      cleanup: { status: "ok" },
    },
    runtimeMs: 4200,
    attemptStatus: { exitCode: 0, signal: null },
    referencedAccountingRunIds: [],
  };
}

test("validateAttemptReceipt: accepts a well-formed receipt", () => {
  const receipt = sampleAttemptReceipt();
  const validated = validateAttemptReceipt(receipt);
  assert.equal(validated.attemptId, receipt.attemptId);
  assert.equal(validated.axes.focused.status, "failed");
});

test("validateAttemptReceipt: rejects a receipt carrying a killed/survived/inconclusive field", () => {
  const receipt = { ...sampleAttemptReceipt(), killed: true } as Record<string, unknown>;
  assert.throws(() => validateAttemptReceipt(receipt));
});

test("validateAttemptReceipt: rejects a missing axes object", () => {
  const receipt = sampleAttemptReceipt() as Record<string, unknown>;
  const { axes: _drop, ...rest } = receipt;
  assert.throws(() => validateAttemptReceipt(rest));
});

test("validateAttemptReceipt: rejects a malformed attemptId (not a UUID)", () => {
  assert.throws(() => validateAttemptReceipt({ ...sampleAttemptReceipt(), attemptId: "not-a-uuid" }));
});

test("validateAttemptReceipt: rejects an evidence artifact missing sha256", () => {
  const receipt = sampleAttemptReceipt();
  receipt.evidenceArtifacts = [{ relativePath: "x.log", byteSize: 1 } as (typeof receipt.evidenceArtifacts)[number]];
  assert.throws(() => validateAttemptReceipt(receipt));
});

test("validateAttemptReceipt: accepts reachability status 'not_exercised'", () => {
  const receipt = sampleAttemptReceipt();
  receipt.axes.reachability = { status: "not_exercised" };
  const validated = validateAttemptReceipt(receipt);
  assert.equal(validated.axes.reachability.status, "not_exercised");
});

test("validateAttemptReceipt: rejects an axis with an unrecognized status", () => {
  const receipt = sampleAttemptReceipt();
  receipt.axes.baseline = { status: "maybe" } as (typeof receipt.axes)["baseline"];
  assert.throws(() => validateAttemptReceipt(receipt));
});

// ── TriageReceipt ────────────────────────────────────────────────────────

function sampleTriageReceipt() {
  return {
    schema: TRIAGE_SCHEMA,
    attemptDigest: SAMPLE_SHA256,
    reviewerClaim: "tim (unauthenticated claim)",
    disposition: "actionable",
    evidenceText: "focused check failed on the mutation-attributable assertion",
    reasonText: "matches the expected fault signature",
    timestamp: new Date().toISOString(),
  };
}

test("validateTriageReceipt: accepts a well-formed receipt", () => {
  const receipt = sampleTriageReceipt();
  const validated = validateTriageReceipt(receipt);
  assert.equal(validated.disposition, "actionable");
});

test("validateTriageReceipt: rejects an invalid disposition", () => {
  assert.throws(() => validateTriageReceipt({ ...sampleTriageReceipt(), disposition: "excellent" }));
});

test("validateTriageReceipt: rejects a missing reasonText", () => {
  const receipt = sampleTriageReceipt() as Record<string, unknown>;
  const { reasonText: _drop, ...rest } = receipt;
  assert.throws(() => validateTriageReceipt(rest));
});

test("validateTriageReceipt: rejects a malformed timestamp", () => {
  assert.throws(() => validateTriageReceipt({ ...sampleTriageReceipt(), timestamp: "not-a-date" }));
});
