// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, opendir, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

export const SCRATCH_SCHEMA = "pdpp.test-scratch/v1";
const MARKER_NAME = ".pdpp-test-scratch.json";
const REQUIRED_DIRECTORY_MODE = 0o700;
const MARKER_MODE = 0o600;
const RECOVERY_GRACE_MS = 60_000;
const NONCE_LENGTH = 48;
const NONCE = /^[a-f0-9]{48}$/;
const JOURNAL_PREFIX = ".scratch-cleanup-";
const RECOVERY_CURSOR_NAME = ".scratch-recovery-cursor.json";
const RECOVERY_CURSOR_SCHEMA = "pdpp.test-scratch/recovery-cursor/v1";
const LINUX_BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type MarkerState = "allocated" | "launching" | "running";

interface Marker {
  boot_id?: string;
  created_at: string;
  dev: number;
  ino: number;
  nonce: string;
  owner_pid: number;
  parent: string;
  pgid?: number;
  root: string;
  schema: typeof SCRATCH_SCHEMA;
  state: MarkerState;
}

interface CleanupJournal {
  marker: Marker;
  nonce: string;
  parent: string;
  quarantine: string;
  root: string;
  schema: typeof SCRATCH_SCHEMA;
  state: "quarantining";
}

/**
 * Scheduling metadata only. It selects where the next bounded lexical scan
 * begins; it is never an ownership capability or a deletion authority.
 */
interface RecoveryCursor {
  after: string;
  schema: typeof RECOVERY_CURSOR_SCHEMA;
}

interface Allocation {
  canonicalParent: string;
  dev: number;
  ino: number;
  markerPath: string;
  nonce: string;
  root: string;
}

export interface ScratchOwnership {
  allocation: Allocation;
  env: NodeJS.ProcessEnv;
}

export interface RecoveryResult {
  path: string;
  reason: string;
  removed: boolean;
}

export interface RecoveryLimits {
  maxInspectedEntries: number;
  maxRemovalAttempts: number;
  maxStateTransitions: number;
}

export const DEFAULT_RECOVERY_LIMITS: Readonly<RecoveryLimits> = {
  maxInspectedEntries: 64,
  maxRemovalAttempts: 8,
  maxStateTransitions: 16,
};

export interface RecoveryHooks {
  onInspect?: (path: string) => void;
  onRemovalAttempt?: (path: string) => void;
  onStateTransition?: (path: string) => void;
}

export interface CleanupHooks {
  afterJournal?: () => Promise<void>;
  afterRename?: () => Promise<void>;
}

export class ScratchOwnershipError extends Error {
  readonly reason: string;

  constructor(reason: string, message = reason) {
    super(message);
    this.reason = reason;
    this.name = "ScratchOwnershipError";
  }
}

function modeOf(stats: Awaited<ReturnType<typeof lstat>>): number {
  return Number(stats.mode) % 0o1000;
}

function isOwnedPrivateDirectory(stats: Awaited<ReturnType<typeof lstat>>): boolean {
  return (
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    stats.uid === userInfo().uid &&
    modeOf(stats) === REQUIRED_DIRECTORY_MODE
  );
}

function isOwnedPrivateFile(stats: Awaited<ReturnType<typeof lstat>>): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.uid === userInfo().uid && modeOf(stats) === MARKER_MODE;
}

/** Return a stable recovery reason without following an untrusted candidate. */
export function scratchCandidateSafetyReason(
  stats: Awaited<ReturnType<typeof lstat>>,
  expectedUid = userInfo().uid
): string | undefined {
  const safetyChecks: ReadonlyArray<readonly [boolean, string]> = [
    [stats.isSymbolicLink(), "symlink"],
    [!stats.isDirectory(), "invalid-root"],
    [stats.uid !== expectedUid, "wrong-owner"],
    [modeOf(stats) !== REQUIRED_DIRECTORY_MODE, "wrong-mode"],
  ];
  const failedCheck = safetyChecks.find(([failed]) => failed);
  return failedCheck?.[1];
}

async function linuxBootId(): Promise<string | null> {
  if (platform() !== "linux") {
    return null;
  }
  try {
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return LINUX_BOOT_ID.test(bootId) ? bootId : null;
  } catch {
    // Boot identity is unavailable on nonstandard Linux hosts; recovery retains ambiguity.
    return null;
  }
}

function defaultParent(): string {
  const runnerTemp = process.env.RUNNER_TEMP;
  return runnerTemp ? join(runnerTemp, "pdpp-test-scratch") : join(homedir(), ".tmp", "pdpp-test-scratch");
}

async function validatedParent(parent = defaultParent()): Promise<string> {
  await mkdir(parent, { mode: REQUIRED_DIRECTORY_MODE, recursive: true });
  await chmod(parent, REQUIRED_DIRECTORY_MODE);
  const canonicalParent = await realpath(parent);
  const parentStats = await lstat(canonicalParent);
  if (!isOwnedPrivateDirectory(parentStats)) {
    throw new ScratchOwnershipError(
      "invalid-parent",
      `test scratch parent is not a private directory: ${canonicalParent}`
    );
  }
  return canonicalParent;
}

async function writeExclusiveMarker(markerPath: string, marker: Marker): Promise<void> {
  await writeExclusiveJson(markerPath, marker);
}

async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, "r");
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}

async function writeExclusiveJson(path: string, value: unknown): Promise<void> {
  const fd = await open(path, "wx", MARKER_MODE);
  try {
    await fd.writeFile(`${JSON.stringify(value)}\n`);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await syncDirectory(dirname(path));
}

async function replaceMarker(markerPath: string, marker: Marker): Promise<void> {
  await replaceJson(markerPath, marker);
}

async function replaceJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}`;
  try {
    await writeExclusiveJson(temporary, value);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function ownedEnvironment(allocation: Allocation): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TMPDIR: allocation.root,
    TMP: allocation.root,
    TEMP: allocation.root,
    TEST_TMPDIR: allocation.root,
    PDPP_TEST_SCRATCH_ROOT: allocation.root,
    PDPP_TEST_SCRATCH_SCHEMA: SCRATCH_SCHEMA,
    PDPP_TEST_SCRATCH_MARKER: allocation.markerPath,
    PDPP_TEST_SCRATCH_NONCE: allocation.nonce,
    PDPP_TEST_SCRATCH_OWNER_PID: String(process.pid),
  };
}

/** Allocate one opaque root; cleanup accepts only this closed-over capability. */
export async function allocateScratchOwnership(options: { parent?: string } = {}): Promise<ScratchOwnership> {
  const canonicalParent = await validatedParent(options.parent);
  const root = await mkdtemp(join(canonicalParent, "run-"));
  const rootStats = await lstat(root);
  if (!isOwnedPrivateDirectory(rootStats)) {
    throw new ScratchOwnershipError("invalid-root", `test scratch root is not a private directory: ${root}`);
  }
  const canonicalRoot = await realpath(root);
  if (dirname(canonicalRoot) !== canonicalParent || !basename(canonicalRoot).startsWith("run-")) {
    throw new ScratchOwnershipError("invalid-root", `test scratch root escaped its parent: ${canonicalRoot}`);
  }
  const allocation: Allocation = {
    canonicalParent,
    dev: rootStats.dev,
    ino: rootStats.ino,
    markerPath: join(canonicalRoot, MARKER_NAME),
    nonce: randomBytes(24).toString("hex"),
    root: canonicalRoot,
  };
  const bootId = await linuxBootId();
  const marker: Marker = {
    created_at: new Date().toISOString(),
    dev: allocation.dev,
    ino: allocation.ino,
    nonce: allocation.nonce,
    owner_pid: process.pid,
    parent: canonicalParent,
    root: canonicalRoot,
    schema: SCRATCH_SCHEMA,
    state: "allocated",
  };
  if (bootId !== null) {
    marker.boot_id = bootId;
  }
  await writeExclusiveMarker(allocation.markerPath, marker);
  return { allocation, env: ownedEnvironment(allocation) };
}

export async function markScratchRunning(ownership: ScratchOwnership, pgid: number): Promise<void> {
  const marker = await readMarker(ownership.allocation.markerPath);
  if (!marker || marker.nonce !== ownership.allocation.nonce || marker.state !== "launching") {
    throw new ScratchOwnershipError("marker-mismatch");
  }
  await replaceMarker(ownership.allocation.markerPath, { ...marker, pgid, state: "running" });
}

/** Persist the ambiguous pre-spawn handoff before creating a child process. */
export async function markScratchLaunching(ownership: ScratchOwnership): Promise<void> {
  const marker = await readMarker(ownership.allocation.markerPath);
  if (!marker || marker.nonce !== ownership.allocation.nonce || marker.state !== "allocated") {
    throw new ScratchOwnershipError("marker-mismatch");
  }
  await replaceMarker(ownership.allocation.markerPath, { ...marker, state: "launching" });
}

/** Only the live owner may prove that a launch was never attempted. */
export async function markScratchUnlaunched(ownership: ScratchOwnership): Promise<void> {
  const marker = await readMarker(ownership.allocation.markerPath);
  if (!marker || marker.nonce !== ownership.allocation.nonce || marker.state !== "launching") {
    throw new ScratchOwnershipError("marker-mismatch");
  }
  await replaceMarker(ownership.allocation.markerPath, { ...marker, state: "allocated" });
}

async function readMarker(markerPath: string): Promise<Marker | null> {
  try {
    if (!isOwnedPrivateFile(await lstat(markerPath))) {
      return null;
    }
    const value: unknown = JSON.parse(await readFile(markerPath, "utf8"));
    return isValidMarker(value) ? value : null;
  } catch {
    // A malformed marker is deliberately indistinguishable from an unreadable one.
    return null;
  }
}

function isValidMarker(value: unknown): value is Marker {
  if (!value || typeof value !== "object") {
    return false;
  }
  const marker = value as Partial<Marker>;
  return !(
    marker.schema !== SCRATCH_SCHEMA ||
    (marker.state !== "allocated" && marker.state !== "launching" && marker.state !== "running") ||
    typeof marker.nonce !== "string" ||
    marker.nonce.length !== NONCE_LENGTH ||
    !NONCE.test(marker.nonce) ||
    typeof marker.root !== "string" ||
    typeof marker.parent !== "string" ||
    typeof marker.owner_pid !== "number" ||
    !Number.isSafeInteger(marker.owner_pid) ||
    marker.owner_pid <= 0 ||
    typeof marker.dev !== "number" ||
    !Number.isSafeInteger(marker.dev) ||
    marker.dev < 0 ||
    typeof marker.ino !== "number" ||
    !Number.isSafeInteger(marker.ino) ||
    marker.ino < 0 ||
    typeof marker.created_at !== "string" ||
    (marker.boot_id !== undefined && (typeof marker.boot_id !== "string" || !LINUX_BOOT_ID.test(marker.boot_id)))
  );
}

async function matchesAllocation(allocation: Allocation): Promise<boolean> {
  try {
    const rootStats = await lstat(allocation.root);
    return (
      isOwnedPrivateDirectory(rootStats) &&
      rootStats.dev === allocation.dev &&
      rootStats.ino === allocation.ino &&
      isImmediateRunChild(allocation.canonicalParent, allocation.root)
    );
  } catch {
    return false;
  }
}

function isImmediateChild(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath !== "" && !isAbsolute(relativePath) && !relativePath.startsWith("..") && dirname(candidate) === parent
  );
}

function isImmediateRunChild(parent: string, candidate: string): boolean {
  return isImmediateChild(parent, candidate) && basename(candidate).startsWith("run-");
}

function quarantinePath(parent: string, nonce: string): string {
  if (!NONCE.test(nonce)) {
    throw new ScratchOwnershipError("invalid-nonce");
  }
  const name = `.quarantine-${nonce}`;
  const path = join(parent, name);
  if (!isImmediateChild(parent, path) || basename(path) !== name) {
    throw new ScratchOwnershipError("invalid-quarantine-path");
  }
  return path;
}

function cleanupJournalPath(parent: string, nonce: string): string {
  if (!NONCE.test(nonce)) {
    throw new ScratchOwnershipError("invalid-nonce");
  }
  const name = `${JOURNAL_PREFIX}${nonce}.json`;
  const path = join(parent, name);
  if (!isImmediateChild(parent, path) || basename(path) !== name) {
    throw new ScratchOwnershipError("invalid-journal-path");
  }
  return path;
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new ScratchOwnershipError("quarantine-exists");
}

function markerMatchesAllocation(marker: Marker, allocation: Allocation): boolean {
  return (
    marker.nonce === allocation.nonce &&
    marker.parent === allocation.canonicalParent &&
    marker.root === allocation.root &&
    marker.dev === allocation.dev &&
    marker.ino === allocation.ino
  );
}

async function readCleanupJournal(journalPath: string): Promise<CleanupJournal | null> {
  try {
    if (!isOwnedPrivateFile(await lstat(journalPath))) {
      return null;
    }
    const value: unknown = JSON.parse(await readFile(journalPath, "utf8"));
    if (!value || typeof value !== "object") {
      return null;
    }
    const journal = value as Partial<CleanupJournal>;
    if (
      journal.schema !== SCRATCH_SCHEMA ||
      journal.state !== "quarantining" ||
      typeof journal.nonce !== "string" ||
      !NONCE.test(journal.nonce) ||
      typeof journal.parent !== "string" ||
      typeof journal.root !== "string" ||
      typeof journal.quarantine !== "string" ||
      !journal.marker
    ) {
      return null;
    }
    if (!isValidMarker(journal.marker)) {
      return null;
    }
    const { marker } = journal;
    const allocation: Allocation = {
      canonicalParent: journal.parent,
      dev: marker.dev,
      ino: marker.ino,
      markerPath: join(journal.root, MARKER_NAME),
      nonce: journal.nonce,
      root: journal.root,
    };
    if (
      !markerMatchesAllocation(marker, allocation) ||
      marker.state === "launching" ||
      !isImmediateRunChild(journal.parent, journal.root) ||
      journal.quarantine !== quarantinePath(journal.parent, journal.nonce)
    ) {
      return null;
    }
    return journal as CleanupJournal;
  } catch {
    return null;
  }
}

interface CleanupBudget {
  consumeRemovalAttempt?: (path: string) => boolean;
  consumeStateTransition?: (path: string) => boolean;
}

function consumeBudget(consume: ((path: string) => boolean) | undefined, path: string): void {
  if (consume && !consume(path)) {
    throw new ScratchOwnershipError("recovery-budget-exhausted");
  }
}

async function createCleanupJournal(allocation: Allocation, budget?: CleanupBudget): Promise<string> {
  const marker = await readMarker(allocation.markerPath);
  if (!(marker && markerMatchesAllocation(marker, allocation)) || marker.state === "launching") {
    throw new ScratchOwnershipError("marker-mismatch");
  }
  const journalPath = cleanupJournalPath(allocation.canonicalParent, allocation.nonce);
  consumeBudget(budget?.consumeStateTransition, journalPath);
  const journal: CleanupJournal = {
    marker,
    nonce: allocation.nonce,
    parent: allocation.canonicalParent,
    quarantine: quarantinePath(allocation.canonicalParent, allocation.nonce),
    root: allocation.root,
    schema: SCRATCH_SCHEMA,
    state: "quarantining",
  };
  await writeExclusiveJson(journalPath, journal);
  return journalPath;
}

async function removeJournalWhenTargetAbsent(journalPath: string, root: string, quarantine: string): Promise<void> {
  await requireAbsent(root);
  await requireAbsent(quarantine);
  await unlink(journalPath);
  await syncDirectory(dirname(journalPath));
}

async function quarantineAndRemove(
  allocation: Allocation,
  budget?: CleanupBudget,
  hooks?: CleanupHooks
): Promise<void> {
  const quarantine = quarantinePath(allocation.canonicalParent, allocation.nonce);
  if (!(await matchesAllocation(allocation))) {
    throw new ScratchOwnershipError("identity-mismatch");
  }
  const marker = await readMarker(allocation.markerPath);
  if (!(marker && markerMatchesAllocation(marker, allocation))) {
    throw new ScratchOwnershipError("marker-mismatch");
  }
  if (marker.state === "running") {
    if (typeof marker.pgid !== "number" || !Number.isSafeInteger(marker.pgid) || marker.pgid <= 0) {
      throw new ScratchOwnershipError("malformed-marker");
    }
    if (!groupAbsent(marker.pgid)) {
      throw new ScratchOwnershipError("group-live");
    }
  }
  const journalPath = await createCleanupJournal(allocation, budget);
  await hooks?.afterJournal?.();
  await requireAbsent(quarantine);
  consumeBudget(budget?.consumeStateTransition, quarantine);
  await rename(allocation.root, quarantine);
  await syncDirectory(allocation.canonicalParent);
  await hooks?.afterRename?.();
  const quarantined = await lstat(quarantine);
  if (
    !isOwnedPrivateDirectory(quarantined) ||
    quarantined.dev !== allocation.dev ||
    quarantined.ino !== allocation.ino
  ) {
    throw new ScratchOwnershipError("quarantine-identity-mismatch");
  }
  consumeBudget(budget?.consumeRemovalAttempt, quarantine);
  await rm(quarantine, { force: false, recursive: true });
  await removeJournalWhenTargetAbsent(journalPath, allocation.root, quarantine);
}

export async function cleanupScratchOwnership(ownership: ScratchOwnership, hooks?: CleanupHooks): Promise<void> {
  await quarantineAndRemove(ownership.allocation, undefined, hooks);
}

function processAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function groupAbsent(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function isOldEnough(marker: Marker, now: number): boolean {
  const age = now - Date.parse(marker.created_at);
  return Number.isFinite(age) && age >= RECOVERY_GRACE_MS;
}

/** Return the fail-closed reason for a marker whose owner is already absent. */
function recoveryStateReason(marker: Marker, bootId: string | null): string | undefined {
  if (marker.state === "allocated") {
    return;
  }
  if (marker.state === "launching") {
    // A process may have been created before its PGID became durable. Age cannot prove otherwise.
    return "launch-unknown";
  }
  if (typeof marker.pgid !== "number" || !Number.isSafeInteger(marker.pgid) || marker.pgid <= 0) {
    return "malformed-marker";
  }
  // A PID/PGID can be reused across boots. A valid marker is recoverable only
  // after its exact recorded group is absent, irrespective of boot identity.
  if (!groupAbsent(marker.pgid)) {
    return "group-live";
  }
  if (marker.boot_id === undefined || bootId === null) {
    return "unverifiable-boot";
  }
  // biome-ignore lint/complexity/noUselessReturn: explicit return keeps the recovery classification total under noImplicitReturns.
  return;
}

function recoveryAllocation(canonicalParent: string, marker: Marker, root: string): Allocation {
  return {
    canonicalParent,
    dev: marker.dev,
    ino: marker.ino,
    markerPath: join(root, MARKER_NAME),
    nonce: marker.nonce,
    root,
  };
}

async function removeVerifiedQuarantine(
  quarantine: string,
  allocation: Allocation,
  budget?: CleanupBudget
): Promise<void> {
  if (!isImmediateChild(allocation.canonicalParent, quarantine)) {
    throw new ScratchOwnershipError("invalid-quarantine-path");
  }
  const stats = await lstat(quarantine);
  if (!isOwnedPrivateDirectory(stats) || stats.dev !== allocation.dev || stats.ino !== allocation.ino) {
    throw new ScratchOwnershipError("quarantine-identity-mismatch");
  }
  consumeBudget(budget?.consumeRemovalAttempt, quarantine);
  await rm(quarantine, { force: false, recursive: true });
}

function journalPathNonce(path: string): string | undefined {
  const name = basename(path);
  if (!(name.startsWith(JOURNAL_PREFIX) && name.endsWith(".json"))) {
    return;
  }
  const nonce = name.slice(JOURNAL_PREFIX.length, -".json".length);
  return NONCE.test(nonce) ? nonce : undefined;
}

function quarantinePathNonce(path: string): string | undefined {
  const name = basename(path);
  if (!name.startsWith(".quarantine-")) {
    return;
  }
  const nonce = name.slice(".quarantine-".length);
  return NONCE.test(nonce) ? nonce : undefined;
}

async function recoverJournal(
  journalPath: string,
  canonicalParent: string,
  now: number,
  bootId: string | null,
  budget: CleanupBudget
): Promise<RecoveryResult> {
  const journal = await readCleanupJournal(journalPath);
  if (!journal || journal.parent !== canonicalParent || journalPathNonce(journalPath) !== journal.nonce) {
    return { path: journalPath, reason: "malformed-journal", removed: false };
  }
  const { marker } = journal;
  if (!isOldEnough(marker, now)) {
    return { path: journalPath, reason: "fresh", removed: false };
  }
  if (!processAbsent(marker.owner_pid)) {
    return { path: journalPath, reason: "owner-live", removed: false };
  }
  const stateReason = recoveryStateReason(marker, bootId);
  if (stateReason) {
    return { path: journalPath, reason: stateReason, removed: false };
  }
  const allocation = recoveryAllocation(canonicalParent, marker, journal.root);
  const rootStats = await lstat(journal.root).catch(() => undefined);
  const quarantineStats = await lstat(journal.quarantine).catch(() => undefined);
  try {
    if (rootStats && quarantineStats) {
      throw new ScratchOwnershipError("journal-target-conflict");
    }
    if (rootStats) {
      if (
        !isOwnedPrivateDirectory(rootStats) ||
        rootStats.dev !== allocation.dev ||
        rootStats.ino !== allocation.ino ||
        !isImmediateRunChild(canonicalParent, journal.root)
      ) {
        throw new ScratchOwnershipError("identity-mismatch");
      }
      consumeBudget(budget.consumeStateTransition, journal.quarantine);
      await requireAbsent(journal.quarantine);
      await rename(journal.root, journal.quarantine);
      await syncDirectory(canonicalParent);
    }
    if (quarantineStats || (await lstat(journal.quarantine).catch(() => undefined))) {
      await removeVerifiedQuarantine(journal.quarantine, allocation, budget);
    }
    await removeJournalWhenTargetAbsent(journalPath, journal.root, journal.quarantine);
    return { path: journalPath, reason: "dead-verified", removed: true };
  } catch (error) {
    if (error instanceof ScratchOwnershipError && error.reason === "recovery-budget-exhausted") {
      return { path: journalPath, reason: "recovery-deferred", removed: false };
    }
    return {
      path: journalPath,
      reason: error instanceof ScratchOwnershipError ? error.reason : "cleanup-failed",
      removed: false,
    };
  }
}

async function recoverCompatibleQuarantine(
  candidate: string,
  nonce: string,
  canonicalParent: string,
  now: number,
  bootId: string | null,
  budget: CleanupBudget
): Promise<RecoveryResult> {
  const stats = await lstat(candidate).catch(() => undefined);
  if (!stats) {
    return { path: candidate, reason: "cleanup-failed", removed: false };
  }
  const safetyReason = scratchCandidateSafetyReason(stats);
  if (safetyReason) {
    return { path: candidate, reason: safetyReason, removed: false };
  }
  const marker = await readMarker(join(candidate, MARKER_NAME));
  if (!marker || marker.nonce !== nonce || !isImmediateRunChild(canonicalParent, marker.root)) {
    return { path: candidate, reason: "quarantine-no-capability", removed: false };
  }
  if (!isOldEnough(marker, now)) {
    return { path: candidate, reason: "fresh", removed: false };
  }
  if (
    marker.parent !== canonicalParent ||
    marker.dev !== stats.dev ||
    marker.ino !== stats.ino ||
    !processAbsent(marker.owner_pid)
  ) {
    return { path: candidate, reason: "quarantine-no-capability", removed: false };
  }
  const stateReason = recoveryStateReason(marker, bootId);
  if (stateReason) {
    return { path: candidate, reason: stateReason, removed: false };
  }
  try {
    await removeVerifiedQuarantine(candidate, recoveryAllocation(canonicalParent, marker, marker.root), budget);
    return { path: candidate, reason: "dead-verified", removed: true };
  } catch (error) {
    if (error instanceof ScratchOwnershipError && error.reason === "recovery-budget-exhausted") {
      return { path: candidate, reason: "recovery-deferred", removed: false };
    }
    return {
      path: candidate,
      reason: error instanceof ScratchOwnershipError ? error.reason : "cleanup-failed",
      removed: false,
    };
  }
}

async function recoverRunCandidate(
  candidate: string,
  canonicalParent: string,
  now: number,
  bootId: string | null,
  budget: CleanupBudget
): Promise<RecoveryResult | undefined> {
  if (!isImmediateRunChild(canonicalParent, candidate)) {
    return { path: candidate, reason: "foreign-entry", removed: false };
  }
  const candidateStats = await lstat(candidate).catch(() => undefined);
  if (!candidateStats) {
    return;
  }
  const safetyReason = scratchCandidateSafetyReason(candidateStats);
  if (safetyReason) {
    return { path: candidate, reason: safetyReason, removed: false };
  }
  const marker = await readMarker(join(candidate, MARKER_NAME));
  if (!marker) {
    return { path: candidate, reason: "malformed-marker", removed: false };
  }
  if (!isOldEnough(marker, now)) {
    return { path: candidate, reason: "fresh", removed: false };
  }
  if (
    marker.parent !== canonicalParent ||
    marker.root !== candidate ||
    marker.dev !== candidateStats.dev ||
    marker.ino !== candidateStats.ino
  ) {
    return { path: candidate, reason: "identity-mismatch", removed: false };
  }
  if (!processAbsent(marker.owner_pid)) {
    return { path: candidate, reason: "owner-live", removed: false };
  }
  const stateReason = recoveryStateReason(marker, bootId);
  if (stateReason) {
    return { path: candidate, reason: stateReason, removed: false };
  }
  try {
    await quarantineAndRemove(recoveryAllocation(canonicalParent, marker, candidate), budget);
    return { path: candidate, reason: "dead-verified", removed: true };
  } catch (error) {
    if (error instanceof ScratchOwnershipError && error.reason === "recovery-budget-exhausted") {
      return { path: candidate, reason: "recovery-deferred", removed: false };
    }
    return {
      path: candidate,
      reason: error instanceof ScratchOwnershipError ? error.reason : "cleanup-failed",
      removed: false,
    };
  }
}

export interface RecoverStaleScratchOptions {
  hooks?: RecoveryHooks;
  limits?: Partial<RecoveryLimits>;
  now?: number;
  parent?: string;
}

function boundedLimits(limits: Partial<RecoveryLimits> | undefined): RecoveryLimits {
  const value = { ...DEFAULT_RECOVERY_LIMITS, ...limits };
  for (const limit of Object.values(value)) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new ScratchOwnershipError("invalid-recovery-limit");
    }
  }
  return value;
}

function isSingleEntryName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\u0000")
  );
}

async function readRecoveryCursor(cursorPath: string): Promise<string | undefined> {
  try {
    if (!isOwnedPrivateFile(await lstat(cursorPath))) {
      return;
    }
    const value: unknown = JSON.parse(await readFile(cursorPath, "utf8"));
    if (!value || typeof value !== "object") {
      return;
    }
    const cursor = value as Partial<RecoveryCursor>;
    return cursor.schema === RECOVERY_CURSOR_SCHEMA && isSingleEntryName(cursor.after) ? cursor.after : undefined;
  } catch {
    // Missing, malformed, and unreadable cursors safely restart at the lexical head.
    // biome-ignore lint/complexity/noUselessUndefined: explicit recovery fallback satisfies noImplicitReturns.
    return undefined;
  }
}

async function recoveryCursorCanAdvance(cursorPath: string): Promise<boolean> {
  try {
    return isOwnedPrivateFile(await lstat(cursorPath));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function advanceRecoveryCursor(cursorPath: string, after: string): Promise<void> {
  await replaceJson(cursorPath, { after, schema: RECOVERY_CURSOR_SCHEMA } satisfies RecoveryCursor);
}

async function recoveryEntryNames(canonicalParent: string): Promise<string[]> {
  const directory = await opendir(canonicalParent);
  const names: string[] = [];
  try {
    for await (const entry of directory) {
      if (entry.name !== RECOVERY_CURSOR_NAME) {
        names.push(entry.name);
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return names.sort((left, right) => {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  });
}

function rotateRecoveryEntries(names: readonly string[], after: string | undefined): readonly string[] {
  if (after === undefined) {
    return names;
  }
  const firstAfter = names.findIndex((name) => name > after);
  if (firstAfter === -1) {
    return names;
  }
  return [...names.slice(firstAfter), ...names.slice(0, firstAfter)];
}

/** Recover a bounded number of verified candidates. It never signals candidates. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the bounded recovery state machine is intentionally kept in one auditable loop; the cursor-writability gate is fail-closed state, not a separate policy.
export async function recoverStaleScratch(options: RecoverStaleScratchOptions = {}): Promise<RecoveryResult[]> {
  const canonicalParent = await validatedParent(options.parent);
  const now = options.now ?? Date.now();
  const bootId = await linuxBootId();
  const limits = boundedLimits(options.limits);
  const results: RecoveryResult[] = [];
  const cursorPath = join(canonicalParent, RECOVERY_CURSOR_NAME);
  if (!(await recoveryCursorCanAdvance(cursorPath))) {
    return [{ path: cursorPath, reason: "recovery-cursor-write-failed", removed: false }];
  }
  const cursor = await readRecoveryCursor(cursorPath);
  const candidates = rotateRecoveryEntries(await recoveryEntryNames(canonicalParent), cursor);
  let inspected = 0;
  let lastInspected: string | undefined;
  let removals = 0;
  let stateTransitions = 0;
  let exhausted = false;
  const budget: CleanupBudget = {
    consumeRemovalAttempt: (path) => {
      if (removals >= limits.maxRemovalAttempts) {
        exhausted = true;
        return false;
      }
      removals += 1;
      options.hooks?.onRemovalAttempt?.(path);
      return true;
    },
    consumeStateTransition: (path) => {
      if (stateTransitions >= limits.maxStateTransitions) {
        exhausted = true;
        return false;
      }
      stateTransitions += 1;
      options.hooks?.onStateTransition?.(path);
      return true;
    },
  };
  for (const name of candidates) {
    if (inspected >= limits.maxInspectedEntries) {
      exhausted = true;
      break;
    }
    inspected += 1;
    lastInspected = name;
    const candidate = join(canonicalParent, name);
    options.hooks?.onInspect?.(candidate);
    let result: RecoveryResult | undefined;
    if (name.startsWith("run-")) {
      // biome-ignore lint/performance/noAwaitInLoops: recovery concurrency is deliberately fixed at one.
      result = await recoverRunCandidate(candidate, canonicalParent, now, bootId, budget);
    } else {
      const journalNonce = journalPathNonce(candidate);
      const quarantineNonce = quarantinePathNonce(candidate);
      if (journalNonce) {
        result = await recoverJournal(candidate, canonicalParent, now, bootId, budget);
      } else if (quarantineNonce) {
        result = await recoverCompatibleQuarantine(candidate, quarantineNonce, canonicalParent, now, bootId, budget);
      } else {
        result = { path: candidate, reason: "foreign-entry", removed: false };
      }
    }
    if (result) {
      results.push(result);
    }
    if (exhausted) {
      break;
    }
  }
  if (lastInspected !== undefined) {
    try {
      await advanceRecoveryCursor(cursorPath, lastInspected);
    } catch {
      results.push({ path: cursorPath, reason: "recovery-cursor-write-failed", removed: false });
    }
  }
  if (exhausted) {
    results.push({ path: canonicalParent, reason: "recovery-budget-exhausted", removed: false });
  }
  return results;
}

/** An inner wrapper may participate only in the exact inherited allocation. */
export async function inheritedScratchOwnership(
  env: NodeJS.ProcessEnv = process.env
): Promise<ScratchOwnership | undefined> {
  const root = env.PDPP_TEST_SCRATCH_ROOT;
  const markerPath = env.PDPP_TEST_SCRATCH_MARKER;
  const nonce = env.PDPP_TEST_SCRATCH_NONCE;
  if (!(root || markerPath || nonce)) {
    return;
  }
  if (!(root && markerPath && nonce) || env.PDPP_TEST_SCRATCH_SCHEMA !== SCRATCH_SCHEMA) {
    throw new ScratchOwnershipError("invalid-inherited-ownership");
  }
  const marker = await readMarker(markerPath);
  const rootStats = await lstat(root).catch(() => undefined);
  const expectedMarkerPath = join(root, MARKER_NAME);
  const expectedOwnerPid = marker?.owner_pid === undefined ? undefined : String(marker.owner_pid);
  if (
    !(marker && rootStats && isOwnedPrivateDirectory(rootStats)) ||
    marker.nonce !== nonce ||
    marker.root !== root ||
    marker.parent !== dirname(root) ||
    marker.dev !== rootStats.dev ||
    marker.ino !== rootStats.ino ||
    markerPath !== expectedMarkerPath ||
    env.TMPDIR !== root ||
    env.TMP !== root ||
    env.TEMP !== root ||
    env.TEST_TMPDIR !== root ||
    env.PDPP_TEST_SCRATCH_OWNER_PID !== expectedOwnerPid
  ) {
    throw new ScratchOwnershipError("invalid-inherited-ownership");
  }
  const allocation: Allocation = {
    canonicalParent: marker.parent,
    dev: marker.dev,
    ino: marker.ino,
    markerPath,
    nonce,
    root,
  };
  return { allocation, env: { ...env } };
}
