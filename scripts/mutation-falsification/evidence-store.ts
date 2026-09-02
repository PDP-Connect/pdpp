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
import { appendFile, link, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
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
interface RecoveryReceipt {
  attemptId: string;
  disposition: "retired_incomplete";
  observations: string;
  operatorClaim: string;
  recordedAt: string;
  retainedEvidence: string[];
  schema: "mutation-falsification.marker.recovery/v1";
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

/** Recomputes and verifies every link of the chain; throws with the first broken/tampered entry's attemptId. Exported so a caller (or test) can independently audit the ledger, not just trust that it was written correctly. */
export async function verifyCompletionChain(root: string): Promise<CompletionChainEntry[]> {
  const entries = await readCompletionChain(root);
  let prevChainDigest = COMPLETION_CHAIN_GENESIS;
  for (const entry of entries) {
    if (entry.prevChainDigest !== prevChainDigest) {
      throw new Error(
        `mutation-falsification evidence store: completion chain broken at attempt ${entry.attemptId} — prevChainDigest does not match the preceding entry (tampered, reordered, or deleted entry)`
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
    prevChainDigest = entry.chainDigest;
  }
  return entries;
}

async function appendCompletionChainEntry(
  root: string,
  attemptId: string,
  intentDigest: string,
  receiptDigest: string
): Promise<void> {
  const existing = await verifyCompletionChain(root);
  const prevChainDigest = existing.length > 0 ? existing[existing.length - 1]!.chainDigest : COMPLETION_CHAIN_GENESIS;
  const chainDigest = digestOf({ attemptId, intentDigest, receiptDigest, prevChainDigest });
  const entry: CompletionChainEntry = {
    schema: "mutation-falsification.completion-chain-entry/v1",
    attemptId,
    intentDigest,
    receiptDigest,
    prevChainDigest,
    chainDigest,
    recordedAt: new Date().toISOString(),
  };
  await appendFile(completionChainPath(root), `${JSON.stringify(entry)}\n`, { flag: "a" });
}

/**
 * Publishes a complete attempt receipt. Only ever called after the caller
 * already has structured-output validation, retained-artifact validation,
 * and cleanup evidence in hand — this function does not itself perform
 * those checks, it only requires the receipt to already validate against
 * `validateAttemptReceipt` before publishing.
 *
 * Bound to the issued intent: the receipt's `intentDigest` must exactly
 * match the `intentDigest` recorded on this `attemptId`'s own issued marker
 * — an attempt with no issued marker (unknown attemptId), or a receipt
 * whose `intentDigest` diverges from what was actually issued, is rejected
 * before anything is written. This closes the gap where a completion could
 * previously be published without ever having been bound to the intent it
 * claims to satisfy.
 *
 * NO-REPLACE commit: the final path is created via `link` (hard link) from
 * a temp file rather than `rename`-over — `link` fails with `EEXIST` if the
 * final path already exists, so a second publish attempt for the same
 * `attemptId` (a replay, whether accidental re-run or an adversarial
 * resubmission) can never silently overwrite an already-completed receipt.
 * The temp file is fsynced before `link`, then unlinked (its job — holding
 * the fully-written bytes for the atomic `link` — is done); the parent
 * directory is fsynced last, matching the discipline the previous
 * rename-based implementation already had, just without the "replace an
 * existing entry" capability `rename` silently permits.
 *
 * Every accepted publish appends one entry to the hash-chained completion
 * log (`completions.chain.jsonl`) binding this attemptId + intentDigest +
 * a digest of the receipt itself to the chain — see
 * `appendCompletionChainEntry`/`verifyCompletionChain`.
 */
export async function publishCompleteReceipt(root: string, receipt: AttemptReceipt): Promise<void> {
  validateAttemptReceipt(receipt);
  await mkdir(markersDir(root), { recursive: true });

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

  await appendCompletionChainEntry(root, receipt.attemptId, receipt.intentDigest, digestOf(receipt));
}

export interface IncompleteOrCorruptMarker {
  attemptId: string;
  detail: string;
  reason: "issued_without_completion" | "corrupt" | "orphan_completion" | "intent_mismatch" | "leftover_temp_file";
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
 * Returns the list only when there is nothing to block on (an empty
 * array), so a caller cannot accidentally ignore a non-empty result and
 * proceed anyway.
 */
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
  const found: IncompleteOrCorruptMarker[] = [];
  const issuedAttemptIds = new Set(
    entries.filter((name) => name.endsWith(".issued.json")).map((name) => basename(name, ".issued.json"))
  );

  for (const entry of entries) {
    if (entry.includes(".completed.json.tmp-")) {
      found.push({
        attemptId: entry.split(".completed.json.tmp-")[0] ?? entry,
        reason: "leftover_temp_file",
        detail: `${entry} is a leftover temp file from an interrupted publish — a completed receipt was never atomically committed for it`,
      });
    }
  }

  for (const entry of entries.filter((name) => name.endsWith(".completed.json"))) {
    const attemptId = basename(entry, ".completed.json");
    if (!issuedAttemptIds.has(attemptId)) {
      found.push({
        attemptId,
        reason: "orphan_completion",
        detail: `${entry} has no corresponding issued marker — a completion must always be bound to an issued intent`,
      });
    }
  }

  for (const entry of entries.filter((name) => name.endsWith(".issued.json"))) {
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
    // file; a recovery receipt is checked for on its own, distinct path).
    const recoveryExists = await fileExists(recoveryPath(root, attemptId));
    if (recoveryExists) {
      continue;
    }
    const completedExists = await fileExists(completedPath(root, attemptId));
    if (!completedExists) {
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
    schema: "mutation-falsification.marker.recovery/v1",
    attemptId,
    operatorClaim,
    observations,
    disposition,
    retainedEvidence: [],
    recordedAt: new Date().toISOString(),
  };
  await writeNewFsynced(recoveryPath(root, attemptId), receipt);
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
