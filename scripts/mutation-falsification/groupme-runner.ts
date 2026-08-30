// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Orchestrates ONE GroupMe pilot batch (design.md Decision #6/#7, tasks.md
 * section 2). Locks a 10-minute wall-clock batch window; runs the clean
 * complete `polyfill-connectors` backstop through the UNCHANGED
 * test-accounting authority against a clean isolated clone before
 * interpreting any mutant; for each registered operator, creates a fresh
 * isolated clone, applies the operator (verifying its exact preimage
 * first), commits the mutant as a real one-commit descendant, runs the
 * FOCUSED existing hermetic test file(s) as adapter evidence (never
 * labeled a test-accounting authority receipt), and — only if focused
 * passes — runs the MANDATORY complete mutant backstop. Copies and
 * revalidates every accounting bundle into the evidence store before
 * destroying each clone.
 *
 * This file NEVER runs `runAuthority` against the real source tree — only
 * against isolated clones created by `workspace.ts`.
 */

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { runAuthority } from "../test-accounting/authority.ts";
import { digestOf } from "./canonicalize.ts";
import {
  checkBudget,
  copyAndRevalidateAccountingBundle,
  type EvidenceStorePolicy,
  issueAttemptMarker,
  publishCompleteReceipt,
  scanForIncompleteOrCorrupt,
} from "./evidence-store.ts";
import { applyOperator, findGroupMeOperator, type GroupMeOperator } from "./groupme-operators.ts";
import { aggregateTrial, projectOutcome, type ProjectionResult } from "./projection.ts";
import { ATTEMPT_SCHEMA, type AttemptAxes, type AttemptReceipt, type IntentPacket } from "./schemas.ts";
import {
  createIsolatedWorkspace,
  destroyWorkspace,
  quarantineWorkspace,
  runInWorkspace,
  type WorkspacePolicy,
} from "./workspace.ts";

const execFileAsync = promisify(execFile);

export const GROUPME_PILOT_ADAPTER_ID = "groupme-cursor-frontier/v1" as const;
export const GROUPME_PILOT_ADAPTER_VERSION = "1" as const;
export const PILOT_BATCH_WALL_TIME_MS = 10 * 60 * 1000;
const FOCUSED_TEST_FILE = "packages/polyfill-connectors/connectors/groupme/incremental-frontier.test.ts";
const BACKSTOP_SUITE_ID = "polyfill-connectors";
/** Reuse window for a clean baseline within one locked batch (design.md Decision #6). */
const CLEAN_EVIDENCE_REUSE_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface GroupMeRunnerPolicy {
  evidenceStorePolicy: EvidenceStorePolicy;
  policyVersion: string;
  sourceRepoRoot: string;
  workspacePolicy: WorkspacePolicy;
}

export interface OperatorAttemptOutcome {
  attemptId: string;
  operatorId: string;
  projection: ProjectionResult;
  receipt: AttemptReceipt;
}

export interface PilotBatchResult {
  /** Raw count of clean-baseline EXECUTIONS actually performed — never reduced by reuse, per design.md Decision #6. */
  cleanExecutionRawCount: number;
  operatorOutcomes: OperatorAttemptOutcome[];
}

export function judgeIdentityFor(operator: GroupMeOperator | null): string {
  return digestOf({ focusedTestFile: FOCUSED_TEST_FILE, backstopSuite: BACKSTOP_SUITE_ID, operatorId: operator?.id ?? null });
}

async function runFocusedCheck(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  wallTimeMs: number
): Promise<{ failure?: string; ok: boolean; stderr: string; stdout: string }> {
  const result = await runInWorkspace(
    [process.execPath, "--test", "--import", "tsx", FOCUSED_TEST_FILE],
    repoRoot,
    env,
    wallTimeMs
  );
  if (result.deadlineFired) {
    return { ok: false, failure: "focused_check_wall_deadline_exceeded", stdout: result.stdout, stderr: result.stderr };
  }
  if (result.exitCode !== 0) {
    return { ok: false, failure: "focused_check_test_failure", stdout: result.stdout, stderr: result.stderr };
  }
  return { ok: true, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Runs the clean COMPLETE `polyfill-connectors` backstop via the real,
 * unchanged `runAuthority` against `repoRoot` (an isolated clone). Copies
 * and revalidates its accounting bundle into the evidence store. Returns
 * the axis observation plus the accounting run_id(s) referenced, for
 * embedding in an attempt receipt.
 */
async function runCompleteBackstop(
  repoRoot: string,
  baseCommitSha: string,
  evidenceStorePolicy: EvidenceStorePolicy,
  attemptId: string
): Promise<{
  artifacts: Awaited<ReturnType<typeof copyAndRevalidateAccountingBundle>>;
  axis: AttemptAxes["backstop"];
  runIds: string[];
}> {
  let authorityOutcome: Awaited<ReturnType<typeof runAuthority>>;
  try {
    authorityOutcome = await runAuthority({ suites: [BACKSTOP_SUITE_ID], root: repoRoot, base: baseCommitSha });
  } catch (error) {
    return {
      axis: { status: "failed", failure: "backstop_authority_error", detail: (error as Error).message },
      runIds: [],
      artifacts: [],
    };
  }
  const runIds = authorityOutcome.result.verified;
  const allArtifacts: Awaited<ReturnType<typeof copyAndRevalidateAccountingBundle>> = [];
  try {
    for (const key of runIds) {
      // `verified` entries are `${suiteId}/${profileId}` keys, not run_ids —
      // recover each receipt's actual run_id from its published JSON so the
      // copy step reads the right files.
      const runId = await runIdForSuiteProfileKey(authorityOutcome.directory, key);
      // biome-ignore lint/performance/noAwaitInLoops: bundle copies must be sequential — each is individually revalidated before the next begins, matching runAuthority's own sequential-run discipline.
      const artifacts = await copyAndRevalidateAccountingBundle(
        evidenceStorePolicy.evidenceRoot,
        attemptId,
        authorityOutcome.directory,
        runId
      );
      allArtifacts.push(...artifacts);
    }
  } catch (error) {
    return {
      axis: { status: "failed", failure: "backstop_artifact_retention_failed", detail: (error as Error).message },
      runIds: [],
      artifacts: allArtifacts,
    };
  }
  return { axis: { status: "ok" }, runIds, artifacts: allArtifacts };
}

async function runIdForSuiteProfileKey(authorityDirectory: string, _key: string): Promise<string> {
  // Every receipt published by this authority run lives directly in
  // authorityDirectory as `<run_id>.receipt.json`; there is exactly one run
  // for this pilot's single suite/profile selection, so the first (only)
  // receipt file found is authoritative.
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(authorityDirectory);
  const receiptFile = entries.find((name) => name.endsWith(".receipt.json"));
  if (!receiptFile) {
    throw new Error(`groupme-runner: no receipt file found in authority directory ${authorityDirectory}`);
  }
  return receiptFile.replace(".receipt.json", "");
}

export class ForbiddenPathChangeError extends Error {
  constructor(operatorId: string, changedPaths: string[]) {
    super(
      `groupme-runner: operator ${operatorId} would change path(s) outside its declared target — refusing to commit: ${changedPaths.join(", ")}`
    );
    this.name = "ForbiddenPathChangeError";
  }
}

export async function commitMutant(repoRoot: string, operator: GroupMeOperator): Promise<string> {
  const targetPath = resolve(repoRoot, operator.targetFile);
  const original = await readFile(targetPath, "utf8");
  const mutated = applyOperator(operator, original); // throws PreimageMismatchError on any mismatch — verified BEFORE any write.
  await writeFile(targetPath, mutated, "utf8");
  // Defense in depth: verify the working tree's changed paths are EXACTLY
  // the operator's declared target, before staging or committing anything.
  // An operator entry could in principle be authored to write outside its
  // declared path; this check makes that a hard, caught error rather than
  // a silent wider change slipping into the mutant commit.
  const { stdout: statusOutput } = await execFileAsync("git", ["-C", repoRoot, "status", "--porcelain=v1"]);
  const changedPaths = statusOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
  const unexpected = changedPaths.filter((path) => path !== operator.targetFile);
  if (unexpected.length > 0) {
    throw new ForbiddenPathChangeError(operator.id, unexpected);
  }
  await execFileAsync("git", ["-C", repoRoot, "add", "--", operator.targetFile]);
  await execFileAsync("git", [
    "-C",
    repoRoot,
    "-c",
    "user.name=mutation-falsification",
    "-c",
    "user.email=mutation-falsification@localhost",
    "commit",
    "-q",
    "-m",
    `mutation-falsification: apply ${operator.id}`,
  ]);
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, "rev-parse", "HEAD"]);
  return stdout.trim();
}

/**
 * Runs one operator attempt end to end inside a fresh isolated workspace:
 * apply + commit the mutant, run the focused check, and — only if focused
 * passes — the mandatory complete mutant backstop. Destroys the workspace
 * only after required evidence is copied+revalidated; quarantines on any
 * cleanup failure.
 */
interface AttemptComputation {
  evidenceArtifacts: AttemptReceipt["evidenceArtifacts"];
  mutantCommitSha: string;
  nonCleanupAxes: Omit<AttemptAxes, "cleanup">;
  referencedAccountingRunIds: string[];
}

async function computeOperatorAttempt(
  workspace: { env: NodeJS.ProcessEnv; repoRoot: string },
  operator: GroupMeOperator,
  policy: GroupMeRunnerPolicy,
  attemptId: string
): Promise<AttemptComputation> {
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync(
      "pnpm",
      ["install", "--frozen-lockfile", "--offline", "--ignore-scripts", "--node-linker=hoisted", "--package-import-method=copy"],
      { cwd: workspace.repoRoot, env: workspace.env }
    );
  } catch (error) {
    return {
      mutantCommitSha: "",
      evidenceArtifacts: [],
      referencedAccountingRunIds: [],
      nonCleanupAxes: {
        baseline: { status: "ok" },
        materialization: { status: "failed", failure: "dependency_materialization_failed", detail: (error as Error).message },
        focused: { status: "failed", failure: "not_run_due_to_materialization_failure", detail: "" },
        backstop: { status: "not_applicable" },
        reachability: { status: "unknown" },
      },
    };
  }

  let mutantCommitSha: string;
  try {
    mutantCommitSha = await commitMutant(workspace.repoRoot, operator);
  } catch (error) {
    return {
      mutantCommitSha: "",
      evidenceArtifacts: [],
      referencedAccountingRunIds: [],
      nonCleanupAxes: {
        baseline: { status: "ok" },
        materialization: { status: "ok" },
        focused: { status: "failed", failure: "preimage_mismatch_or_apply_failure", detail: (error as Error).message },
        backstop: { status: "not_applicable" },
        reachability: { status: "unknown" },
      },
    };
  }

  const focused = await runFocusedCheck(workspace.repoRoot, workspace.env, 120_000);
  if (!focused.ok) {
    // Focused check failed. This IS mutation-attributable evidence: the
    // operator's target file was mutated and the SAME test file that was
    // proven (see groupme-operators.ts's doc comments and the manual
    // verification in this branch's history) to pass on the clean tree now
    // fails. Backstop MAY be omitted, recording not_run_focused_kill.
    return {
      mutantCommitSha,
      evidenceArtifacts: [],
      referencedAccountingRunIds: [],
      nonCleanupAxes: {
        baseline: { status: "ok" },
        materialization: { status: "ok" },
        focused: { status: "failed", failure: focused.failure ?? "focused_check_failed", detail: focused.stdout.slice(-4000) },
        backstop: { status: "not_run_focused_kill" },
        reachability: { status: "ok" },
      },
    };
  }

  // Focused passed — the mandatory complete mutant backstop now runs.
  const backstopResult = await runCompleteBackstop(workspace.repoRoot, mutantCommitSha, policy.evidenceStorePolicy, attemptId);
  return {
    mutantCommitSha,
    evidenceArtifacts: backstopResult.artifacts,
    referencedAccountingRunIds: backstopResult.runIds,
    nonCleanupAxes: {
      baseline: { status: "ok" },
      materialization: { status: "ok" },
      focused: { status: "ok" },
      backstop: backstopResult.axis,
      reachability: { status: "ok" },
    },
  };
}

export function isMutationAttributable(axes: Omit<AttemptAxes, "cleanup">): boolean {
  const focusedAttributable =
    axes.focused.status === "failed" &&
    axes.focused.failure !== "preimage_mismatch_or_apply_failure" &&
    axes.focused.failure !== "not_run_due_to_materialization_failure" &&
    axes.focused.failure !== "focused_check_wall_deadline_exceeded";
  const backstopAttributable =
    axes.backstop.status === "failed" &&
    axes.backstop.failure !== "backstop_authority_error" &&
    axes.backstop.failure !== "backstop_artifact_retention_failed";
  return focusedAttributable || backstopAttributable;
}

/**
 * Runs one operator attempt end to end inside a fresh isolated workspace:
 * apply + commit the mutant, run the focused check, and — only if focused
 * passes — the mandatory complete mutant backstop. Cleanup (destroy or
 * quarantine the workspace) happens BEFORE the receipt is published, so the
 * receipt's cleanup axis always reflects a REAL, already-observed outcome —
 * never a hardcoded assumption that cleanup will succeed later.
 */
async function runOperatorAttempt(
  policy: GroupMeRunnerPolicy,
  intent: IntentPacket,
  operatorId: string,
  baseCommitSha: string
): Promise<OperatorAttemptOutcome> {
  const operator = findGroupMeOperator(operatorId);
  await scanForIncompleteOrCorrupt(policy.evidenceStorePolicy.evidenceRoot);
  const attemptId = randomUUID();
  await checkBudget(policy.evidenceStorePolicy, 50 * 1024 * 1024); // 50 MiB planning estimate for one attempt's retained evidence.
  await issueAttemptMarker(policy.evidenceStorePolicy.evidenceRoot, attemptId, intent);

  const startedAt = Date.now();
  const workspace = await createIsolatedWorkspace(policy.workspacePolicy, policy.sourceRepoRoot, baseCommitSha);
  const computation = await computeOperatorAttempt(workspace, operator, policy, attemptId);

  let cleanupAxis: AttemptAxes["cleanup"];
  try {
    await destroyWorkspace(workspace.workspaceDir);
    cleanupAxis = { status: "ok" };
  } catch (error) {
    cleanupAxis = { status: "failed", failure: "workspace_cleanup_failed", detail: (error as Error).message };
    await quarantineWorkspace(workspace.workspaceDir, (error as Error).message).catch(() => undefined);
  }

  const axes: AttemptAxes = { ...computation.nonCleanupAxes, cleanup: cleanupAxis };
  const runtimeMs = Date.now() - startedAt;
  const trialKey = digestOf({
    intentDigest: intent.intentDigest,
    adapterVersion: GROUPME_PILOT_ADAPTER_VERSION,
    policyVersion: policy.policyVersion,
    operatorId,
  });
  const receipt: AttemptReceipt = {
    schema: ATTEMPT_SCHEMA,
    attemptId,
    trialKey,
    policyVersion: policy.policyVersion,
    baseCommitSha,
    mutantIdentity: computation.mutantCommitSha || null,
    judgeIdentity: judgeIdentityFor(operator),
    environmentProfile: Object.keys(workspace.env),
    evidenceArtifacts: computation.evidenceArtifacts,
    axes,
    runtimeMs,
    attemptStatus: { exitCode: axes.focused.status === "ok" ? 0 : 1, signal: null },
    referencedAccountingRunIds: computation.referencedAccountingRunIds,
  };
  const projection = projectOutcome({ axes, isMutationAttributableFailure: isMutationAttributable(computation.nonCleanupAxes) });
  await publishCompleteReceipt(policy.evidenceStorePolicy.evidenceRoot, receipt);
  return { attemptId, operatorId, receipt, projection };
}

/**
 * Runs the clean COMPLETE backstop once at batch start, then every
 * registered operator's attempt, within the locked 10-minute batch window.
 * Reuse of the clean baseline within the batch (design.md Decision #6) is
 * modeled by `cleanExecutionRawCount` — this pilot runs the clean backstop
 * exactly once per batch and does not currently implement cross-operator
 * reuse, so the raw count and the "used" count are identical here; the
 * field exists so a future batch that DOES reuse a clean baseline across
 * operators cannot silently under-report how many times it was actually
 * executed.
 */
export async function runGroupMePilotBatch(
  policy: GroupMeRunnerPolicy,
  intent: IntentPacket,
  operatorIds: string[]
): Promise<PilotBatchResult> {
  const batchStartedAt = Date.now();
  await scanForIncompleteOrCorrupt(policy.evidenceStorePolicy.evidenceRoot);
  await mkdir(policy.evidenceStorePolicy.evidenceRoot, { recursive: true });

  // Clean complete backstop at batch start.
  const cleanWorkspace = await createIsolatedWorkspace(
    policy.workspacePolicy,
    policy.sourceRepoRoot,
    intent.baseCommitSha
  );
  let cleanExecutionRawCount = 0;
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync(
      "pnpm",
      ["install", "--frozen-lockfile", "--offline", "--ignore-scripts", "--node-linker=hoisted", "--package-import-method=copy"],
      { cwd: cleanWorkspace.repoRoot, env: cleanWorkspace.env }
    );
    const cleanBackstopAttemptId = randomUUID();
    await issueAttemptMarker(policy.evidenceStorePolicy.evidenceRoot, cleanBackstopAttemptId, intent);
    const cleanResult = await runCompleteBackstop(
      cleanWorkspace.repoRoot,
      intent.baseCommitSha,
      policy.evidenceStorePolicy,
      cleanBackstopAttemptId
    );
    cleanExecutionRawCount += 1;
    if (cleanResult.axis.status !== "ok") {
      throw new Error(
        `groupme-runner: clean complete backstop failed before any mutant was interpreted: ${JSON.stringify(cleanResult.axis)}`
      );
    }
    const cleanReceipt: AttemptReceipt = {
      schema: ATTEMPT_SCHEMA,
      attemptId: cleanBackstopAttemptId,
      trialKey: digestOf({ intentDigest: intent.intentDigest, kind: "clean-backstop", baseCommitSha: intent.baseCommitSha }),
      policyVersion: policy.policyVersion,
      baseCommitSha: intent.baseCommitSha,
      mutantIdentity: null,
      judgeIdentity: judgeIdentityFor(null),
      environmentProfile: Object.keys(cleanWorkspace.env),
      evidenceArtifacts: cleanResult.artifacts,
      axes: {
        baseline: { status: "ok" },
        materialization: { status: "ok" },
        focused: { status: "not_applicable" },
        backstop: cleanResult.axis,
        reachability: { status: "not_applicable" },
        cleanup: { status: "ok" },
      },
      runtimeMs: Date.now() - batchStartedAt,
      attemptStatus: { exitCode: 0, signal: null },
      referencedAccountingRunIds: cleanResult.runIds,
    };
    await publishCompleteReceipt(policy.evidenceStorePolicy.evidenceRoot, cleanReceipt);
  } finally {
    await destroyWorkspace(cleanWorkspace.workspaceDir).catch(async (error) => {
      await quarantineWorkspace(cleanWorkspace.workspaceDir, (error as Error).message).catch(() => undefined);
    });
  }

  const operatorOutcomes: OperatorAttemptOutcome[] = [];
  for (const operatorId of operatorIds) {
    if (Date.now() - batchStartedAt > PILOT_BATCH_WALL_TIME_MS) {
      throw new Error("groupme-runner: 10-minute locked pilot batch window exceeded before all operators ran");
    }
    // biome-ignore lint/performance/noAwaitInLoops: operators run sequentially by design (initial policy: "one trusted command at a time").
    const outcome = await runOperatorAttempt(policy, intent, operatorId, intent.baseCommitSha);
    operatorOutcomes.push(outcome);
  }

  return { operatorOutcomes, cleanExecutionRawCount };
}

/** Combines multiple attempts for the same operator into one trial verdict — no retries, contradictory attempts are inconclusive. See projection.ts's aggregateTrial. */
export function aggregateOperatorAttempts(outcomes: OperatorAttemptOutcome[]): ProjectionResult {
  return aggregateTrial(outcomes.map((o) => o.projection));
}

export const CLEAN_EVIDENCE_REUSE_WINDOW_MS_EXPORT = CLEAN_EVIDENCE_REUSE_WINDOW_MS;
