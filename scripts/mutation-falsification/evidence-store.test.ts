// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { contentDigest } from "../test-accounting/inventory.ts";
import {
  checkBudget,
  copyAndRevalidateAccountingBundle,
  type EvidenceStorePolicy,
  isAttemptCompleted,
  issueAttemptMarker,
  publishCompleteReceipt,
  readCompletedReceipt,
  recordRecoveryReceipt,
  scanForIncompleteOrCorrupt,
} from "./evidence-store.ts";
import { ATTEMPT_SCHEMA, type AttemptReceipt } from "./schemas.ts";

// Tests use a real disk-backed temp directory under the OS temp root (this
// harness's own test scratch, not production evidence) — evidence-store.ts
// itself is directory-agnostic; the "never /tmp" rule in design.md targets
// where a REAL pilot batch retains its evidence, not this test's throwaway
// fixtures.
async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mutation-falsification-evidence-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sampleReceipt(overrides: Partial<AttemptReceipt> = {}): AttemptReceipt {
  return {
    schema: ATTEMPT_SCHEMA,
    attemptId: randomUUID(),
    trialKey: "a".repeat(64),
    policyVersion: "v1",
    baseCommitSha: "b".repeat(40),
    mutantIdentity: null,
    judgeIdentity: "c".repeat(40),
    environmentProfile: ["HOME"],
    evidenceArtifacts: [],
    axes: {
      baseline: { status: "ok" },
      materialization: { status: "ok" },
      focused: { status: "ok" },
      backstop: { status: "ok" },
      reachability: { status: "ok" },
      cleanup: { status: "ok" },
    },
    runtimeMs: 100,
    attemptStatus: { exitCode: 0, signal: null },
    referencedAccountingRunIds: [],
    ...overrides,
  };
}

test("issueAttemptMarker then scanForIncompleteOrCorrupt: an issued-but-not-completed marker blocks execution", async () => {
  await withTempRoot(async (root) => {
    const attemptId = randomUUID();
    await issueAttemptMarker(root, attemptId, { intentDigest: "d".repeat(64) });
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /incomplete or corrupt/);
  });
});

test("issueAttemptMarker refuses a colliding attempt_id (wx flag fails loudly)", async () => {
  await withTempRoot(async (root) => {
    const attemptId = randomUUID();
    await issueAttemptMarker(root, attemptId, { intentDigest: "d".repeat(64) });
    await assert.rejects(() => issueAttemptMarker(root, attemptId, { intentDigest: "d".repeat(64) }));
  });
});

test("a corrupt issued marker is reported and blocks a scan", async () => {
  await withTempRoot(async (root) => {
    await mkdir(resolve(root, "markers"), { recursive: true });
    await writeFile(resolve(root, "markers", `${randomUUID()}.issued.json`), "{not valid json");
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /incomplete or corrupt/);
  });
});

test("issue then publishCompleteReceipt: a fully completed attempt is NOT blocked by a scan", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: "d".repeat(64) });
    await publishCompleteReceipt(root, receipt);
    const found = await scanForIncompleteOrCorrupt(root);
    assert.deepEqual(found, []);
  });
});

test("publishCompleteReceipt refuses to publish a receipt that fails validation", async () => {
  await withTempRoot(async (root) => {
    const badReceipt = { ...sampleReceipt(), attemptId: "not-a-uuid" };
    await assert.rejects(() => publishCompleteReceipt(root, badReceipt as unknown as AttemptReceipt));
  });
});

test("readCompletedReceipt round-trips a published receipt byte-for-byte semantically", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: "d".repeat(64) });
    await publishCompleteReceipt(root, receipt);
    const read = await readCompletedReceipt(root, receipt.attemptId);
    assert.equal(read.attemptId, receipt.attemptId);
    assert.equal(read.trialKey, receipt.trialKey);
  });
});

test("recordRecoveryReceipt does NOT flip an incomplete attempt's disposition to completed", async () => {
  await withTempRoot(async (root) => {
    const attemptId = randomUUID();
    await issueAttemptMarker(root, attemptId, { intentDigest: "d".repeat(64) });
    await recordRecoveryReceipt(root, attemptId, "tim (unauthenticated claim)", "no lingering process observed");
    // The completed-receipt reader still doesn't see it as completed.
    assert.equal(await isAttemptCompleted(root, attemptId), false);
    await assert.rejects(() => readCompletedReceipt(root, attemptId));
    // But a scan no longer blocks on it — it has been explicitly retired.
    const found = await scanForIncompleteOrCorrupt(root);
    assert.deepEqual(found, []);
  });
});

test("checkBudget throws before accepting an attempt that would exceed maxRetainedBytes", async () => {
  await withTempRoot(async (root) => {
    const policy: EvidenceStorePolicy = {
      evidenceRoot: root,
      maxRetainedBytes: 100,
      maxAttempts: 10,
      retentionDeadlineDays: 30,
    };
    await assert.rejects(() => checkBudget(policy, 1000));
  });
});

test("checkBudget throws before accepting an attempt that would exceed maxAttempts", async () => {
  await withTempRoot(async (root) => {
    const policy: EvidenceStorePolicy = {
      evidenceRoot: root,
      maxRetainedBytes: 1_000_000_000,
      maxAttempts: 1,
      retentionDeadlineDays: 30,
    };
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: "d".repeat(64) });
    await publishCompleteReceipt(root, receipt);
    await assert.rejects(() => checkBudget(policy, 1));
  });
});

test("checkBudget passes when well within budget", async () => {
  await withTempRoot(async (root) => {
    const policy: EvidenceStorePolicy = {
      evidenceRoot: root,
      maxRetainedBytes: 1_000_000_000,
      maxAttempts: 10,
      retentionDeadlineDays: 30,
    };
    await assert.doesNotReject(() => checkBudget(policy, 1000));
  });
});

// ── copyAndRevalidateAccountingBundle ───────────────────────────────────

async function writeFakeAccountingBundle(accountingDir: string, runId: string): Promise<void> {
  await mkdir(accountingDir, { recursive: true });
  const transcriptBody = `${JSON.stringify({ event: "start", run_id: runId })}\n${JSON.stringify({ event: "end", run_id: runId })}\n`;
  const authorityBody = `${JSON.stringify({ schema: "pdpp.test-run-authority/v1", run_id: runId })}\n`;
  const completionBody = `${JSON.stringify({ schema: "pdpp.test-run-completion/v1", run_id: runId })}\n`;
  await writeFile(resolve(accountingDir, `${runId}.transcript`), transcriptBody);
  await writeFile(resolve(accountingDir, `${runId}.authority.json`), authorityBody);
  await writeFile(resolve(accountingDir, `${runId}.completion.json`), completionBody);
  const receiptBody = `${JSON.stringify({
    schema: "pdpp.test-receipt/v3",
    run_id: runId,
    authority_sha256: contentDigest(Buffer.from(authorityBody)),
    completion_sha256: contentDigest(Buffer.from(completionBody)),
    transcript_sha256: contentDigest(Buffer.from(transcriptBody)),
  })}\n`;
  await writeFile(resolve(accountingDir, `${runId}.receipt.json`), receiptBody);
}

test("copyAndRevalidateAccountingBundle: copies all 4 files and revalidates against the copies", async () => {
  await withTempRoot(async (root) => {
    const accountingDir = resolve(root, "fake-test-accounting-runs");
    const runId = randomUUID();
    await writeFakeAccountingBundle(accountingDir, runId);
    const attemptId = randomUUID();
    const artifacts = await copyAndRevalidateAccountingBundle(root, attemptId, accountingDir, runId);
    assert.equal(artifacts.length, 4);
    for (const artifact of artifacts) {
      const copied = await readFile(resolve(root, artifact.relativePath));
      assert.equal(contentDigest(copied), artifact.sha256);
      assert.equal(copied.length, artifact.byteSize);
    }
  });
});

test("copyAndRevalidateAccountingBundle: throws when a copied file's bytes are altered after copy (digest mismatch)", async () => {
  await withTempRoot(async (root) => {
    const accountingDir = resolve(root, "fake-test-accounting-runs");
    const runId = randomUUID();
    await writeFakeAccountingBundle(accountingDir, runId);
    // Corrupt the SOURCE authority file so the copy will legitimately carry
    // altered bytes relative to what the receipt's authority_sha256 expects.
    await writeFile(resolve(accountingDir, `${runId}.authority.json`), '{"tampered":true}\n');
    const attemptId = randomUUID();
    await assert.rejects(
      () => copyAndRevalidateAccountingBundle(root, attemptId, accountingDir, runId),
      /does not match the receipt's recorded digest/
    );
  });
});

test("copyAndRevalidateAccountingBundle: throws when a required file is missing from the source run directory", async () => {
  await withTempRoot(async (root) => {
    const accountingDir = resolve(root, "fake-test-accounting-runs");
    const runId = randomUUID();
    await writeFakeAccountingBundle(accountingDir, runId);
    await rm(resolve(accountingDir, `${runId}.transcript`));
    const attemptId = randomUUID();
    await assert.rejects(() => copyAndRevalidateAccountingBundle(root, attemptId, accountingDir, runId));
  });
});
