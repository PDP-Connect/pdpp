// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The evidence store: issued/incomplete/completed marker lifecycle plus
 * retention rules (design.md Decision #4 and #6). A verifier-owned,
 * disk-backed directory OUTSIDE any disposable workspace — never `/tmp`
 * (RAM-backed tmpfs; a marker or copied evidence bundle living only in RAM
 * would defeat the entire point of "retained, revalidatable bytes").
 *
 * Lifecycle, matching `scripts/test-accounting/authority.ts`'s `writeNew`
 * fsync-then-fsync-parent-directory discipline:
 *
 *   1. `issueAttemptMarker` — written BEFORE spawning anything, `"wx"` so a
 *      colliding attempt_id fails loudly, fsync the file then the parent dir.
 *   2. (adapter/runner spawns, runs, collects observations)
 *   3. `publishCompleteReceipt` — only after structured-output validation,
 *      retained-artifact validation, and cleanup evidence are all in hand.
 *      Atomic publish: write to a temp name in the same directory, fsync,
 *      rename, fsync the parent dir — so a reader never observes a
 *      partially-written file.
 *
 * `scanForIncompleteOrCorrupt` BLOCKS a new run (throws) on any issued-but-
 * not-completed or unparseable marker. No age check, no PID-liveness check,
 * no automatic reclamation — matching design.md's explicit rule that "age,
 * PID liveness, and a successful finally block never authorize automatic
 * reclamation." Retiring an incomplete marker requires a separate, explicit,
 * append-only recovery receipt (`recordRecoveryReceipt`) that never flips
 * the attempt to completed.
 */

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { contentDigest } from "../test-accounting/inventory.ts";
import { digestOf, isHexDigest, sha256Hex } from "./canonicalize.ts";
import { type AttemptReceipt, validateAttemptReceipt } from "./schemas.ts";

export interface EvidenceStorePolicy {
  /** Absolute, disk-backed path for the evidence root. Never under /tmp. */
  evidenceRoot: string;
  maxAttempts: number;
  maxRetainedBytes: number;
  /** Minimum days completed batch evidence must remain intact before any deletion is even considered. */
  retentionDeadlineDays: 30;
}

/**
 * Default evidence root: a repo-relative, gitignored directory, disk-backed
 * (this repo's checkout lives on real disk, never tmpfs) and OUTSIDE any
 * disposable workspace `workspace.ts` creates (those live under a separate
 * policy-declared root entirely, see workspace.ts). Kept inside the repo
 * tree (rather than e.g. `~/.tmp`) so evidence produced by a pilot batch is
 * trivially colocated with the branch/commit it was measured against, and
 * an operator reviewing the pilot never has to know a second, unrelated
 * host path.
 */
export function evidenceRoot(policy: Pick<EvidenceStorePolicy, "evidenceRoot">): string {
  return policy.evidenceRoot;
}

const ISSUED_MARKER_SCHEMA = "mutation-falsification.marker.issued/v1" as const;
interface IssuedMarker {
  attemptId: string;
  intentDigest: string;
  issuedAt: string;
  schema: typeof ISSUED_MARKER_SCHEMA;
}
const RECOVERY_RECEIPT_SCHEMA = "mutation-falsification.marker.recovery/v1" as const;
interface RecoveryReceipt {
  attemptId: string;
  disposition: "retired_incomplete";
  observations: string;
  operatorClaim: string;
  recordedAt: string;
  retainedEvidence: string[];
  schema: typeof RECOVERY_RECEIPT_SCHEMA;
}

/**
 * Strict, fail-closed validation of a parsed recovery receipt — the exact
 * gap the reviewer found: `scanForIncompleteOrCorrupt` previously only
 * checked `fileExists(recoveryPath(...))`, never parsing or validating the
 * file at all, so ANY bytes at `<attemptId>.recovery.json` — zero-length,
 * truncated JSON, wrong schema, wrong attemptId, an orphan recovery with no
 * issued marker, or a recovery filed for an attempt that was ALREADY
 * completed — silently retired the attempt. Every field the spec requires
 * (operator claim, observations, disposition, timestamp, retained evidence)
 * is checked here; `expectedAttemptId` is the filename-derived id, which
 * must equal the receipt's own claimed `attemptId` byte-for-byte.
 */
function validateRecoveryReceipt(value: unknown, expectedAttemptId: string): RecoveryReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("recovery receipt must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== RECOVERY_RECEIPT_SCHEMA) {
    throw new Error(`recovery receipt has unsupported schema: ${String(record.schema)}`);
  }
  if (typeof record.attemptId !== "string" || !UUID_PATTERN.test(record.attemptId)) {
    throw new Error("recovery receipt attemptId must be a UUID");
  }
  if (record.attemptId !== expectedAttemptId) {
    throw new Error(
      `recovery receipt attemptId ${record.attemptId} does not match its own filename-derived attemptId ${expectedAttemptId}`
    );
  }
  if (record.disposition !== "retired_incomplete") {
    throw new Error(`recovery receipt disposition must be exactly "retired_incomplete", got ${JSON.stringify(record.disposition)}`);
  }
  if (typeof record.operatorClaim !== "string" || record.operatorClaim.length === 0) {
    throw new Error("recovery receipt operatorClaim must be a non-empty string");
  }
  if (typeof record.observations !== "string" || record.observations.length === 0) {
    throw new Error("recovery receipt observations must be a non-empty string");
  }
  if (typeof record.recordedAt !== "string" || Number.isNaN(new Date(record.recordedAt).valueOf())) {
    throw new Error("recovery receipt recordedAt must be an ISO-8601 instant");
  }
  if (
    !Array.isArray(record.retainedEvidence) ||
    !record.retainedEvidence.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new Error("recovery receipt retainedEvidence must be an array of non-empty strings");
  }
  return {
    schema: RECOVERY_RECEIPT_SCHEMA,
    attemptId: record.attemptId,
    operatorClaim: record.operatorClaim,
    observations: record.observations,
    disposition: "retired_incomplete",
    retainedEvidence: record.retainedEvidence,
    recordedAt: record.recordedAt,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strict, fail-closed validation of a parsed issued marker — mirrors
 * schemas.ts's hand-rolled validator pattern (never coerce/default a
 * malformed field). `scanForIncompleteOrCorrupt` and `publishCompleteReceipt`
 * both call this rather than a bare `JSON.parse`, so a marker with the right
 * shape of JSON but a wrong schema string, non-UUID attemptId, or malformed
 * intentDigest is treated as corrupt, not silently trusted.
 */
function validateIssuedMarker(value: unknown, expectedAttemptId?: string): IssuedMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("issued marker must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== ISSUED_MARKER_SCHEMA) {
    throw new Error(`issued marker has unsupported schema: ${String(record.schema)}`);
  }
  if (typeof record.attemptId !== "string" || !UUID_PATTERN.test(record.attemptId)) {
    throw new Error("issued marker attemptId must be a UUID");
  }
  if (expectedAttemptId !== undefined && record.attemptId !== expectedAttemptId) {
    throw new Error(
      `issued marker attemptId ${record.attemptId} does not match its own filename-derived attemptId ${expectedAttemptId}`
    );
  }
  if (typeof record.intentDigest !== "string" || !isHexDigest(record.intentDigest)) {
    throw new Error("issued marker intentDigest must be a 64-character lowercase hex digest");
  }
  if (typeof record.issuedAt !== "string" || Number.isNaN(new Date(record.issuedAt).valueOf())) {
    throw new Error("issued marker issuedAt must be an ISO-8601 instant");
  }
  return {
    schema: ISSUED_MARKER_SCHEMA,
    attemptId: record.attemptId,
    intentDigest: record.intentDigest,
    issuedAt: record.issuedAt,
  };
}

function markersDir(root: string): string {
  return resolve(root, "markers");
}
function issuedPath(root: string, attemptId: string): string {
  return resolve(markersDir(root), `${attemptId}.issued.json`);
}
function completedPath(root: string, attemptId: string): string {
  return resolve(markersDir(root), `${attemptId}.completed.json`);
}
function recoveryPath(root: string, attemptId: string): string {
  return resolve(markersDir(root), `${attemptId}.recovery.json`);
}
/** The append-only, hash-chained log of every completion ever committed — see `appendCompletionChainEntry`. */
function completionChainPath(root: string): string {
  return resolve(root, "completions.chain.jsonl");
}
/** Exclusive whole-ledger lock: only one publish (or reconciling scan) may hold this at a time. */
function ledgerLockPath(root: string): string {
  return resolve(root, "completions.chain.lock");
}
/** One transaction-in-flight marker per attempt, written BEFORE either the receipt or the chain entry — see `publishCompleteReceipt`. */
function transactionPath(root: string, attemptId: string): string {
  return resolve(markersDir(root), `${attemptId}.transaction.json`);
}

const LEDGER_LOCK_MAX_WAIT_MS = 10_000;
const LEDGER_LOCK_RETRY_DELAY_MS = 20;

/**
 * Acquires the whole-ledger exclusive lock (`"wx"` create, so a second
 * concurrent holder can never silently interleave with the first), runs
 * `fn`, then always releases the lock. Only ONE publish or reconciling scan
 * may hold this lock at a time — this is what makes "validate+lock the
 * chain head, write the entry, append it" a single logical unit rather than
 * three independently-racing steps.
 *
 * A contending caller RETRIES (short backoff, bounded by
 * `LEDGER_LOCK_MAX_WAIT_MS`) rather than failing immediately — two
 * concurrent publishers for two different attempts are both legitimate
 * work, not an error condition; only a lock that is still held after the
 * full wait window is treated as evidence of a stuck/crashed holder and
 * surfaced as an error requiring explicit operator attention (never
 * automatic reclamation of someone else's lock).
 */
async function withLedgerLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = ledgerLockPath(root);
  const deadline = Date.now() + LEDGER_LOCK_MAX_WAIT_MS;
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  for (;;) {
    try {
      fd = await open(lockPath, "wx");
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `mutation-falsification evidence store: could not acquire the exclusive evidence-ledger lock within ${LEDGER_LOCK_MAX_WAIT_MS}ms — another publish or reconciling scan appears stuck (or a stale lock was left by a crash and requires explicit operator removal, never automatic reclamation)`
        );
      }
      await new Promise((r) => setTimeout(r, LEDGER_LOCK_RETRY_DELAY_MS));
    }
  }
  try {
    await fd.close();
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

/** Same fsync-file-then-fsync-parent-directory pattern as authority.ts's writeNew — "wx" so a colliding name fails loudly. */
async function writeNewFsynced(path: string, value: unknown): Promise<void> {
  const fd = await open(path, "wx");
  try {
    await fd.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await fd.sync();
  } finally {
    await fd.close();
  }
  const dirFd = await open(resolve(path, ".."), "r");
  try {
    await dirFd.sync();
  } finally {
    await dirFd.close();
  }
}

/** Writes an "issued" marker BEFORE spawning anything. Fails loudly (via `"wx"`) if the attempt_id already has one. */
export async function issueAttemptMarker(
  root: string,
  attemptId: string,
  intentPacket: { intentDigest: string }
): Promise<void> {
  await mkdir(markersDir(root), { recursive: true });
  const marker: IssuedMarker = {
    schema: ISSUED_MARKER_SCHEMA,
    attemptId,
    intentDigest: intentPacket.intentDigest,
    issuedAt: new Date().toISOString(),
  };
  await writeNewFsynced(issuedPath(root, attemptId), marker);
}

/**
 * Appends one entry to the append-only, hash-chained completion log
 * (`completions.chain.jsonl`). Each entry's `chainDigest` binds
 * `attemptId` + `intentDigest` + `receiptDigest` + the PREVIOUS entry's
 * `chainDigest` (or a fixed genesis string for the first entry), so
 * altering, reordering, or deleting any earlier entry breaks every later
 * entry's chain digest — this is what makes the log tamper-evident, not
 * merely append-only by convention. `appendFile` with `"a"`-style semantics
 * is used rather than a read-modify-write rewrite of the whole file, so two
 * concurrent appends can never silently clobber each other's line (each
 * `write(2)` of a line under 4KB is atomic on a POSIX-compliant filesystem
 * for a file opened in append mode).
 */
const COMPLETION_CHAIN_GENESIS = "mutation-falsification.completion-chain.genesis/v1";
interface CompletionChainEntry {
  attemptId: string;
  chainDigest: string;
  intentDigest: string;
  prevChainDigest: string;
  receiptDigest: string;
  recordedAt: string;
  schema: "mutation-falsification.completion-chain-entry/v1";
}

async function readCompletionChain(root: string): Promise<CompletionChainEntry[]> {
  let raw: string;
  try {
    raw = await readFile(completionChainPath(root), "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CompletionChainEntry);
}

/**
 * Recomputes and verifies every link of the chain — including, for every
 * entry, recomputing `digestOf` the CURRENT bytes of that entry's own
 * completed receipt and comparing it against `entry.receiptDigest` (never
 * just trusting that the receipt on disk still matches what was chained at
 * publish time — a schema-valid receipt rewrite that preserves attemptId
 * and intentDigest must be caught here, not silently accepted). Also
 * rejects any completed receipt with no corresponding chain entry
 * (orphaned) or any attemptId appearing in the chain more than once
 * (duplicate/forked). Throws with the first violation found. Exported so a
 * caller (or test) can independently audit the ledger, not just trust that
 * it was written correctly.
 */
export async function verifyCompletionChain(root: string): Promise<CompletionChainEntry[]> {
  const entries = await readCompletionChain(root);
  const seenAttemptIds = new Set<string>();
  let prevChainDigest = COMPLETION_CHAIN_GENESIS;
  for (const entry of entries) {
    if (seenAttemptIds.has(entry.attemptId)) {
      throw new Error(
        `mutation-falsification evidence store: completion chain has more than one entry for attempt ${entry.attemptId} — duplicate/forked chain entry`
      );
    }
    seenAttemptIds.add(entry.attemptId);
    if (entry.prevChainDigest !== prevChainDigest) {
      throw new Error(
        `mutation-falsification evidence store: completion chain broken at attempt ${entry.attemptId} — prevChainDigest does not match the preceding entry (tampered, reordered, forked, or deleted entry)`
      );
    }
    const expectedChainDigest = digestOf({
      attemptId: entry.attemptId,
      intentDigest: entry.intentDigest,
      receiptDigest: entry.receiptDigest,
      prevChainDigest: entry.prevChainDigest,
    });
    if (entry.chainDigest !== expectedChainDigest) {
      throw new Error(
        `mutation-falsification evidence store: completion chain entry for attempt ${entry.attemptId} has a chainDigest that does not match its own recomputed digest — tampered entry`
      );
    }
    let receiptRaw: string;
    try {
      receiptRaw = await readFile(completedPath(root, entry.attemptId), "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(
          `mutation-falsification evidence store: completion chain entry for attempt ${entry.attemptId} has no corresponding completed receipt on disk — orphaned chain entry`
        );
      }
      throw error;
    }
    const actualReceiptDigest = digestOf(validateAttemptReceipt(JSON.parse(receiptRaw)));
    if (actualReceiptDigest !== entry.receiptDigest) {
      throw new Error(
        `mutation-falsification evidence store: completed receipt for attempt ${entry.attemptId} does not match the chain's recorded receiptDigest — the receipt was rewritten after being chained (divergent receipt)`
      );
    }
    prevChainDigest = entry.chainDigest;
  }
  return entries;
}

/** Fsyncs the chain file's own fd, then its parent directory — same discipline as every other durability boundary in this module. */
async function appendCompletionChainEntryFsynced(root: string, entry: CompletionChainEntry): Promise<void> {
  const fd = await open(completionChainPath(root), "a");
  try {
    await fd.writeFile(`${JSON.stringify(entry)}\n`);
    await fd.sync();
  } finally {
    await fd.close();
  }
  const dirFd = await open(root, "r");
  try {
    await dirFd.sync();
  } finally {
    await dirFd.close();
  }
}

interface TransactionMarker {
  attemptId: string;
  intentDigest: string;
  phase: "started" | "receipt_committed";
  receiptDigest: string;
  schema: "mutation-falsification.completion-transaction/v1";
  startedAt: string;
}
const TRANSACTION_SCHEMA = "mutation-falsification.completion-transaction/v1" as const;

async function writeTransactionMarker(root: string, marker: TransactionMarker): Promise<void> {
  const path = transactionPath(root, marker.attemptId);
  await unlink(path).catch(() => undefined);
  const fd = await open(path, "w");
  try {
    await fd.writeFile(`${JSON.stringify(marker, null, 2)}\n`);
    await fd.sync();
  } finally {
    await fd.close();
  }
  const dirFd = await open(markersDir(root), "r");
  try {
    await dirFd.sync();
  } finally {
    await dirFd.close();
  }
}

async function finalizeTransaction(root: string, attemptId: string): Promise<void> {
  await unlink(transactionPath(root, attemptId)).catch(() => undefined);
  const dirFd = await open(markersDir(root), "r");
  try {
    await dirFd.sync();
  } finally {
    await dirFd.close();
  }
}

/**
 * Publishes a complete attempt receipt as ONE crash-honest transaction:
 * publication of the receipt and its append to the hash-chained completion
 * log either both durably land or neither is ever trusted by a later
 * reader — never a receipt with no chain entry, never a chain entry with
 * no (or a divergent) receipt. Only ever called after the caller already
 * has structured-output validation, retained-artifact validation, and
 * cleanup evidence in hand — this function does not itself perform those
 * checks, it only requires the receipt to already validate against
 * `validateAttemptReceipt` before publishing.
 *
 * Sequence, all held under the exclusive whole-ledger lock
 * (`withLedgerLock` — so two concurrent publishers can never interleave
 * their steps or select the same `prevChainDigest`):
 *
 *   1. Validate the receipt is bound to its own issued intent (as before).
 *   2. Write+fsync a transaction marker (`phase: "started"`) BEFORE either
 *      the receipt or the chain entry exists — this is the record a
 *      restart-time scan uses to detect and reconcile a half-commit.
 *   3. Write+fsync the receipt to a temp file, NO-REPLACE `link` it to its
 *      final path (fails loudly with EEXIST on a replay), fsync the
 *      markers directory.
 *   4. Advance the transaction marker to `phase: "receipt_committed"`
 *      (fsynced) — the receipt is now durable; only the chain append
 *      remains.
 *   5. Verify+recompute the current chain head under the lock, append the
 *      new entry, fsync the chain file's own fd AND its parent directory.
 *   6. Delete the transaction marker (fsynced) — only now is this attempt
 *      considered fully committed.
 *
 * A crash at any point before step 6 leaves a transaction marker behind;
 * `scanForIncompleteOrCorrupt` treats any leftover marker as blocking
 * (fail-closed) unless it can PROVE full commit (matching receipt +
 * matching chain entry), in which case it reconciles by deleting the
 * stale marker — see that function's own doc comment.
 */
export async function publishCompleteReceipt(root: string, receipt: AttemptReceipt): Promise<void> {
  validateAttemptReceipt(receipt);
  await mkdir(markersDir(root), { recursive: true });

  await withLedgerLock(root, async () => {
    let issuedMarker: IssuedMarker;
    try {
      const issuedRaw = await readFile(issuedPath(root, receipt.attemptId), "utf8");
      issuedMarker = validateIssuedMarker(JSON.parse(issuedRaw), receipt.attemptId);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(
          `mutation-falsification evidence store: refusing to publish a completion for attempt ${receipt.attemptId} — no issued marker exists for it (unknown intent, or issueAttemptMarker was never called)`
        );
      }
      throw new Error(
        `mutation-falsification evidence store: refusing to publish a completion for attempt ${receipt.attemptId} — its issued marker is corrupt/invalid: ${(error as Error).message}`
      );
    }
    if (issuedMarker.intentDigest !== receipt.intentDigest) {
      throw new Error(
        `mutation-falsification evidence store: refusing to publish attempt ${receipt.attemptId} — receipt intentDigest ${receipt.intentDigest} does not match the issued marker's intentDigest ${issuedMarker.intentDigest}`
      );
    }

    const finalPath = completedPath(root, receipt.attemptId);
    if (await fileExists(finalPath)) {
      throw new Error(
        `mutation-falsification evidence store: refusing to publish attempt ${receipt.attemptId} — a completed receipt already exists for it (replay: this attempt was already completed)`
      );
    }

    const receiptDigest = digestOf(receipt);

    await writeTransactionMarker(root, {
      schema: TRANSACTION_SCHEMA,
      attemptId: receipt.attemptId,
      intentDigest: receipt.intentDigest,
      receiptDigest,
      phase: "started",
      startedAt: new Date().toISOString(),
    });

    const tempPath = resolve(markersDir(root), `.${receipt.attemptId}.completed.json.tmp-${randomUUID()}`);
    const fd = await open(tempPath, "wx");
    try {
      await fd.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
      await fd.sync();
    } finally {
      await fd.close();
    }
    try {
      // NO-REPLACE: link(2) fails with EEXIST if finalPath already exists —
      // unlike rename(2), it can never silently replace an existing
      // completed receipt, closing a TOCTOU window between the fileExists
      // check above and the actual commit.
      await link(tempPath, finalPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        throw new Error(
          `mutation-falsification evidence store: refusing to publish attempt ${receipt.attemptId} — a completed receipt was concurrently published for it (replay detected at commit time)`
        );
      }
      throw error;
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
    const dirFd = await open(markersDir(root), "r");
    try {
      await dirFd.sync();
    } finally {
      await dirFd.close();
    }

    await writeTransactionMarker(root, {
      schema: TRANSACTION_SCHEMA,
      attemptId: receipt.attemptId,
      intentDigest: receipt.intentDigest,
      receiptDigest,
      phase: "receipt_committed",
      startedAt: new Date().toISOString(),
    });

    const existing = await verifyCompletionChain(root);
    const lastEntry = existing.at(-1);
    const prevChainDigest = lastEntry ? lastEntry.chainDigest : COMPLETION_CHAIN_GENESIS;
    const chainDigest = digestOf({ attemptId: receipt.attemptId, intentDigest: receipt.intentDigest, receiptDigest, prevChainDigest });
    const entry: CompletionChainEntry = {
      schema: "mutation-falsification.completion-chain-entry/v1",
      attemptId: receipt.attemptId,
      intentDigest: receipt.intentDigest,
      receiptDigest,
      prevChainDigest,
      chainDigest,
      recordedAt: new Date().toISOString(),
    };
    await appendCompletionChainEntryFsynced(root, entry);

    await finalizeTransaction(root, receipt.attemptId);
  });
}

export interface IncompleteOrCorruptMarker {
  attemptId: string;
  detail: string;
  reason:
    | "issued_without_completion"
    | "corrupt"
    | "orphan_completion"
    | "intent_mismatch"
    | "leftover_temp_file"
    | "half_committed_transaction"
    | "missing_chain_entry"
    | "divergent_chain_entry"
    | "duplicate_or_forked_chain_entry";
}

/**
 * Reconciles every leftover transaction marker (see `publishCompleteReceipt`)
 * against ground truth: if the marker's attemptId has BOTH a completed
 * receipt on disk AND a matching chain entry whose receiptDigest matches
 * that receipt's own recomputed digest, the transaction genuinely finished
 * (the crash happened after step 5 but before step 6 deleted the marker) —
 * this is the ONLY case reconciliation may resolve automatically, and it
 * does so by deleting the now-redundant marker. Every other case (no
 * receipt yet, receipt but no chain entry, receipt whose digest doesn't
 * match what the marker/chain claims) is a genuine half-commit and is
 * reported, never silently resolved — the caller's scan turns any non-empty
 * result into a hard block. Must run under `withLedgerLock` (mutates the
 * chain-adjacent state), so it takes the already-held lock's caller
 * responsibility on faith and only touches markers, never the lock itself.
 */
async function reconcileTransactions(root: string): Promise<IncompleteOrCorruptMarker[]> {
  const dir = markersDir(root);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const found: IncompleteOrCorruptMarker[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".transaction.json"))) {
    const attemptId = basename(entry, ".transaction.json");
    let marker: TransactionMarker;
    try {
      const raw = await readFile(resolve(dir, entry), "utf8");
      marker = JSON.parse(raw) as TransactionMarker;
      if (marker.schema !== TRANSACTION_SCHEMA || marker.attemptId !== attemptId) {
        throw new Error("transaction marker has an unexpected schema or attemptId");
      }
    } catch (error) {
      found.push({
        attemptId,
        reason: "half_committed_transaction",
        detail: `${entry} is a corrupt transaction marker: ${(error as Error).message}`,
      });
      continue;
    }
    const completedExists = await fileExists(completedPath(root, attemptId));
    if (!completedExists) {
      found.push({
        attemptId,
        reason: "half_committed_transaction",
        detail: `${entry} shows phase "${marker.phase}" but no completed receipt was ever committed for it — half-commit, requires explicit operator recovery`,
      });
      continue;
    }
    let chain: CompletionChainEntry[];
    try {
      chain = await readCompletionChain(root);
    } catch (error) {
      found.push({
        attemptId,
        reason: "half_committed_transaction",
        detail: `${entry}: could not read the completion chain to reconcile: ${(error as Error).message}`,
      });
      continue;
    }
    const chainEntry = chain.find((e) => e.attemptId === attemptId);
    if (!chainEntry) {
      found.push({
        attemptId,
        reason: "half_committed_transaction",
        detail: `${entry}: a completed receipt exists but no chain entry was ever appended for it — half-commit between receipt publication and chain append, requires explicit operator recovery`,
      });
      continue;
    }
    if (chainEntry.receiptDigest !== marker.receiptDigest) {
      found.push({
        attemptId,
        reason: "half_committed_transaction",
        detail: `${entry}: the chain entry's receiptDigest does not match this transaction's own recorded receiptDigest — requires explicit operator recovery`,
      });
      continue;
    }
    // Both the receipt and its matching chain entry exist — the crash
    // happened strictly after the durable commit, only the marker's own
    // deletion never ran. Safe to reconcile automatically.
    await finalizeTransaction(root, attemptId);
  }
  return found;
}

/**
 * Scans every issued marker AND every completed/temp file in the markers
 * directory; BLOCKS (throws) if any issued marker is incomplete, corrupt,
 * or bound to a completion with a mismatched intentDigest, OR if any
 * completed receipt has no corresponding issued marker (an "orphan
 * completion" — evidence that `publishCompleteReceipt`'s intent-binding
 * check was somehow bypassed, e.g. by a receipt file written directly
 * rather than through this module), OR if a leftover
 * `.completed.json.tmp-*` file from an interrupted publish is found. No age
 * check, no PID-liveness check — an incomplete marker only ever leaves this
 * state via an explicit `recordRecoveryReceipt` call, never automatically.
 *
 * Also, under the exclusive ledger lock: reconciles any leftover
 * transaction marker from a crashed `publishCompleteReceipt` (see
 * `reconcileTransactions`), and independently re-verifies the completion
 * chain via `verifyCompletionChain` — which itself recomputes every
 * completed receipt's canonical digest against the chain's recorded
 * `receiptDigest` and rejects orphaned/duplicate/forked entries — plus
 * confirms every completed receipt on disk has EXACTLY one corresponding
 * chain entry (a completed receipt with no chain entry is reported as
 * `missing_chain_entry`, distinct from the reconciled half-commit case
 * above, which only applies when a transaction marker is still present).
 *
 * Returns the list only when there is nothing to block on (an empty
 * array), so a caller cannot accidentally ignore a non-empty result and
 * proceed anyway.
 */
function findLeftoverTempFiles(entries: string[]): IncompleteOrCorruptMarker[] {
  return entries
    .filter((entry) => entry.includes(".completed.json.tmp-"))
    .map((entry) => ({
      attemptId: entry.split(".completed.json.tmp-")[0] ?? entry,
      reason: "leftover_temp_file" as const,
      detail: `${entry} is a leftover temp file from an interrupted publish — a completed receipt was never atomically committed for it`,
    }));
}

function findOrphanCompletions(completedAttemptIds: string[], issuedAttemptIds: Set<string>): IncompleteOrCorruptMarker[] {
  return completedAttemptIds
    .filter((attemptId) => !issuedAttemptIds.has(attemptId))
    .map((attemptId) => ({
      attemptId,
      reason: "orphan_completion" as const,
      detail: `${attemptId}.completed.json has no corresponding issued marker — a completion must always be bound to an issued intent`,
    }));
}

/**
 * Independently re-verifies the chain: `verifyCompletionChain` itself
 * recomputes every chained receipt's digest against `entry.receiptDigest`
 * and rejects orphaned/duplicate/forked entries — a thrown error here means
 * the ledger itself is inconsistent, reported as one entry (rather than
 * parsed apart) since `verifyCompletionChain` already names the exact
 * attemptId. Additionally flags any completed receipt on disk with no
 * corresponding chain entry at all (`missing_chain_entry`), which
 * `verifyCompletionChain` itself has no way to see (it only walks the
 * chain, never the markers directory).
 */
async function findChainInconsistencies(root: string, completedAttemptIds: string[]): Promise<IncompleteOrCorruptMarker[]> {
  let chainAttemptIds: Set<string>;
  try {
    const chain = await verifyCompletionChain(root);
    chainAttemptIds = new Set(chain.map((e) => e.attemptId));
  } catch (error) {
    return [{ attemptId: "completions.chain.jsonl", reason: "divergent_chain_entry", detail: (error as Error).message }];
  }
  return completedAttemptIds
    .filter((attemptId) => !chainAttemptIds.has(attemptId))
    .map((attemptId) => ({
      attemptId,
      reason: "missing_chain_entry" as const,
      detail: `${attemptId}.completed.json has no corresponding completion-chain entry`,
    }));
}

/** True only if `attemptId` has a recovery receipt that both parses AND passes full `validateRecoveryReceipt` validation — never merely "a file exists at that path". */
async function hasValidRecoveryReceipt(root: string, attemptId: string): Promise<boolean> {
  try {
    const raw = await readFile(recoveryPath(root, attemptId), "utf8");
    validateRecoveryReceipt(JSON.parse(raw), attemptId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates every `*.recovery.json` and `*.recovery.json.tmp-*` file found
 * in the markers directory — the reviewer's exact fail-open scenario:
 * `if (recoveryExists) continue` never parsed the file at all, so zero-byte,
 * truncated, wrong-schema, or wrong-attemptId bytes at that path silently
 * retired an incomplete attempt. Blocks on:
 *
 *   - a corrupt/malformed recovery file (zero-byte, truncated JSON, wrong
 *     schema, wrong attemptId, missing/invalid fields — all funneled
 *     through `validateRecoveryReceipt`);
 *   - an "orphan" recovery — no corresponding issued marker for its
 *     attemptId, so there is nothing to retire in the first place;
 *   - "recovery after completion" — a completed receipt ALSO exists for
 *     the same attemptId, so the attempt was never actually incomplete;
 *   - a duplicate recovery — more than one recovery file resolves to the
 *     same attemptId (only possible via direct filesystem tampering, since
 *     `writeNewFsynced`'s `"wx"` already refuses a second write through
 *     `recordRecoveryReceipt` itself);
 *   - a leftover `*.recovery.json.tmp-*` file from an interrupted publish.
 */
async function findRecoveryProblems(root: string, dir: string, entries: string[], issuedAttemptIds: Set<string>): Promise<IncompleteOrCorruptMarker[]> {
  const found: IncompleteOrCorruptMarker[] = [];
  for (const entry of entries.filter((name) => name.includes(".recovery.json.tmp-"))) {
    found.push({
      attemptId: entry.split(".recovery.json.tmp-")[0] ?? entry,
      reason: "leftover_temp_file",
      detail: `${entry} is a leftover temp file from an interrupted recovery-receipt publish`,
    });
  }
  const recoveryEntries = entries.filter((name) => name.endsWith(".recovery.json"));
  const seenAttemptIds = new Set<string>();
  for (const entry of recoveryEntries) {
    const attemptId = basename(entry, ".recovery.json");
    if (seenAttemptIds.has(attemptId)) {
      found.push({ attemptId, reason: "corrupt", detail: `duplicate recovery receipt for attempt ${attemptId}` });
      continue;
    }
    seenAttemptIds.add(attemptId);
    let receipt: RecoveryReceipt;
    try {
      const raw = await readFile(resolve(dir, entry), "utf8");
      receipt = validateRecoveryReceipt(JSON.parse(raw), attemptId);
    } catch (error) {
      found.push({ attemptId, reason: "corrupt", detail: `${entry} failed validation: ${(error as Error).message}` });
      continue;
    }
    if (!issuedAttemptIds.has(receipt.attemptId)) {
      found.push({
        attemptId,
        reason: "orphan_completion",
        detail: `${entry} has no corresponding issued marker — an orphan recovery receipt`,
      });
      continue;
    }
    if (await fileExists(completedPath(root, attemptId))) {
      found.push({
        attemptId,
        reason: "intent_mismatch",
        detail: `${entry} claims to retire attempt ${attemptId}, but a completed receipt also exists for it — recovery-after-completion is never valid`,
      });
    }
  }
  return found;
}

/** Validates every issued marker: corrupt marker, retired-by-recovery (skipped, not incomplete), issued-without-completion, corrupt completion, or an intent mismatch against its own completed receipt. */
async function findIssuedMarkerProblems(root: string, dir: string, issuedEntries: string[]): Promise<IncompleteOrCorruptMarker[]> {
  const found: IncompleteOrCorruptMarker[] = [];
  for (const entry of issuedEntries) {
    const attemptId = basename(entry, ".issued.json");
    let issuedMarker: IssuedMarker;
    try {
      const issuedRaw = await readFile(resolve(dir, entry), "utf8");
      issuedMarker = validateIssuedMarker(JSON.parse(issuedRaw), attemptId);
    } catch (error) {
      found.push({ attemptId, reason: "corrupt", detail: `${entry} is malformed: ${(error as Error).message}` });
      continue;
    }
    // Retired-by-recovery markers are not "incomplete" — they are an
    // explicit, separately recorded operator disposition, not a silently
    // completed attempt (recordRecoveryReceipt never writes a `.completed`
    // file; a recovery receipt's own VALIDITY is checked separately by
    // `findRecoveryProblems` — this only needs to know whether a genuinely
    // valid one exists, never merely whether a file of that name exists).
    if (await hasValidRecoveryReceipt(root, attemptId)) {
      continue;
    }
    if (!(await fileExists(completedPath(root, attemptId)))) {
      found.push({ attemptId, reason: "issued_without_completion", detail: `${entry} has no completed receipt` });
      continue;
    }
    let completedReceipt: AttemptReceipt;
    try {
      const completedRaw = await readFile(completedPath(root, attemptId), "utf8");
      completedReceipt = validateAttemptReceipt(JSON.parse(completedRaw));
    } catch (error) {
      found.push({
        attemptId,
        reason: "corrupt",
        detail: `completed receipt for ${attemptId} failed to validate: ${(error as Error).message}`,
      });
      continue;
    }
    if (completedReceipt.intentDigest !== issuedMarker.intentDigest) {
      found.push({
        attemptId,
        reason: "intent_mismatch",
        detail: `completed receipt intentDigest ${completedReceipt.intentDigest} does not match issued marker intentDigest ${issuedMarker.intentDigest}`,
      });
    }
  }
  return found;
}

export async function scanForIncompleteOrCorrupt(root: string): Promise<IncompleteOrCorruptMarker[]> {
  const dir = markersDir(root);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const found: IncompleteOrCorruptMarker[] = await withLedgerLock(root, () => reconcileTransactions(root));
  const issuedAttemptIds = new Set(
    entries.filter((name) => name.endsWith(".issued.json")).map((name) => basename(name, ".issued.json"))
  );
  const completedAttemptIds = entries
    .filter((name) => name.endsWith(".completed.json"))
    .map((name) => basename(name, ".completed.json"));

  found.push(...findLeftoverTempFiles(entries));
  found.push(...findOrphanCompletions(completedAttemptIds, issuedAttemptIds));
  found.push(...(await findChainInconsistencies(root, completedAttemptIds)));
  found.push(...(await findRecoveryProblems(root, dir, entries, issuedAttemptIds)));
  found.push(...(await findIssuedMarkerProblems(root, dir, entries.filter((name) => name.endsWith(".issued.json")))));

  if (found.length > 0) {
    throw new Error(
      `mutation-falsification evidence store: ${found.length} incomplete or corrupt marker(s) block execution — explicit operator review required: ${JSON.stringify(found)}`
    );
  }
  return found;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Records an explicit, append-only recovery receipt for operator-supervised
 * retirement of an incomplete marker. This function NEVER writes to the
 * `.completed.json` path or schema `publishCompleteReceipt` uses — by
 * construction, retiring an incomplete attempt can never make it look
 * completed. A reader that only ever consults `completedPath` (e.g. any
 * caller reading published attempt receipts) will never see this attempt
 * become completed via this path.
 *
 * STAGED, fsynced, NO-REPLACE publication — same discipline as
 * `publishCompleteReceipt`'s own commit: write+fsync a temp file first,
 * then NO-REPLACE `link` it to the final path (fails loudly with EEXIST on
 * a second recovery for the same attemptId, rather than a bare `"wx"`
 * create on the final path directly, which — unlike `link` from an
 * already-fsynced temp file — would let a concurrent reader observe a
 * partially-written file mid-write), then fsync the markers directory.
 */
export async function recordRecoveryReceipt(
  root: string,
  attemptId: string,
  operatorClaim: string,
  observations: string,
  disposition: "retired_incomplete" = "retired_incomplete"
): Promise<void> {
  await mkdir(markersDir(root), { recursive: true });
  const receipt: RecoveryReceipt = {
    schema: RECOVERY_RECEIPT_SCHEMA,
    attemptId,
    operatorClaim,
    observations,
    disposition,
    retainedEvidence: [],
    recordedAt: new Date().toISOString(),
  };
  const finalPath = recoveryPath(root, attemptId);
  const tempPath = resolve(markersDir(root), `.${attemptId}.recovery.json.tmp-${randomUUID()}`);
  const fd = await open(tempPath, "wx");
  try {
    await fd.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
    await fd.sync();
  } finally {
    await fd.close();
  }
  try {
    await link(tempPath, finalPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      throw new Error(
        `mutation-falsification evidence store: refusing to record a recovery receipt for attempt ${attemptId} — one already exists for it`
      );
    }
    throw error;
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
  const dirFd = await open(markersDir(root), "r");
  try {
    await dirFd.sync();
  } finally {
    await dirFd.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Test-accounting bundle copy + revalidation
// ─────────────────────────────────────────────────────────────────────────

export interface RetainedAccountingArtifact {
  byteSize: number;
  relativePath: string;
  sha256: string;
}

const ACCOUNTING_BUNDLE_SUFFIXES = ["authority.json", "transcript", "completion.json", "receipt.json"] as const;

/**
 * Copies the 4 accounting files for `runId` out of the test-accounting
 * authority's run directory into `<evidenceRoot>/accounting/<attemptId>/`,
 * then re-reads the COPIES and re-verifies the receipt's own
 * `authority_sha256`/`completion_sha256`/`transcript_sha256` fields against
 * freshly computed digests of those copied bytes — never the originals —
 * so a copy corrupted in transit is caught here, not discovered later by a
 * reader trusting the copy blindly. Throws on any mismatch. Returns the
 * relative paths/sizes/digests to embed in the attempt receipt's
 * evidenceArtifacts.
 */
export async function copyAndRevalidateAccountingBundle(
  root: string,
  attemptId: string,
  accountingRunDir: string,
  runId: string
): Promise<RetainedAccountingArtifact[]> {
  const targetDir = resolve(root, "accounting", attemptId);
  await mkdir(targetDir, { recursive: true });
  const { copyFile } = await import("node:fs/promises");
  const artifacts: RetainedAccountingArtifact[] = [];
  const copiedBySuffix = new Map<string, { bytes: Buffer; relativePath: string }>();
  for (const suffix of ACCOUNTING_BUNDLE_SUFFIXES) {
    const sourcePath = resolve(accountingRunDir, `${runId}.${suffix}`);
    const destName = `${runId}.${suffix}`;
    const destPath = resolve(targetDir, destName);
    await copyFile(sourcePath, destPath);
    const bytes = await readFile(destPath);
    const relativePath = `accounting/${attemptId}/${destName}`;
    copiedBySuffix.set(suffix, { bytes, relativePath });
    artifacts.push({ relativePath, byteSize: bytes.length, sha256: sha256Hex(bytes) });
  }
  const receiptCopy = copiedBySuffix.get("receipt.json");
  const authorityCopy = copiedBySuffix.get("authority.json");
  const completionCopy = copiedBySuffix.get("completion.json");
  const transcriptCopy = copiedBySuffix.get("transcript");
  if (!receiptCopy || !authorityCopy || !completionCopy || !transcriptCopy) {
    throw new Error("copyAndRevalidateAccountingBundle: expected all 4 accounting bundle files to be copied");
  }
  const receipt = JSON.parse(receiptCopy.bytes.toString("utf8")) as {
    authority_sha256?: string;
    completion_sha256?: string;
    transcript_sha256?: string;
  };
  const checks: Array<[string, string | undefined, string]> = [
    ["authority_sha256", receipt.authority_sha256, contentDigest(authorityCopy.bytes)],
    ["completion_sha256", receipt.completion_sha256, contentDigest(completionCopy.bytes)],
    ["transcript_sha256", receipt.transcript_sha256, contentDigest(transcriptCopy.bytes)],
  ];
  for (const [field, expected, actual] of checks) {
    if (expected !== actual) {
      throw new Error(
        `copyAndRevalidateAccountingBundle: copied ${field} does not match the receipt's recorded digest for run ${runId} — copy is invalid evidence`
      );
    }
  }
  return artifacts;
}

// ─────────────────────────────────────────────────────────────────────────
// Retention budget
// ─────────────────────────────────────────────────────────────────────────

/**
 * Throws BEFORE accepting a new attempt if it would exceed the declared
 * retained-byte or attempt-count budget. NEVER evicts existing evidence to
 * make room — design.md: policy "reserves that capacity without deleting
 * prior evidence."
 */
export async function checkBudget(policy: EvidenceStorePolicy, plannedBytes: number): Promise<void> {
  const root = policy.evidenceRoot;
  const currentBytes = await directorySize(root);
  const currentAttempts = await countCompletedAttempts(root);
  if (currentBytes + plannedBytes > policy.maxRetainedBytes) {
    throw new Error(
      `mutation-falsification evidence store: accepting this attempt (${plannedBytes} bytes) would exceed the retained-byte budget (${policy.maxRetainedBytes}); current usage ${currentBytes} bytes. Refusing rather than evicting prior evidence.`
    );
  }
  if (currentAttempts + 1 > policy.maxAttempts) {
    throw new Error(
      `mutation-falsification evidence store: accepting this attempt would exceed the attempt-count budget (${policy.maxAttempts}); ${currentAttempts} attempts already retained. Refusing rather than evicting prior evidence.`
    );
  }
}

async function countCompletedAttempts(root: string): Promise<number> {
  const dir = markersDir(root);
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith(".completed.json")).length;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true } as { recursive: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(root, entry);
    try {
      const info = await stat(path);
      if (info.isFile()) {
        total += info.size;
      }
    } catch {
      // A file that vanished mid-scan (e.g. a temp rename target) contributes
      // nothing; this is a best-effort observation, not an authority.
    }
  }
  return total;
}

/** Reads the published attempt receipt for `attemptId`, or throws if it does not exist / does not validate. */
export async function readCompletedReceipt(root: string, attemptId: string): Promise<AttemptReceipt> {
  const raw = await readFile(completedPath(root, attemptId), "utf8");
  return validateAttemptReceipt(JSON.parse(raw));
}

/** True if `attemptId` has a published, validating completed receipt (used by tests to assert recovery never flips disposition). */
export async function isAttemptCompleted(root: string, attemptId: string): Promise<boolean> {
  try {
    await readCompletedReceipt(root, attemptId);
    return true;
  } catch {
    return false;
  }
}

/** Digest of an intent packet, used as the marker's binding reference — re-exported for callers that only import from evidence-store.ts. */
export function intentDigestOf(intentFields: unknown): string {
  return digestOf(intentFields);
}
