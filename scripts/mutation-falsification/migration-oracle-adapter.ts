// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The adapter-specific runner for `test-migration-oracle/v1` (design.md
 * Decision #5, tasks.md 1.4/1.5). Accepts ONLY this one registered adapter
 * id; any other id is rejected before execution. Derives the exact command
 * (`node --import tsx scripts/test-migration/mutation-oracle.ts --structured`),
 * spawns it with a finite wall deadline and a bounded direct-stdout byte cap
 * enforced by a STREAMING counter (checked as chunks arrive, before they are
 * buffered/concatenated — never a post-hoc `Buffer.byteLength` check on an
 * already-fully-buffered string), records issued/incomplete/completed
 * markers via evidence-store.ts, and produces an AttemptReceipt.
 *
 * This adapter does NOT claim focused-check/complete-backstop semantics —
 * the migration oracle is self-contained (it already runs its own fixture-
 * scoped judges against its own fixture repos; there is no separate
 * "focused subset vs complete owning suite" split for it the way there is
 * for a real production suite like polyfill-connectors). Its receipt's
 * backstop axis is therefore always `not_applicable`, per design.md
 * Decision #5 ("does not claim focused selection, test-accounting
 * authority, or domain value").
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { digestOf } from "./canonicalize.ts";
import {
  issueAttemptMarker,
  publishCompleteReceipt,
  recordRecoveryReceipt,
  scanForIncompleteOrCorrupt,
} from "./evidence-store.ts";
import type { AttemptReceipt, IntentPacket } from "./schemas.ts";
import { ATTEMPT_SCHEMA } from "./schemas.ts";

export const MIGRATION_ORACLE_ADAPTER_ID = "test-migration-oracle/v1" as const;
/** The only registered adapterVersion this runner will execute. Any other version is rejected before spawn. */
export const MIGRATION_ORACLE_ADAPTER_VERSION = "1" as const;
const STRUCTURED_LINE_PREFIX = "MUTATION_ORACLE_STRUCTURED_JSON ";

export interface StructuredOracleReportShape {
  holes: string[];
  mutations: Array<{ caught: boolean; caughtBy: string; detail: string; name: string }>;
  ok: boolean;
  positiveControl: { detail: string; ok: boolean };
  rollback: { detail: string; ok: boolean };
}

function migrationOracleScriptPath(): string {
  return fileURLToPath(new URL("../test-migration/mutation-oracle.ts", import.meta.url));
}

/** The exact effective command this adapter ever derives — never caller-suppliable. */
export function deriveEffectiveCommand(): string[] {
  return [process.execPath, "--import", "tsx", migrationOracleScriptPath(), "--structured"];
}

export class UnregisteredAdapterError extends Error {
  constructor(adapterId: string) {
    super(`migration-oracle-adapter: rejecting unregistered/unrequested adapter id: ${adapterId}`);
    this.name = "UnregisteredAdapterError";
  }
}

interface SpawnWithLimitsResult {
  byteCapExceeded: boolean;
  deadlineFired: boolean;
  exitCode: number | null;
  signal: string | null;
  stdoutPrefix: string;
  stdoutTotalBytes: number;
}

/**
 * Spawns `command`, streaming-counting stdout bytes as they arrive (never
 * buffering first and measuring after). The moment the running total
 * crosses `byteCap`, the process group is killed and the result records
 * `byteCapExceeded: true` with only the bounded prefix retained — the
 * unbounded remainder is never buffered into memory at all. A separate wall
 * deadline kills the group if it fires first.
 */
function spawnWithLimits(command: string[], cwd: string, wallTimeMs: number, byteCap: number): Promise<SpawnWithLimitsResult> {
  return new Promise((resolvePromise, reject) => {
    const [file, ...rest] = command;
    if (!file) {
      reject(new Error("spawnWithLimits requires a non-empty command"));
      return;
    }
    const child = spawn(file, rest, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdoutPrefix = "";
    let stdoutTotalBytes = 0;
    let byteCapExceeded = false;
    let deadlineFired = false;
    let settled = false;

    const killGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };
    const timer = setTimeout(() => {
      deadlineFired = true;
      killGroup();
    }, wallTimeMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutTotalBytes += chunk.length;
      if (byteCapExceeded) {
        return; // Already over cap and killing; drop further bytes, do not buffer them.
      }
      if (stdoutTotalBytes > byteCap) {
        byteCapExceeded = true;
        // Retain only up to the cap from this chunk, never the full chunk.
        const roomLeft = byteCap - (stdoutTotalBytes - chunk.length);
        if (roomLeft > 0) {
          stdoutPrefix += chunk.subarray(0, roomLeft).toString();
        }
        killGroup();
        return;
      }
      stdoutPrefix += chunk.toString();
    });
    child.stderr?.on("data", () => {
      // stderr is not part of this adapter's bounded structured-output
      // contract; it is neither captured nor counted against the byte cap.
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode: code, signal, stdoutPrefix, stdoutTotalBytes, deadlineFired, byteCapExceeded });
    });
  });
}

export interface MigrationOracleAttemptOptions {
  cwd: string;
  directOutputByteCap: number;
  evidenceRoot: string;
  intent: IntentPacket;
  policyVersion: string;
  wallTimeMs: number;
}

/**
 * Runs one attempt of the migration-oracle adapter end to end: preflight
 * scan for incomplete/corrupt markers, reject an unregistered adapter id
 * before execution, issue a marker, spawn the derived command under bounded
 * wall-time and byte-cap limits, parse and validate the structured output,
 * and publish a complete AttemptReceipt. Returns the published receipt.
 *
 * Never interprets missing/partial/malformed output as success — any
 * failure to obtain valid structured output leaves the corresponding axis
 * `failed`, which `projection.ts` will always resolve to `inconclusive`.
 */
export async function runMigrationOracleAttempt(options: MigrationOracleAttemptOptions): Promise<AttemptReceipt> {
  if (options.intent.adapterId !== MIGRATION_ORACLE_ADAPTER_ID) {
    throw new UnregisteredAdapterError(options.intent.adapterId);
  }
  if (options.intent.adapterVersion !== MIGRATION_ORACLE_ADAPTER_VERSION) {
    throw new UnregisteredAdapterError(`${options.intent.adapterId}@${options.intent.adapterVersion}`);
  }
  await scanForIncompleteOrCorrupt(options.evidenceRoot);

  const attemptId = randomUUID();
  await issueAttemptMarker(options.evidenceRoot, attemptId, options.intent);

  const command = deriveEffectiveCommand();
  const trialKey = digestOf({
    intentDigest: options.intent.intentDigest,
    adapterVersion: options.intent.adapterVersion,
    policyVersion: options.policyVersion,
    command,
  });

  const startedAt = Date.now();
  let spawnResult: SpawnWithLimitsResult;
  try {
    spawnResult = await spawnWithLimits(command, options.cwd, options.wallTimeMs, options.directOutputByteCap);
  } catch (error) {
    // A spawn-level failure (e.g. the binary is missing) is a materialization
    // failure, not a focused-check result — record it honestly and still
    // publish a (failed) complete receipt rather than leaving the marker
    // incomplete forever.
    const receipt = buildFailureReceipt(
      attemptId,
      trialKey,
      options,
      "materialization",
      "spawn_error",
      (error as Error).message,
      Date.now() - startedAt
    );
    await publishCompleteReceipt(options.evidenceRoot, receipt);
    return receipt;
  }
  const runtimeMs = Date.now() - startedAt;

  if (spawnResult.deadlineFired) {
    const receipt = buildFailureReceipt(
      attemptId,
      trialKey,
      options,
      "focused",
      "wall_deadline_exceeded",
      `wall deadline of ${options.wallTimeMs}ms exceeded`,
      runtimeMs,
      spawnResult
    );
    await publishCompleteReceipt(options.evidenceRoot, receipt);
    return receipt;
  }
  if (spawnResult.byteCapExceeded) {
    const receipt = buildFailureReceipt(
      attemptId,
      trialKey,
      options,
      "focused",
      "direct_output_byte_cap_exceeded",
      `direct-output byte cap of ${options.directOutputByteCap} exceeded (observed ${spawnResult.stdoutTotalBytes} bytes before truncation)`,
      runtimeMs,
      spawnResult
    );
    await publishCompleteReceipt(options.evidenceRoot, receipt);
    return receipt;
  }

  let structured: StructuredOracleReportShape;
  try {
    structured = parseStructuredOutput(spawnResult.stdoutPrefix);
  } catch (error) {
    const receipt = buildFailureReceipt(
      attemptId,
      trialKey,
      options,
      "focused",
      "malformed_or_partial_output",
      (error as Error).message,
      runtimeMs,
      spawnResult
    );
    await publishCompleteReceipt(options.evidenceRoot, receipt);
    return receipt;
  }

  // The oracle's own exit code (0 = every case caught, positive control
  // clean, rollback proven) is the recognized owning-check result here —
  // this adapter never interprets missing output as success, and a
  // non-zero exit with valid structured output still means "focused
  // failed", never silently "ok".
  const focusedPassed = spawnResult.exitCode === 0 && structured.ok;
  const receipt: AttemptReceipt = {
    schema: ATTEMPT_SCHEMA,
    attemptId,
    trialKey,
    policyVersion: options.policyVersion,
    baseCommitSha: options.intent.baseCommitSha,
    mutantIdentity: null,
    judgeIdentity: digestOf({ script: migrationOracleScriptPath(), command }),
    environmentProfile: Object.keys(process.env),
    evidenceArtifacts: [],
    axes: {
      baseline: { status: "ok" },
      materialization: { status: "ok" },
      focused: focusedPassed
        ? { status: "ok" }
        : { status: "failed", failure: "oracle_reported_hole_or_failed_control", detail: JSON.stringify(structured) },
      // The migration oracle has no separate focused-vs-complete-backstop
      // split — see the file-level comment referencing design.md Decision
      // #5. This adapter never claims backstop semantics.
      backstop: { status: "not_applicable" },
      reachability: { status: "ok" },
      cleanup: { status: "ok" },
    },
    runtimeMs,
    attemptStatus: { exitCode: spawnResult.exitCode, signal: spawnResult.signal },
    referencedAccountingRunIds: [],
  };
  await publishCompleteReceipt(options.evidenceRoot, receipt);
  return receipt;
}

function buildFailureReceipt(
  attemptId: string,
  trialKey: string,
  options: MigrationOracleAttemptOptions,
  failingAxis: "materialization" | "focused",
  failure: string,
  detail: string,
  runtimeMs: number,
  spawnResult?: SpawnWithLimitsResult
): AttemptReceipt {
  return {
    schema: ATTEMPT_SCHEMA,
    attemptId,
    trialKey,
    policyVersion: options.policyVersion,
    baseCommitSha: options.intent.baseCommitSha,
    mutantIdentity: null,
    judgeIdentity: digestOf({ script: migrationOracleScriptPath(), command: deriveEffectiveCommand() }),
    environmentProfile: Object.keys(process.env),
    evidenceArtifacts: [],
    axes: {
      baseline: { status: "ok" },
      materialization: failingAxis === "materialization" ? { status: "failed", failure, detail } : { status: "ok" },
      focused: failingAxis === "focused" ? { status: "failed", failure, detail } : { status: "ok" },
      backstop: { status: "not_applicable" },
      reachability: { status: "unknown" },
      cleanup: { status: "ok" },
    },
    runtimeMs,
    attemptStatus: { exitCode: spawnResult?.exitCode ?? null, signal: spawnResult?.signal ?? null },
    referencedAccountingRunIds: [],
  };
}

/** Throws on missing/malformed structured output — never returns a partial or inferred report. Exported for direct fault-injection tests. */
export function parseStructuredOutput(stdout: string): StructuredOracleReportShape {
  const line = stdout.split("\n").find((entry) => entry.startsWith(STRUCTURED_LINE_PREFIX));
  if (!line) {
    throw new Error("migration-oracle-adapter: no structured-output line found in stdout (partial or missing output)");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(STRUCTURED_LINE_PREFIX.length));
  } catch (error) {
    throw new Error(`migration-oracle-adapter: structured-output line is not valid JSON: ${(error as Error).message}`);
  }
  const record = parsed as Partial<StructuredOracleReportShape> | null;
  if (
    !record ||
    typeof record !== "object" ||
    !Array.isArray(record.mutations) ||
    !Array.isArray(record.holes) ||
    typeof record.ok !== "boolean" ||
    !record.positiveControl ||
    !record.rollback
  ) {
    throw new Error("migration-oracle-adapter: structured output is missing a required field (case/control/rollback)");
  }
  return record as StructuredOracleReportShape;
}

export { recordRecoveryReceipt };
