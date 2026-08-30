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
import { mkdir, open, readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { contentDigest } from "../test-accounting/inventory.ts";
import { digestOf, sha256Hex } from "./canonicalize.ts";
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

interface IssuedMarker {
  attemptId: string;
  intentDigest: string;
  issuedAt: string;
  schema: "mutation-falsification.marker.issued/v1";
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
    schema: "mutation-falsification.marker.issued/v1",
    attemptId,
    intentDigest: intentPacket.intentDigest,
    issuedAt: new Date().toISOString(),
  };
  await writeNewFsynced(issuedPath(root, attemptId), marker);
}

/**
 * Publishes a complete attempt receipt. Only ever called after the caller
 * already has structured-output validation, retained-artifact validation,
 * and cleanup evidence in hand — this function does not itself perform
 * those checks, it only requires the receipt to already validate against
 * `validateAttemptReceipt` before publishing.
 *
 * Atomic: write to a temp name in the SAME directory (so `rename` is an
 * atomic same-filesystem operation), fsync the temp file, rename it into
 * place, then fsync the parent directory — so a reader (including
 * `scanForIncompleteOrCorrupt`) never observes a partially-written file.
 */
export async function publishCompleteReceipt(root: string, receipt: AttemptReceipt): Promise<void> {
  validateAttemptReceipt(receipt);
  await mkdir(markersDir(root), { recursive: true });
  const finalPath = completedPath(root, receipt.attemptId);
  const tempPath = resolve(markersDir(root), `.${receipt.attemptId}.completed.json.tmp-${randomUUID()}`);
  const fd = await open(tempPath, "wx");
  try {
    await fd.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(tempPath, finalPath);
  const dirFd = await open(markersDir(root), "r");
  try {
    await dirFd.sync();
  } finally {
    await dirFd.close();
  }
}

export interface IncompleteOrCorruptMarker {
  attemptId: string;
  detail: string;
  reason: "issued_without_completion" | "corrupt";
}

/**
 * Scans every issued marker; BLOCKS (throws) if any is issued-but-not-
 * completed, or fails to parse/validate. No age check, no PID-liveness
 * check — an incomplete marker only ever leaves this state via an explicit
 * `recordRecoveryReceipt` call, never automatically. Returns the list only
 * when there is nothing to block on (an empty array), so a caller cannot
 * accidentally ignore a non-empty result and proceed anyway.
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
  for (const entry of entries.filter((name) => name.endsWith(".issued.json"))) {
    const attemptId = basename(entry, ".issued.json");
    let issuedRaw: string;
    try {
      issuedRaw = await readFile(resolve(dir, entry), "utf8");
      JSON.parse(issuedRaw);
    } catch {
      found.push({ attemptId, reason: "corrupt", detail: `${entry} could not be parsed as JSON` });
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
    try {
      const completedRaw = await readFile(completedPath(root, attemptId), "utf8");
      validateAttemptReceipt(JSON.parse(completedRaw));
    } catch (error) {
      found.push({
        attemptId,
        reason: "corrupt",
        detail: `completed receipt for ${attemptId} failed to validate: ${(error as Error).message}`,
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
