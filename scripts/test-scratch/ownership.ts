// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import { basename, dirname, join, relative } from "node:path";

export const SCRATCH_SCHEMA = "pdpp.test-scratch/v1";
const MARKER_NAME = ".pdpp-test-scratch.json";
const REQUIRED_DIRECTORY_MODE = 0o700;
const MARKER_MODE = 0o600;
const RECOVERY_GRACE_MS = 60_000;

type MarkerState = "allocated" | "running";

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

/** Return a stable recovery reason without following an untrusted candidate. */
export function scratchCandidateSafetyReason(
  stats: Awaited<ReturnType<typeof lstat>>,
  expectedUid = userInfo().uid
): string | undefined {
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (!stats.isDirectory()) {
    return "invalid-root";
  }
  if (stats.uid !== expectedUid) {
    return "wrong-owner";
  }
  if (modeOf(stats) !== REQUIRED_DIRECTORY_MODE) {
    return "wrong-mode";
  }
}

async function linuxBootId(): Promise<string | null> {
  if (platform() !== "linux") {
    return null;
  }
  try {
    return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() || null;
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
  const fd = await open(markerPath, "wx", MARKER_MODE);
  try {
    await fd.writeFile(`${JSON.stringify(marker)}\n`);
    await fd.sync();
  } finally {
    await fd.close();
  }
}

async function replaceMarker(markerPath: string, marker: Marker): Promise<void> {
  const temporary = `${markerPath}.${randomBytes(8).toString("hex")}`;
  await writeFile(temporary, `${JSON.stringify(marker)}\n`, { mode: MARKER_MODE, flag: "wx" });
  await rename(temporary, markerPath);
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
  if (!marker || marker.nonce !== ownership.allocation.nonce || marker.state !== "allocated") {
    throw new ScratchOwnershipError("marker-mismatch");
  }
  await replaceMarker(ownership.allocation.markerPath, { ...marker, pgid, state: "running" });
}

async function readMarker(markerPath: string): Promise<Marker | null> {
  try {
    const value: unknown = JSON.parse(await readFile(markerPath, "utf8"));
    if (!value || typeof value !== "object") {
      return null;
    }
    const marker = value as Partial<Marker>;
    if (
      marker.schema !== SCRATCH_SCHEMA ||
      (marker.state !== "allocated" && marker.state !== "running") ||
      typeof marker.nonce !== "string" ||
      typeof marker.root !== "string" ||
      typeof marker.parent !== "string" ||
      typeof marker.owner_pid !== "number" ||
      !Number.isSafeInteger(marker.owner_pid) ||
      marker.owner_pid <= 0 ||
      typeof marker.dev !== "number" ||
      typeof marker.ino !== "number" ||
      typeof marker.created_at !== "string"
    ) {
      return null;
    }
    return marker as Marker;
  } catch {
    // A malformed marker is deliberately indistinguishable from an unreadable one.
    return null;
  }
}

async function matchesAllocation(allocation: Allocation): Promise<boolean> {
  try {
    const rootStats = await lstat(allocation.root);
    return (
      isOwnedPrivateDirectory(rootStats) &&
      rootStats.dev === allocation.dev &&
      rootStats.ino === allocation.ino &&
      dirname(allocation.root) === allocation.canonicalParent
    );
  } catch {
    return false;
  }
}

async function quarantineAndRemove(allocation: Allocation): Promise<void> {
  if (!(await matchesAllocation(allocation))) {
    throw new ScratchOwnershipError("identity-mismatch");
  }
  const quarantine = join(allocation.canonicalParent, `.quarantine-${allocation.nonce}`);
  await rename(allocation.root, quarantine);
  const quarantined = await lstat(quarantine);
  if (
    !isOwnedPrivateDirectory(quarantined) ||
    quarantined.dev !== allocation.dev ||
    quarantined.ino !== allocation.ino
  ) {
    throw new ScratchOwnershipError("quarantine-identity-mismatch");
  }
  await rm(quarantine, { force: false, recursive: true });
}

export async function cleanupScratchOwnership(ownership: ScratchOwnership): Promise<void> {
  await quarantineAndRemove(ownership.allocation);
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

function isDirectChild(parent: string, candidate: string): boolean {
  return dirname(candidate) === parent && basename(candidate).startsWith("run-") && relative(parent, candidate) !== "";
}

/** Recover only verified, dead roots from one dedicated parent. Never signals candidates. */
export async function recoverStaleScratch(options: { now?: number; parent?: string } = {}): Promise<RecoveryResult[]> {
  const canonicalParent = await validatedParent(options.parent);
  const now = options.now ?? Date.now();
  const bootId = await linuxBootId();
  const entries = await readdir(canonicalParent, { withFileTypes: true });
  const classifications = await Promise.all(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each fail-closed branch is a required recovery classification.
    entries.map(async (entry): Promise<RecoveryResult | undefined> => {
      if (!entry.name.startsWith("run-")) {
        return { path: join(canonicalParent, entry.name), reason: "foreign-entry", removed: false };
      }
      const candidate = join(canonicalParent, entry.name);
      if (!isDirectChild(canonicalParent, candidate)) {
        return { path: candidate, reason: "foreign-entry", removed: false };
      }
      let candidateStats: Awaited<ReturnType<typeof lstat>>;
      try {
        candidateStats = await lstat(candidate);
      } catch {
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
      const age = now - Date.parse(marker.created_at);
      if (!Number.isFinite(age) || age < RECOVERY_GRACE_MS) {
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
      if (marker.state === "running") {
        if (typeof marker.pgid !== "number" || !Number.isSafeInteger(marker.pgid) || marker.pgid <= 0) {
          return { path: candidate, reason: "malformed-marker", removed: false };
        }
        if (marker.boot_id === bootId && !groupAbsent(marker.pgid)) {
          return { path: candidate, reason: "group-live", removed: false };
        }
        if (marker.boot_id === undefined && bootId === null) {
          return { path: candidate, reason: "unverifiable-boot", removed: false };
        }
      }
      try {
        await quarantineAndRemove({
          canonicalParent,
          dev: marker.dev,
          ino: marker.ino,
          markerPath: join(candidate, MARKER_NAME),
          nonce: marker.nonce,
          root: candidate,
        });
        return { path: candidate, reason: "dead-verified", removed: true };
      } catch (error) {
        return {
          path: candidate,
          reason: error instanceof ScratchOwnershipError ? error.reason : "cleanup-failed",
          removed: false,
        };
      }
    })
  );
  return classifications.filter((result): result is RecoveryResult => result !== undefined);
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
  if (
    !(marker && rootStats && isOwnedPrivateDirectory(rootStats)) ||
    marker.nonce !== nonce ||
    marker.root !== root ||
    marker.parent !== dirname(root) ||
    marker.dev !== rootStats.dev ||
    marker.ino !== rootStats.ino
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
