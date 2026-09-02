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
  verifyCompletionChain,
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

/** Matches the `intentDigest: "d".repeat(64)` this file's tests consistently pass to `issueAttemptMarker`, so publishCompleteReceipt's issued/receipt intent-binding check passes by default. */
const SAMPLE_INTENT_DIGEST = "d".repeat(64);

function sampleReceipt(overrides: Partial<AttemptReceipt> = {}): AttemptReceipt {
  return {
    schema: ATTEMPT_SCHEMA,
    attemptId: randomUUID(),
    trialKey: "a".repeat(64),
    intentDigest: SAMPLE_INTENT_DIGEST,
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

// ── P1-3: completion is bound append-only to the exact issued intent ────

test("publishCompleteReceipt: rejects a completion for an attemptId that was never issued (unknown attempt)", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt(); // attemptId never passed to issueAttemptMarker
    await assert.rejects(() => publishCompleteReceipt(root, receipt), /no issued marker exists/);
  });
});

test("publishCompleteReceipt: rejects a completion whose intentDigest does not match the issued marker's intentDigest (wrong intent)", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt({ intentDigest: "f".repeat(64) });
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST }); // "d".repeat(64) != "f".repeat(64)
    await assert.rejects(() => publishCompleteReceipt(root, receipt), /does not match the issued marker's intentDigest/);
    // The rejected publish must never have left a completed receipt behind.
    assert.equal(await isAttemptCompleted(root, receipt.attemptId), false);
  });
});

test("publishCompleteReceipt: rejects a completion for the wrong attemptId's issued marker (attempt mismatch)", async () => {
  await withTempRoot(async (root) => {
    const issuedAttemptId = randomUUID();
    await issueAttemptMarker(root, issuedAttemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    // A receipt claiming a DIFFERENT attemptId than the one that was issued.
    const receipt = sampleReceipt({ attemptId: randomUUID() });
    await assert.rejects(() => publishCompleteReceipt(root, receipt), /no issued marker exists/);
  });
});

test("publishCompleteReceipt: rejects a duplicate publication for an already-completed attempt (replay)", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await publishCompleteReceipt(root, receipt);
    // A second publish for the SAME attemptId — whether an accidental
    // re-run or an adversarial resubmission — must be rejected, not
    // silently accepted or merged.
    await assert.rejects(() => publishCompleteReceipt(root, receipt), /already exists|replay/);
  });
});

test("publishCompleteReceipt: NO-REPLACE — a second publish can never overwrite the first receipt's bytes", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await publishCompleteReceipt(root, receipt);
    const firstRead = await readCompletedReceipt(root, receipt.attemptId);

    // Attempt to publish a DIFFERENT (but otherwise valid) receipt under
    // the SAME attemptId — this must be rejected outright, and the
    // originally published bytes must remain completely unchanged.
    const overwriteAttempt: AttemptReceipt = { ...receipt, runtimeMs: 999_999 };
    await assert.rejects(() => publishCompleteReceipt(root, overwriteAttempt));

    const secondRead = await readCompletedReceipt(root, receipt.attemptId);
    assert.equal(secondRead.runtimeMs, firstRead.runtimeMs);
    assert.notEqual(secondRead.runtimeMs, 999_999);
  });
});

test("scanForIncompleteOrCorrupt: detects an orphan completion (a completed receipt with no issued marker) and blocks", async () => {
  await withTempRoot(async (root) => {
    await mkdir(resolve(root, "markers"), { recursive: true });
    const orphanAttemptId = randomUUID();
    const orphanReceipt = sampleReceipt({ attemptId: orphanAttemptId });
    // Written directly, bypassing publishCompleteReceipt entirely — this is
    // exactly the scenario the reviewer flagged: a completion that exists
    // without ever having gone through the intent-binding check.
    await writeFile(resolve(root, "markers", `${orphanAttemptId}.completed.json`), `${JSON.stringify(orphanReceipt, null, 2)}\n`);
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /orphan_completion/);
  });
});

test("scanForIncompleteOrCorrupt: detects a leftover temp file from an interrupted publish and blocks", async () => {
  await withTempRoot(async (root) => {
    await mkdir(resolve(root, "markers"), { recursive: true });
    await writeFile(resolve(root, "markers", `.${randomUUID()}.completed.json.tmp-${randomUUID()}`), "{}");
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /leftover_temp_file/);
  });
});

test("scanForIncompleteOrCorrupt: detects a malformed issued marker (wrong schema) and blocks", async () => {
  await withTempRoot(async (root) => {
    await mkdir(resolve(root, "markers"), { recursive: true });
    const attemptId = randomUUID();
    await writeFile(
      resolve(root, "markers", `${attemptId}.issued.json`),
      `${JSON.stringify({ schema: "wrong/v0", attemptId, intentDigest: SAMPLE_INTENT_DIGEST, issuedAt: new Date().toISOString() })}\n`
    );
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /incomplete or corrupt/);
  });
});

test("scanForIncompleteOrCorrupt: detects a completed receipt whose intentDigest diverges from its own issued marker", async () => {
  await withTempRoot(async (root) => {
    await mkdir(resolve(root, "markers"), { recursive: true });
    const attemptId = randomUUID();
    await issueAttemptMarker(root, attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    // Written directly (bypassing publishCompleteReceipt's own check) to
    // simulate a completed receipt that was somehow bound to a different
    // intent than the one it was issued under.
    const divergentReceipt = sampleReceipt({ attemptId, intentDigest: "f".repeat(64) });
    await writeFile(resolve(root, "markers", `${attemptId}.completed.json`), `${JSON.stringify(divergentReceipt, null, 2)}\n`);
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /intent_mismatch/);
  });
});

test("publishCompleteReceipt: every accepted publish extends a verifiable hash chain binding attemptId + intentDigest + receipt", async () => {
  await withTempRoot(async (root) => {
    const receiptA = sampleReceipt();
    const receiptB = sampleReceipt();
    await issueAttemptMarker(root, receiptA.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await issueAttemptMarker(root, receiptB.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await publishCompleteReceipt(root, receiptA);
    await publishCompleteReceipt(root, receiptB);

    const chain = await verifyCompletionChain(root);
    assert.equal(chain.length, 2);
    assert.equal(chain[0]?.attemptId, receiptA.attemptId);
    assert.equal(chain[1]?.attemptId, receiptB.attemptId);
    // Each entry's own chainDigest is derived from (among other things) the
    // PRECEDING entry's chainDigest — the second entry is provably linked
    // to the first, not merely two independent, unlinked log lines.
    assert.equal(chain[1]?.prevChainDigest, chain[0]?.chainDigest);
  });
});

test("verifyCompletionChain: throws if an earlier entry's bytes are tampered (chain is tamper-evident, not just append-only by convention)", async () => {
  await withTempRoot(async (root) => {
    const receiptA = sampleReceipt();
    await issueAttemptMarker(root, receiptA.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await publishCompleteReceipt(root, receiptA);

    const chainPath = resolve(root, "completions.chain.jsonl");
    const raw = await readFile(chainPath, "utf8");
    const entry = JSON.parse(raw.trim());
    entry.intentDigest = "f".repeat(64); // Tamper with a field the chainDigest is supposed to bind.
    await writeFile(chainPath, `${JSON.stringify(entry)}\n`);

    await assert.rejects(() => verifyCompletionChain(root), /tampered entry/);
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
