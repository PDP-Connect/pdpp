// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freezeIntentPacket, INTENT_SCHEMA } from "./schemas.ts";
import {
  deriveEffectiveCommand,
  MIGRATION_ORACLE_ADAPTER_ID,
  MIGRATION_ORACLE_ADAPTER_VERSION,
  parseStructuredOutput,
  runMigrationOracleAttempt,
  UnregisteredAdapterError,
} from "./migration-oracle-adapter.ts";
import { isAttemptCompleted, readCompletedReceipt, scanForIncompleteOrCorrupt } from "./evidence-store.ts";

async function withTempEvidenceRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mutation-falsification-oracle-adapter-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sampleIntent(overrides: Partial<{ adapterId: string; adapterVersion: string }> = {}) {
  return freezeIntentPacket({
    schema: INTENT_SCHEMA,
    requestedRisk: "migration-oracle-structured-evidence",
    adapterId: overrides.adapterId ?? MIGRATION_ORACLE_ADAPTER_ID,
    adapterVersion: overrides.adapterVersion ?? MIGRATION_ORACLE_ADAPTER_VERSION,
    operatorId: null,
    baseCommitSha: "a".repeat(40),
    requestedBudget: { wallTimeMs: 60_000, directOutputByteCap: 5_000_000 },
  });
}

test("deriveEffectiveCommand: always derives the same fixed command, never caller-suppliable", () => {
  const command = deriveEffectiveCommand();
  assert.ok(command.includes("--structured"));
  assert.ok(command.some((part) => part.includes("mutation-oracle.ts")));
});

test("runMigrationOracleAttempt: rejects an unregistered adapter id before execution", async () => {
  await withTempEvidenceRoot(async (evidenceRoot) => {
    const intent = sampleIntent({ adapterId: "some-other-adapter/v1" });
    await assert.rejects(
      () => runMigrationOracleAttempt({ intent, evidenceRoot, cwd: process.cwd(), policyVersion: "v1", wallTimeMs: 1000, directOutputByteCap: 1000 }),
      UnregisteredAdapterError
    );
    // No marker should have been issued for a rejected attempt.
    const found = await scanForIncompleteOrCorrupt(evidenceRoot);
    assert.deepEqual(found, []);
  });
});

test("runMigrationOracleAttempt: rejects an unregistered adapter version before execution", async () => {
  await withTempEvidenceRoot(async (evidenceRoot) => {
    const intent = sampleIntent({ adapterVersion: "999" });
    await assert.rejects(
      () => runMigrationOracleAttempt({ intent, evidenceRoot, cwd: process.cwd(), policyVersion: "v1", wallTimeMs: 1000, directOutputByteCap: 1000 }),
      UnregisteredAdapterError
    );
  });
});

test("runMigrationOracleAttempt: a real successful run publishes a complete receipt with focused: ok and backstop: not_applicable", async () => {
  await withTempEvidenceRoot(async (evidenceRoot) => {
    const intent = sampleIntent();
    const receipt = await runMigrationOracleAttempt({
      intent,
      evidenceRoot,
      cwd: process.cwd(),
      policyVersion: "v1",
      wallTimeMs: 60_000,
      directOutputByteCap: 5_000_000,
    });
    assert.equal(receipt.axes.focused.status, "ok");
    assert.equal(receipt.axes.backstop.status, "not_applicable");
    assert.equal(await isAttemptCompleted(evidenceRoot, receipt.attemptId), true);
    const found = await scanForIncompleteOrCorrupt(evidenceRoot);
    assert.deepEqual(found, []);
  });
});

test("runMigrationOracleAttempt: an enforced wall-deadline exceeded is recorded and projects an inconclusive-shaped failure, never success", async () => {
  await withTempEvidenceRoot(async (evidenceRoot) => {
    const intent = sampleIntent();
    const receipt = await runMigrationOracleAttempt({
      intent,
      evidenceRoot,
      cwd: process.cwd(),
      policyVersion: "v1",
      wallTimeMs: 1, // impossibly short — the real oracle takes >1s
      directOutputByteCap: 5_000_000,
    });
    assert.equal(receipt.axes.focused.status, "failed");
    assert.equal(receipt.axes.focused.status === "failed" ? receipt.axes.focused.failure : "", "wall_deadline_exceeded");
    assert.equal(await isAttemptCompleted(evidenceRoot, receipt.attemptId), true);
  });
});

test("runMigrationOracleAttempt: an output-flood beyond the byte cap is bounded and recorded, never silently accepted", async () => {
  await withTempEvidenceRoot(async (evidenceRoot) => {
    const intent = sampleIntent();
    const receipt = await runMigrationOracleAttempt({
      intent,
      evidenceRoot,
      cwd: process.cwd(),
      policyVersion: "v1",
      wallTimeMs: 60_000,
      directOutputByteCap: 10, // far smaller than the real oracle's real output
    });
    assert.equal(receipt.axes.focused.status, "failed");
    assert.equal(
      receipt.axes.focused.status === "failed" ? receipt.axes.focused.failure : "",
      "direct_output_byte_cap_exceeded"
    );
  });
});

test("issueAttemptMarker without completion (simulated crash) blocks a later scan and requires an explicit recovery receipt", async () => {
  await withTempEvidenceRoot(async (evidenceRoot) => {
    const { issueAttemptMarker, recordRecoveryReceipt } = await import("./evidence-store.ts");
    const attemptId = randomUUID();
    await issueAttemptMarker(evidenceRoot, attemptId, { intentDigest: "d".repeat(64) });
    await assert.rejects(() => scanForIncompleteOrCorrupt(evidenceRoot), /incomplete or corrupt/);
    await recordRecoveryReceipt(evidenceRoot, attemptId, "operator (unauthenticated claim)", "verified no lingering process");
    const found = await scanForIncompleteOrCorrupt(evidenceRoot);
    assert.deepEqual(found, []);
    assert.equal(await isAttemptCompleted(evidenceRoot, attemptId), false);
  });
});

test("a corrupt completed-receipt file is detected by a later scan as corrupt, not silently accepted", async () => {
  await withTempEvidenceRoot(async (evidenceRoot) => {
    const { issueAttemptMarker } = await import("./evidence-store.ts");
    const attemptId = randomUUID();
    await issueAttemptMarker(evidenceRoot, attemptId, { intentDigest: "d".repeat(64) });
    const { mkdir } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    await mkdir(resolve(evidenceRoot, "markers"), { recursive: true });
    await writeFile(resolve(evidenceRoot, "markers", `${attemptId}.completed.json`), '{"schema":"wrong"}');
    await assert.rejects(() => scanForIncompleteOrCorrupt(evidenceRoot), /incomplete or corrupt/);
  });
});

test("a well-formed receipt's cleanup axis is recorded ok when nothing failed", async () => {
  await withTempEvidenceRoot(async (evidenceRoot) => {
    const intent = sampleIntent();
    const receipt = await runMigrationOracleAttempt({
      intent,
      evidenceRoot,
      cwd: process.cwd(),
      policyVersion: "v1",
      wallTimeMs: 60_000,
      directOutputByteCap: 5_000_000,
    });
    assert.equal(receipt.axes.cleanup.status, "ok");
  });
});

// ── parseStructuredOutput: corrupt/partial/missing-case/missing-control fault injection ──

test("parseStructuredOutput: throws when stdout has no structured-output line at all (missing output)", () => {
  assert.throws(() => parseStructuredOutput("some unrelated human output\nwith no JSON line\n"), /no structured-output line/);
});

test("parseStructuredOutput: throws when the structured-output line is corrupt (not valid JSON)", () => {
  assert.throws(
    () => parseStructuredOutput("MUTATION_ORACLE_STRUCTURED_JSON {not valid json\n"),
    /not valid JSON/
  );
});

test("parseStructuredOutput: throws when the structured output is missing its mutations case list", () => {
  const partial = JSON.stringify({ ok: true, holes: [], positiveControl: { ok: true, detail: "" }, rollback: { ok: true, detail: "" } });
  assert.throws(() => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${partial}\n`), /mutations must be an array/);
});

test("parseStructuredOutput: throws when the structured output is missing its positive-control result", () => {
  const partial = JSON.stringify({ ok: true, holes: [], mutations: [], rollback: { ok: true, detail: "" } });
  assert.throws(() => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${partial}\n`), /positiveControl must be an object/);
});

test("parseStructuredOutput: throws when the structured output is missing its rollback result", () => {
  const partial = JSON.stringify({ ok: true, holes: [], mutations: [], positiveControl: { ok: true, detail: "" } });
  assert.throws(() => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${partial}\n`), /rollback must be an object/);
});

// ── P1-4: full-shape validation + independent recomputation of derived invariants ──
//
// The reviewer's exact scenario: a well-formed-but-wrong oracle. Every one
// of these is valid JSON with every top-level field present (so the OLD
// presence-only check would have accepted all of them) — each is rejected
// here because it either has a malformed nested shape, or its claimed
// `ok`/`holes` disagree with what `mutations`/`positiveControl`/`rollback`
// actually say.

function wellFormedGoodReport() {
  return {
    ok: true,
    holes: [] as string[],
    mutations: [{ name: "x", caught: true, caughtBy: "y", detail: "z" }],
    positiveControl: { ok: true, detail: "" },
    rollback: { ok: true, detail: "" },
  };
}

test("parseStructuredOutput: accepts a genuinely well-formed structured report", () => {
  const parsed = parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(wellFormedGoodReport())}\n`);
  assert.equal(parsed.ok, true);
});

test("parseStructuredOutput: rejects ok: true when the positive control actually failed (well-formed, internally inconsistent)", () => {
  const report = { ...wellFormedGoodReport(), positiveControl: { ok: false, detail: "false positive observed" } };
  assert.throws(() => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`), /inconsistent with its own reported inputs/);
});

test("parseStructuredOutput: rejects ok: true when rollback actually failed", () => {
  const report = { ...wellFormedGoodReport(), rollback: { ok: false, detail: "rollback diverged" } };
  assert.throws(() => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`), /inconsistent with its own reported inputs/);
});

test("parseStructuredOutput: rejects ok: true when a mutation was actually uncaught (a real hole)", () => {
  const report = {
    ...wellFormedGoodReport(),
    mutations: [{ name: "x", caught: false, caughtBy: "intendedCheck", detail: "not caught" }],
    holes: ["x"],
    // ok left at true — the report itself claims success despite an
    // uncaught mutation, i.e. exactly "success = exit 0 + structured.ok"
    // trusted without recomputation would have missed this.
  };
  assert.throws(() => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`), /inconsistent with its own reported inputs/);
});

test("parseStructuredOutput: rejects when holes disagrees with the mutations actually reported as uncaught", () => {
  const report = {
    ...wellFormedGoodReport(),
    mutations: [
      { name: "a", caught: false, caughtBy: "intendedCheck", detail: "not caught" },
      { name: "b", caught: true, caughtBy: "check", detail: "" },
    ],
    holes: [], // Should be ["a"] — disagrees with the mutations list.
    ok: false,
  };
  assert.throws(
    () => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`),
    /does not match the mutations actually reported as uncaught/
  );
});

test("parseStructuredOutput: rejects a malformed/absent nested mutation entry (caught is a string, not boolean)", () => {
  const report = { ...wellFormedGoodReport(), mutations: [{ name: "x", caught: "true", caughtBy: "y", detail: "z" }] };
  assert.throws(() => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`), /caught.*must be a boolean/);
});

test("parseStructuredOutput: rejects a mutation entry missing caughtBy entirely", () => {
  const report = { ...wellFormedGoodReport(), mutations: [{ name: "x", caught: true, detail: "z" }] };
  assert.throws(() => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`), /caughtBy.*must be a non-empty string/);
});

test("parseStructuredOutput: rejects positiveControl missing its own ok field (nested shape, not just parent truthiness)", () => {
  const report = { ...wellFormedGoodReport(), positiveControl: { detail: "no ok field at all" } };
  assert.throws(() => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`), /positiveControl\.ok must be a boolean/);
});

test("parseStructuredOutput: rejects rollback missing its own detail field", () => {
  const report = { ...wellFormedGoodReport(), rollback: { ok: true } };
  assert.throws(() => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`), /rollback\.detail must be a string/);
});

test("parseStructuredOutput: rejects holes containing a non-string entry", () => {
  const report = { ...wellFormedGoodReport(), holes: [123] };
  assert.throws(() => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`), /holes must be an array of strings/);
});

test("parseStructuredOutput: rejects a top-level array instead of an object", () => {
  assert.throws(() => parseStructuredOutput("MUTATION_ORACLE_STRUCTURED_JSON []\n"), /top-level structured output must be an object/);
});

test("evidence root ends up with exactly one issued marker and one completed receipt for a successful attempt", async () => {
  await withTempEvidenceRoot(async (evidenceRoot) => {
    const intent = sampleIntent();
    const receipt = await runMigrationOracleAttempt({
      intent,
      evidenceRoot,
      cwd: process.cwd(),
      policyVersion: "v1",
      wallTimeMs: 60_000,
      directOutputByteCap: 5_000_000,
    });
    const read = await readCompletedReceipt(evidenceRoot, receipt.attemptId);
    assert.equal(read.attemptId, receipt.attemptId);
    const entries = await readdir(join(evidenceRoot, "markers"));
    assert.ok(entries.includes(`${receipt.attemptId}.issued.json`));
    assert.ok(entries.includes(`${receipt.attemptId}.completed.json`));
  });
});
