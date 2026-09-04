// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { contentDigest } from "../test-accounting/inventory.ts";
import { digestOf } from "./canonicalize.ts";
import {
  beginAttempt,
  checkBudget,
  copyAndRevalidateAccountingBundle,
  type EvidenceStorePolicy,
  isAttemptCompleted,
  issueAttemptMarker,
  publishCompleteReceipt,
  readCompletedReceipt,
  recordRecoveryReceipt,
  scanForIncompleteOrCorrupt,
  setTransactionMarkerWriteFaultForTest,
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
const BLOCKED_ADMISSION_PATTERN = /incomplete or corrupt marker/;
const INVALID_CHAIN_ENTRY_PATTERN = /completion chain entry|chainDigest|recordedAt|schema|unrecognized/i;

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

async function waitForPath(path: string, deadline: number): Promise<void> {
  try {
    await stat(path);
  } catch {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    await waitForPath(path, deadline);
  }
}

async function runAdmissionAdapter(
  root: string,
  attemptId: string,
  startPath: string
): Promise<{ code: number | null; output: string }> {
  const moduleUrl = pathToFileURL(resolve(fileURLToPath(new URL(".", import.meta.url)), "evidence-store.ts")).href;
  const driver = `
    import { access, writeFile } from "node:fs/promises";
    import { beginAttempt } from ${JSON.stringify(moduleUrl)};
    const [root, adapterId, startPath] = process.argv.slice(1);
    await writeFile(startPath + ".ready-" + adapterId, "ready");
    while (true) {
      try { await access(startPath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    try {
      const attemptId = await beginAttempt(root, { intentDigest: ${JSON.stringify(SAMPLE_INTENT_DIGEST)} });
      process.stdout.write(JSON.stringify({ adapterId, outcome: "admitted", attemptId }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ adapterId, outcome: "blocked", message: error.message }));
      process.exitCode = 1;
    }
  `;
  return await new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", driver, root, attemptId, startPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk));
    child.stderr.on("data", (chunk: Buffer) => (errorOutput += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (errorOutput.length > 0 && output.length === 0) {
        reject(new Error(errorOutput));
        return;
      }
      resolveResult({ code, output });
    });
  });
}

test("beginAttempt admission race: two real adapter processes contend; one is admitted and one is blocked", async () => {
  await withTempRoot(async (root) => {
    const startPath = resolve(root, "start-admission");
    const first = runAdmissionAdapter(root, "adapter-a", startPath);
    const second = runAdmissionAdapter(root, "adapter-b", startPath);
    const deadline = Date.now() + 5000;
    await Promise.all([
      waitForPath(`${startPath}.ready-adapter-a`, deadline),
      waitForPath(`${startPath}.ready-adapter-b`, deadline),
    ]);
    await writeFile(startPath, "go");
    const results = await Promise.all([first, second]);
    const outcomes = results.map(({ output }) => JSON.parse(output) as { outcome: string; message?: string });
    assert.equal(outcomes.filter(({ outcome }) => outcome === "admitted").length, 1);
    assert.equal(outcomes.filter(({ outcome }) => outcome === "blocked").length, 1);
    assert.match(outcomes.find(({ outcome }) => outcome === "blocked")?.message ?? "", BLOCKED_ADMISSION_PATTERN);
  });
});

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
    await assert.rejects(
      () => publishCompleteReceipt(root, receipt),
      /does not match the issued marker's intentDigest/
    );
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
    await writeFile(
      resolve(root, "markers", `${orphanAttemptId}.completed.json`),
      `${JSON.stringify(orphanReceipt, null, 2)}\n`
    );
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
    await writeFile(
      resolve(root, "markers", `${attemptId}.completed.json`),
      `${JSON.stringify(divergentReceipt, null, 2)}\n`
    );
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

for (const mutation of [
  {
    name: "missing schema",
    apply: (entry: Record<string, unknown>) => (entry.schema = undefined),
  },
  {
    name: "unknown schema",
    apply: (entry: Record<string, unknown>) => (entry.schema = "mutation-falsification.completion-chain-entry/v0"),
  },
  {
    name: "non-canonical recordedAt",
    apply: (entry: Record<string, unknown>) => (entry.recordedAt = "2026-09-03T00:00:00+00:00"),
  },
  {
    name: "rewritten canonical recordedAt",
    apply: (entry: Record<string, unknown>) => (entry.recordedAt = "2026-09-04T00:00:00.000Z"),
  },
  {
    name: "unknown field",
    apply: (entry: Record<string, unknown>) => (entry.unrecognizedReviewerField = "tampered"),
  },
]) {
  test(`verifyCompletionChain: rejects a chain entry with ${mutation.name}`, async () => {
    await withTempRoot(async (root) => {
      const receipt = sampleReceipt();
      await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
      await publishCompleteReceipt(root, receipt);
      const chainPath = resolve(root, "completions.chain.jsonl");
      const entry = JSON.parse((await readFile(chainPath, "utf8")).trim()) as Record<string, unknown>;
      mutation.apply(entry);
      await writeFile(chainPath, `${JSON.stringify(entry)}\n`);
      await assert.rejects(
        () => verifyCompletionChain(root),
        INVALID_CHAIN_ENTRY_PATTERN
      );
    });
  });
}

// ── P1-2: crash-honest transaction — receipt publication and chain append are ONE commit ──
//
// Each test below simulates a crash at exactly one of the reviewer's five
// named durability boundaries, by writing to disk exactly the artifacts
// that would exist on disk if the process died at that instant (rather
// than actually killing a child process), then proves scanForIncompleteOrCorrupt
// fails closed on the half-commit — or, for the one case where the crash
// happened strictly AFTER the durable commit (only the marker's own
// deletion never ran), that scan reconciles it automatically.

const TRANSACTION_SCHEMA = "mutation-falsification.completion-transaction/v1";

function transactionMarkerFor(
  attemptId: string,
  intentDigest: string,
  receiptDigest: string,
  phase: "started" | "receipt_committed"
) {
  return {
    schema: TRANSACTION_SCHEMA,
    attemptId,
    intentDigest,
    receiptDigest,
    phase,
    startedAt: new Date().toISOString(),
  };
}

test("fault injection — boundary 1: crash before receipt commit (transaction marker written, no receipt, no chain entry) fails closed", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await mkdir(resolve(root, "markers"), { recursive: true });
    const marker = transactionMarkerFor(receipt.attemptId, receipt.intentDigest, "irrelevant-digest", "started");
    await writeFile(
      resolve(root, "markers", `${receipt.attemptId}.transaction.json`),
      `${JSON.stringify(marker, null, 2)}\n`
    );
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /half_committed_transaction/);
    assert.equal(await isAttemptCompleted(root, receipt.attemptId), false);
  });
});

test("fault injection — boundary 2: crash after receipt commit, before chain append (receipt exists, marker says receipt_committed, no chain entry) fails closed", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await mkdir(resolve(root, "markers"), { recursive: true });
    await writeFile(
      resolve(root, "markers", `${receipt.attemptId}.completed.json`),
      `${JSON.stringify(receipt, null, 2)}\n`
    );
    const { digestOf } = await import("./canonicalize.ts");
    const marker = transactionMarkerFor(
      receipt.attemptId,
      receipt.intentDigest,
      digestOf(receipt),
      "receipt_committed"
    );
    await writeFile(
      resolve(root, "markers", `${receipt.attemptId}.transaction.json`),
      `${JSON.stringify(marker, null, 2)}\n`
    );
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /half_committed_transaction/);
  });
});

test("fault injection — boundary 3: crash mid chain-append (receipt exists, marker present, chain entry present but does not match marker's receiptDigest) fails closed", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await mkdir(resolve(root, "markers"), { recursive: true });
    await writeFile(
      resolve(root, "markers", `${receipt.attemptId}.completed.json`),
      `${JSON.stringify(receipt, null, 2)}\n`
    );
    const { digestOf } = await import("./canonicalize.ts");
    // Marker records the correct digest, but the chain entry that was
    // partially written before the crash carries a DIFFERENT one (e.g. a
    // torn/partial write) — reconciliation must not treat this as a match.
    const marker = transactionMarkerFor(
      receipt.attemptId,
      receipt.intentDigest,
      digestOf(receipt),
      "receipt_committed"
    );
    await writeFile(
      resolve(root, "markers", `${receipt.attemptId}.transaction.json`),
      `${JSON.stringify(marker, null, 2)}\n`
    );
    const chainEntry = {
      schema: "mutation-falsification.completion-chain-entry/v1",
      attemptId: receipt.attemptId,
      intentDigest: receipt.intentDigest,
      receiptDigest: "0".repeat(64), // torn write: does not match marker's receiptDigest
      prevChainDigest: "mutation-falsification.completion-chain.genesis/v1",
      chainDigest: "1".repeat(64),
      recordedAt: new Date().toISOString(),
    };
    await writeFile(resolve(root, "completions.chain.jsonl"), `${JSON.stringify(chainEntry)}\n`);
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /half_committed_transaction/);
  });
});

test("fault injection — boundary 4: crash after chain append, before its own fsync is durable (same as boundary 3 from a reader's perspective) fails closed", async () => {
  await withTempRoot(async (root) => {
    // A crash between the chain-entry write() and its own fsync() is
    // indistinguishable, from any later reader's perspective, from "the
    // write never reached disk at all" — POSIX gives no partial-fsync
    // visibility guarantee. The reader-observable state is therefore
    // identical to boundary 2 (no chain entry visible yet): fails closed.
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await mkdir(resolve(root, "markers"), { recursive: true });
    await writeFile(
      resolve(root, "markers", `${receipt.attemptId}.completed.json`),
      `${JSON.stringify(receipt, null, 2)}\n`
    );
    const { digestOf } = await import("./canonicalize.ts");
    const marker = transactionMarkerFor(
      receipt.attemptId,
      receipt.intentDigest,
      digestOf(receipt),
      "receipt_committed"
    );
    await writeFile(
      resolve(root, "markers", `${receipt.attemptId}.transaction.json`),
      `${JSON.stringify(marker, null, 2)}\n`
    );
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /half_committed_transaction/);
  });
});

test("fault injection — boundary 5: crash after full durable commit, before the transaction marker's own deletion — reconciled automatically, not blocked", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await publishCompleteReceipt(root, receipt);
    // Simulate the crash by re-adding a transaction marker AFTER the real
    // publish already fully committed (receipt + matching chain entry both
    // durable) — this is exactly what a crash between step 5 and step 6
    // would leave behind.
    const { digestOf } = await import("./canonicalize.ts");
    const marker = transactionMarkerFor(
      receipt.attemptId,
      receipt.intentDigest,
      digestOf(receipt),
      "receipt_committed"
    );
    await writeFile(
      resolve(root, "markers", `${receipt.attemptId}.transaction.json`),
      `${JSON.stringify(marker, null, 2)}\n`
    );

    // Reconciliation must resolve this automatically: scan must NOT block.
    const found = await scanForIncompleteOrCorrupt(root);
    assert.deepEqual(found, []);
    // And the stale marker must actually be gone afterward.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(resolve(root, "markers"));
    assert.ok(!entries.includes(`${receipt.attemptId}.transaction.json`));
  });
});

test("fault injection — crash after transaction-marker replacement temp fsync preserves the prior marker and blocks admission", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    setTransactionMarkerWriteFaultForTest((phase) => {
      if (phase === "receipt_committed") {
        throw new Error("injected crash after transaction marker temp fsync");
      }
    });
    try {
      await assert.rejects(() => publishCompleteReceipt(root, receipt), /injected crash/);
    } finally {
      setTransactionMarkerWriteFaultForTest(undefined);
    }
    const marker = JSON.parse(
      await readFile(resolve(root, "markers", `${receipt.attemptId}.transaction.json`), "utf8")
    );
    assert.equal(marker.phase, "started");
    await assert.rejects(
      () => beginAttempt(root, { intentDigest: SAMPLE_INTENT_DIGEST }),
      BLOCKED_ADMISSION_PATTERN
    );
  });
});

test("mutation control — a completed receipt mutated after chained publication is rejected by BOTH scanForIncompleteOrCorrupt and verifyCompletionChain", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await publishCompleteReceipt(root, receipt);

    // Mutate a schema-valid field on the already-published receipt —
    // preserves attemptId/intentDigest/schema so the earlier P1-3-style
    // checks (issued-marker binding) still pass; only the receipt's own
    // bytes (and therefore its digest) have changed since it was chained.
    const mutated: AttemptReceipt = { ...receipt, runtimeMs: receipt.runtimeMs + 999 };
    await writeFile(
      resolve(root, "markers", `${receipt.attemptId}.completed.json`),
      `${JSON.stringify(mutated, null, 2)}\n`
    );

    await assert.rejects(() => verifyCompletionChain(root), /divergent receipt/);
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /divergent_chain_entry/);
  });
});

test("mutation control — adding an unrecognized top-level receipt field after chained publication blocks BOTH verification paths", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await publishCompleteReceipt(root, receipt);

    // The reviewer's exact scenario: valid published JSON gains a field this
    // schema version does not own. A chain must never discard that field
    // before deciding whether the receipt still matches its entry.
    await writeFile(
      resolve(root, "markers", `${receipt.attemptId}.completed.json`),
      `${JSON.stringify({ ...receipt, unrecognizedReviewerField: "tampered" }, null, 2)}\n`
    );

    await assert.rejects(() => verifyCompletionChain(root), /unrecognized field/);
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /divergent_chain_entry/);
  });
});

test("mutation control — a receipt whose internal attemptId differs from both filename and recomputed chain entry blocks BOTH verification paths", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await publishCompleteReceipt(root, receipt);

    // The reviewer's exact direct-filesystem scenario: keep the completed
    // filename and chain entry ID, replace only the receipt's internal ID,
    // then recompute both digests so checksum verification alone cannot help.
    const mismatchedReceipt = { ...receipt, attemptId: randomUUID() };
    const chainPath = resolve(root, "completions.chain.jsonl");
    const entry = JSON.parse((await readFile(chainPath, "utf8")).trim());
    entry.receiptDigest = digestOf(mismatchedReceipt);
    const { chainDigest: _chainDigest, ...entryWithoutDigest } = entry;
    entry.chainDigest = digestOf(entryWithoutDigest);
    await writeFile(
      resolve(root, "markers", `${receipt.attemptId}.completed.json`),
      `${JSON.stringify(mismatchedReceipt, null, 2)}\n`
    );
    await writeFile(chainPath, `${JSON.stringify(entry)}\n`);

    await assert.rejects(() => verifyCompletionChain(root), /attemptId .* does not match its chain entry/);
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /divergent_chain_entry/);
  });
});

test("verifyCompletionChain: rejects a receipt whose intentDigest differs from its recomputed chain entry", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await publishCompleteReceipt(root, receipt);

    const mismatchedReceipt = { ...receipt, intentDigest: "f".repeat(64) };
    const chainPath = resolve(root, "completions.chain.jsonl");
    const entry = JSON.parse((await readFile(chainPath, "utf8")).trim());
    entry.receiptDigest = digestOf(mismatchedReceipt);
    const { chainDigest: _chainDigest, ...entryWithoutDigest } = entry;
    entry.chainDigest = digestOf(entryWithoutDigest);
    await writeFile(
      resolve(root, "markers", `${receipt.attemptId}.completed.json`),
      `${JSON.stringify(mismatchedReceipt, null, 2)}\n`
    );
    await writeFile(chainPath, `${JSON.stringify(entry)}\n`);

    await assert.rejects(() => verifyCompletionChain(root), /intentDigest .* does not match its chain entry/);
  });
});

test("scanForIncompleteOrCorrupt: detects an orphaned chain entry (chain entry with no completed receipt on disk)", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await publishCompleteReceipt(root, receipt);

    // Delete the completed receipt but leave the chain entry — simulates
    // an orphaned chain entry (e.g. external tampering with the markers dir).
    const { unlink } = await import("node:fs/promises");
    await unlink(resolve(root, "markers", `${receipt.attemptId}.completed.json`));

    await assert.rejects(() => verifyCompletionChain(root), /orphaned chain entry/);
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /orphaned chain entry/);
  });
});

test("scanForIncompleteOrCorrupt: detects a completed receipt with no chain entry at all (missing_chain_entry)", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await mkdir(resolve(root, "markers"), { recursive: true });
    // Write a completed receipt directly, bypassing publishCompleteReceipt
    // entirely — no transaction marker, no chain entry at all.
    await writeFile(
      resolve(root, "markers", `${receipt.attemptId}.completed.json`),
      `${JSON.stringify(receipt, null, 2)}\n`
    );
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /missing_chain_entry/);
  });
});

test("verifyCompletionChain: rejects a duplicate/forked chain entry (same attemptId appears twice)", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await publishCompleteReceipt(root, receipt);

    const chainPath = resolve(root, "completions.chain.jsonl");
    const raw = await readFile(chainPath, "utf8");
    const entry = JSON.parse(raw.trim());
    // Append a second (forked) entry claiming the SAME attemptId but a
    // different prevChainDigest — as if two concurrent publishers had
    // selected the same predecessor and both appended.
    const forked = { ...entry, prevChainDigest: entry.chainDigest, chainDigest: "f".repeat(64) };
    await writeFile(chainPath, `${raw.trim()}\n${JSON.stringify(forked)}\n`);

    await assert.rejects(() => verifyCompletionChain(root), /duplicate\/forked/);
  });
});

test("publishCompleteReceipt: two concurrent publishers cannot interleave — the exclusive ledger lock serializes them", async () => {
  await withTempRoot(async (root) => {
    const receiptA = sampleReceipt();
    const receiptB = sampleReceipt();
    await issueAttemptMarker(root, receiptA.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await issueAttemptMarker(root, receiptB.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });

    // Launch both publishes concurrently — without the lock, both could
    // read the same (empty) chain head and each append an entry with
    // prevChainDigest = GENESIS, producing a fork. With the lock, one
    // strictly completes before the other starts.
    await Promise.all([publishCompleteReceipt(root, receiptA), publishCompleteReceipt(root, receiptB)]);

    const chain = await verifyCompletionChain(root);
    assert.equal(chain.length, 2);
    // Exactly one of the two orderings — but never a fork (which
    // verifyCompletionChain would have already rejected above by throwing).
    assert.equal(chain[1]?.prevChainDigest, chain[0]?.chainDigest);
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

for (const invalidInput of [
  ["", "operator", "observed"],
  ["not-a-uuid", "operator", "observed"],
  [randomUUID(), "", "observed"],
  [randomUUID(), "operator", ""],
] as const) {
  test("recordRecoveryReceipt validates every input with the reader validator before deriving a path or staging bytes", async () => {
    await withTempRoot(async (root) => {
      const [attemptId, operatorClaim, observations] = invalidInput;
      await assert.rejects(
        () => recordRecoveryReceipt(root, attemptId, operatorClaim, observations),
        /recovery receipt|attemptId|operatorClaim|observations/
      );
      await assert.rejects(() => stat(resolve(root, "markers", `${attemptId}.recovery.json`)));
    });
  });
}

// ── P1-3: strict RecoveryReceipt validation — the scanner must block every one of these ──
//
// Each test writes exactly the bytes the reviewer names directly to
// `<attemptId>.recovery.json` (bypassing `recordRecoveryReceipt`, which
// itself can never produce these malformed shapes), then proves
// `scanForIncompleteOrCorrupt` blocks on it rather than silently retiring
// the attempt — the reviewer's exact fail-open scenario
// (`if (recoveryExists) continue` with no parsing at all).

async function issuedAttempt(root: string): Promise<string> {
  const attemptId = randomUUID();
  await issueAttemptMarker(root, attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
  return attemptId;
}

test("recovery scanner: blocks on a zero-byte recovery file", async () => {
  await withTempRoot(async (root) => {
    const attemptId = await issuedAttempt(root);
    await writeFile(resolve(root, "markers", `${attemptId}.recovery.json`), "");
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /corrupt/);
  });
});

test("recovery scanner: blocks on a truncated-JSON recovery file", async () => {
  await withTempRoot(async (root) => {
    const attemptId = await issuedAttempt(root);
    await writeFile(
      resolve(root, "markers", `${attemptId}.recovery.json`),
      '{"schema":"mutation-falsification.marker.recov'
    );
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /corrupt/);
  });
});

test("recovery scanner: blocks on a wrong-schema recovery file", async () => {
  await withTempRoot(async (root) => {
    const attemptId = await issuedAttempt(root);
    const bad = {
      schema: "wrong/v0",
      attemptId,
      operatorClaim: "x",
      observations: "y",
      disposition: "retired_incomplete",
      retainedEvidence: [],
      recordedAt: new Date().toISOString(),
    };
    await writeFile(resolve(root, "markers", `${attemptId}.recovery.json`), JSON.stringify(bad));
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /corrupt/);
  });
});

test("recovery scanner: blocks on a recovery file whose own attemptId does not match its filename", async () => {
  await withTempRoot(async (root) => {
    const attemptId = await issuedAttempt(root);
    const bad = {
      schema: "mutation-falsification.marker.recovery/v1",
      attemptId: randomUUID(), // wrong attemptId — does not match the filename
      operatorClaim: "x",
      observations: "y",
      disposition: "retired_incomplete",
      retainedEvidence: [],
      recordedAt: new Date().toISOString(),
    };
    await writeFile(resolve(root, "markers", `${attemptId}.recovery.json`), JSON.stringify(bad));
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /corrupt/);
  });
});

test("recovery scanner: blocks on an orphan recovery — no corresponding issued marker", async () => {
  await withTempRoot(async (root) => {
    await mkdir(resolve(root, "markers"), { recursive: true });
    const attemptId = randomUUID(); // never issued
    const receipt = {
      schema: "mutation-falsification.marker.recovery/v1",
      attemptId,
      operatorClaim: "x",
      observations: "y",
      disposition: "retired_incomplete",
      retainedEvidence: [],
      recordedAt: new Date().toISOString(),
    };
    await writeFile(resolve(root, "markers", `${attemptId}.recovery.json`), JSON.stringify(receipt));
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /orphan/);
  });
});

test("recovery scanner: blocks on recovery-after-completion — a completed receipt also exists for the same attempt", async () => {
  await withTempRoot(async (root) => {
    const receipt = sampleReceipt();
    await issueAttemptMarker(root, receipt.attemptId, { intentDigest: SAMPLE_INTENT_DIGEST });
    await publishCompleteReceipt(root, receipt);
    // A recovery receipt filed AFTER the attempt was already completed —
    // never a valid claim ("retire an incomplete attempt" when it wasn't
    // incomplete at all).
    const recovery = {
      schema: "mutation-falsification.marker.recovery/v1",
      attemptId: receipt.attemptId,
      operatorClaim: "x",
      observations: "y",
      disposition: "retired_incomplete",
      retainedEvidence: [],
      recordedAt: new Date().toISOString(),
    };
    await writeFile(resolve(root, "markers", `${receipt.attemptId}.recovery.json`), JSON.stringify(recovery));
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /recovery-after-completion|also exists/);
  });
});

test("recovery scanner: blocks on a duplicate recovery — recordRecoveryReceipt itself refuses a second write for the same attempt", async () => {
  await withTempRoot(async (root) => {
    const attemptId = await issuedAttempt(root);
    await recordRecoveryReceipt(root, attemptId, "tim", "observed once");
    await assert.rejects(() => recordRecoveryReceipt(root, attemptId, "tim", "observed twice"), /already exists/);
    // The first, valid recovery is unaffected — scan still passes clean.
    const found = await scanForIncompleteOrCorrupt(root);
    assert.deepEqual(found, []);
  });
});

test("recovery scanner: blocks on a leftover recovery temp file from an interrupted publish", async () => {
  await withTempRoot(async (root) => {
    await mkdir(resolve(root, "markers"), { recursive: true });
    await writeFile(resolve(root, "markers", `.${randomUUID()}.recovery.json.tmp-${randomUUID()}`), "{}");
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /leftover_temp_file/);
  });
});

test("recovery scanner: blocks on missing observations field", async () => {
  await withTempRoot(async (root) => {
    const attemptId = await issuedAttempt(root);
    const bad = {
      schema: "mutation-falsification.marker.recovery/v1",
      attemptId,
      operatorClaim: "x",
      disposition: "retired_incomplete",
      retainedEvidence: [],
      recordedAt: new Date().toISOString(),
    };
    await writeFile(resolve(root, "markers", `${attemptId}.recovery.json`), JSON.stringify(bad));
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /corrupt/);
  });
});

test("recovery scanner: blocks on an empty-string observations field (present but invalid)", async () => {
  await withTempRoot(async (root) => {
    const attemptId = await issuedAttempt(root);
    const bad = {
      schema: "mutation-falsification.marker.recovery/v1",
      attemptId,
      operatorClaim: "x",
      observations: "",
      disposition: "retired_incomplete",
      retainedEvidence: [],
      recordedAt: new Date().toISOString(),
    };
    await writeFile(resolve(root, "markers", `${attemptId}.recovery.json`), JSON.stringify(bad));
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /corrupt/);
  });
});

test("recovery scanner: blocks on a non-array retainedEvidence field", async () => {
  await withTempRoot(async (root) => {
    const attemptId = await issuedAttempt(root);
    const bad = {
      schema: "mutation-falsification.marker.recovery/v1",
      attemptId,
      operatorClaim: "x",
      observations: "y",
      disposition: "retired_incomplete",
      retainedEvidence: "not-an-array",
      recordedAt: new Date().toISOString(),
    };
    await writeFile(resolve(root, "markers", `${attemptId}.recovery.json`), JSON.stringify(bad));
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /corrupt/);
  });
});

test("recovery scanner: blocks on an invalid disposition value", async () => {
  await withTempRoot(async (root) => {
    const attemptId = await issuedAttempt(root);
    const bad = {
      schema: "mutation-falsification.marker.recovery/v1",
      attemptId,
      operatorClaim: "x",
      observations: "y",
      disposition: "something_else",
      retainedEvidence: [],
      recordedAt: new Date().toISOString(),
    };
    await writeFile(resolve(root, "markers", `${attemptId}.recovery.json`), JSON.stringify(bad));
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /corrupt/);
  });
});

test("recovery scanner: blocks on a missing/invalid timestamp", async () => {
  await withTempRoot(async (root) => {
    const attemptId = await issuedAttempt(root);
    const bad = {
      schema: "mutation-falsification.marker.recovery/v1",
      attemptId,
      operatorClaim: "x",
      observations: "y",
      disposition: "retired_incomplete",
      retainedEvidence: [],
      recordedAt: "not-a-timestamp",
    };
    await writeFile(resolve(root, "markers", `${attemptId}.recovery.json`), JSON.stringify(bad));
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /corrupt/);
  });
});

test("recovery scanner: blocks on a parseable but non-canonical timestamp", async () => {
  await withTempRoot(async (root) => {
    const attemptId = await issuedAttempt(root);
    const bad = {
      schema: "mutation-falsification.marker.recovery/v1",
      attemptId,
      operatorClaim: "x",
      observations: "y",
      disposition: "retired_incomplete",
      retainedEvidence: [],
      recordedAt: "September 3, 2026",
    };
    await writeFile(resolve(root, "markers", `${attemptId}.recovery.json`), JSON.stringify(bad));
    await assert.rejects(() => scanForIncompleteOrCorrupt(root), /corrupt/);
  });
});

test("recordRecoveryReceipt: publishes via a staged, fsynced, no-replace commit (temp file never left behind, final file present)", async () => {
  await withTempRoot(async (root) => {
    const attemptId = await issuedAttempt(root);
    await recordRecoveryReceipt(root, attemptId, "tim", "verified clean");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(resolve(root, "markers"));
    assert.ok(entries.includes(`${attemptId}.recovery.json`));
    assert.ok(!entries.some((e) => e.includes(".recovery.json.tmp-")));
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
