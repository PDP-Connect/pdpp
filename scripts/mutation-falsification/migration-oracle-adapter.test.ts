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
  MIGRATION_ORACLE_CASES_V1,
  parseStructuredOutput,
  runMigrationOracleAttempt,
  spawnWithLimits,
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

test("spawnWithLimits: captures a complete structured line from a descendant that keeps stdout open after its direct parent exits", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "mutation-falsification-close-fixture-"));
  try {
    const descendantPath = join(fixtureRoot, "descendant.mjs");
    const parentPath = join(fixtureRoot, "parent.mjs");
    const structuredLine = "MUTATION_ORACLE_STRUCTURED_JSON {\"complete\":true}";
    await writeFile(descendantPath, `setTimeout(() => process.stdout.write(${JSON.stringify(`${structuredLine}\n`)}), 25);`);
    await writeFile(
      parentPath,
      `import { spawn } from "node:child_process"; const descendant = spawn(process.execPath, [${JSON.stringify(descendantPath)}], { stdio: "inherit", detached: true }); descendant.unref();`
    );

    const result = await spawnWithLimits([process.execPath, parentPath], fixtureRoot, 5_000, 10_000);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdoutPrefix, `${structuredLine}\n`);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
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

/**
 * Builds a report carrying EXACTLY the required seven-case inventory (see
 * MIGRATION_ORACLE_CASES_V1), all caught, each with its policy-authorized
 * caughtBy. This is the ONLY shape `parseStructuredOutput` accepts as
 * well-formed as of P1-1 — a one-entry `{name:"x",...}` report (the
 * previously-accepted shape) is deliberately never exercised as a "good"
 * report anywhere in this file anymore.
 */
function wellFormedGoodReport() {
  return {
    ok: true,
    holes: [] as string[],
    mutations: MIGRATION_ORACLE_CASES_V1.map((c) => ({ name: c.name, caught: true, caughtBy: c.caughtBy, detail: "" })),
    positiveControl: { ok: true, detail: "" },
    rollback: { ok: true, detail: "" },
  };
}

test("parseStructuredOutput: accepts a genuinely well-formed structured report carrying the full seven-case inventory", () => {
  const parsed = parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(wellFormedGoodReport())}\n`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mutations.length, MIGRATION_ORACLE_CASES_V1.length);
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
  const good = wellFormedGoodReport();
  const report = {
    ...good,
    mutations: good.mutations.map((m, i) => (i === 0 ? { ...m, caught: false } : m)),
    holes: good.mutations.slice(0, 1).map((m) => m.name),
    // ok left at true — the report itself claims success despite an
    // uncaught mutation, i.e. exactly "success = exit 0 + structured.ok"
    // trusted without recomputation would have missed this.
  };
  assert.throws(() => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`), /inconsistent with its own reported inputs/);
});

test("parseStructuredOutput: rejects when holes disagrees with the mutations actually reported as uncaught", () => {
  const good = wellFormedGoodReport();
  const report = {
    ...good,
    mutations: good.mutations.map((m, i) => (i === 0 ? { ...m, caught: false } : m)),
    holes: [], // Should be [good.mutations[0].name] — disagrees with the mutations list.
    ok: false,
  };
  assert.throws(
    () => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`),
    /does not match the mutations actually reported as uncaught/
  );
});

test("parseStructuredOutput: rejects a malformed/absent nested mutation entry (caught is a string, not boolean)", () => {
  const good = wellFormedGoodReport();
  const report = { ...good, mutations: good.mutations.map((m, i) => (i === 0 ? { ...m, caught: "true" } : m)) };
  assert.throws(() => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`), /caught.*must be a boolean/);
});

test("parseStructuredOutput: rejects a mutation entry missing caughtBy entirely", () => {
  const good = wellFormedGoodReport();
  const report = {
    ...good,
    mutations: good.mutations.map((m, i) => {
      if (i !== 0) {
        return m;
      }
      const { caughtBy: _drop, ...rest } = m;
      return rest;
    }),
  };
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

// ── P1-1: MIGRATION_ORACLE_CASES_V1 inventory enforcement — mutation controls ──
//
// Each control below starts from `wellFormedGoodReport()` (the full,
// correct seven-case inventory) and applies exactly one of the reviewer's
// named mutations to it. Every variant must fail — a bug that returns a
// partial or tampered case list must never yield exit 0 / structured.ok /
// focused: ok.

function reportWithMutations(mutations: Array<{ caught: boolean; caughtBy: string; detail: string; name: string }>) {
  const holes = mutations.filter((m) => !m.caught).map((m) => m.name);
  return {
    mutations,
    holes,
    positiveControl: { ok: true, detail: "" },
    rollback: { ok: true, detail: "" },
    ok: holes.length === 0,
  };
}

test("parseStructuredOutput: mutation control — removing each of the seven required cases is individually rejected", () => {
  const good = wellFormedGoodReport();
  for (const [index, removed] of MIGRATION_ORACLE_CASES_V1.entries()) {
    const mutations = good.mutations.filter((_, i) => i !== index);
    const report = reportWithMutations(mutations);
    assert.throws(
      () => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`),
      /does not match the required MIGRATION_ORACLE_CASES_V1 inventory/,
      `expected removing case ${JSON.stringify(removed.name)} to be rejected`
    );
  }
});

test("parseStructuredOutput: mutation control — duplicating one case (still 7 names, one repeated, one missing) is rejected", () => {
  const good = wellFormedGoodReport();
  const mutations = [...good.mutations.slice(1), ...good.mutations.slice(1, 2)]; // duplicate case[1], drop case[0]
  const report = reportWithMutations(mutations);
  assert.throws(
    () => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`),
    /does not match the required MIGRATION_ORACLE_CASES_V1 inventory/
  );
});

test('parseStructuredOutput: mutation control — replacing one case with arbitrary "x" is rejected', () => {
  const good = wellFormedGoodReport();
  const mutations = good.mutations.map((m, i) => (i === 0 ? { name: "x", caught: true, caughtBy: "y", detail: "z" } : m));
  const report = reportWithMutations(mutations);
  assert.throws(
    () => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`),
    /does not match the required MIGRATION_ORACLE_CASES_V1 inventory/
  );
});

test("parseStructuredOutput: mutation control — relabeling one case's name is rejected", () => {
  const good = wellFormedGoodReport();
  const mutations = good.mutations.map((m, i) => (i === 0 ? { ...m, name: `${m.name} (relabeled)` } : m));
  const report = reportWithMutations(mutations);
  assert.throws(
    () => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`),
    /does not match the required MIGRATION_ORACLE_CASES_V1 inventory/
  );
});

test("parseStructuredOutput: mutation control — changing one case's caughtBy to an unauthorized value is rejected", () => {
  const good = wellFormedGoodReport();
  const mutations = good.mutations.map((m, i) => (i === 0 ? { ...m, caughtBy: "someUnauthorizedCheck" } : m));
  const report = reportWithMutations(mutations);
  assert.throws(
    () => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`),
    /does not match the required MIGRATION_ORACLE_CASES_V1 inventory/
  );
});

test("parseStructuredOutput: mutation control — appending an extra case beyond the required seven is rejected", () => {
  const good = wellFormedGoodReport();
  const mutations = [...good.mutations, { name: "an extra unrequired case", caught: true, caughtBy: "someCheck", detail: "" }];
  const report = reportWithMutations(mutations);
  assert.throws(
    () => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`),
    /does not match the required MIGRATION_ORACLE_CASES_V1 inventory/
  );
});

test("parseStructuredOutput: mutation control — a one-entry report (the historically-accepted shape) is rejected", () => {
  const report = reportWithMutations([{ name: "x", caught: true, caughtBy: "y", detail: "z" }]);
  assert.throws(
    () => parseStructuredOutput(`MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(report)}\n`),
    /does not match the required MIGRATION_ORACLE_CASES_V1 inventory/
  );
});

test("parseStructuredOutput: rejects multiple structured-output lines rather than taking the first", () => {
  const good = wellFormedGoodReport();
  const stdout =
    `MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(good)}\n` +
    `MUTATION_ORACLE_STRUCTURED_JSON ${JSON.stringify(good)}\n`;
  assert.throws(() => parseStructuredOutput(stdout), /expected exactly one structured-output line/);
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
