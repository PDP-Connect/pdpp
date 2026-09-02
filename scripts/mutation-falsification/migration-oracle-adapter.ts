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

/**
 * The oracle's fixed seven-case inventory, defined HERE independently of
 * whatever a runtime report claims — mirrors the exact `name` literals and
 * policy-authorized `caughtBy` checks hardcoded in
 * scripts/test-migration/mutation-oracle.ts's `runMutationScenarios` (never
 * imported from there: this adapter must reject a report even if that
 * script itself were mutated/broken, not merely echo whatever it emits).
 * `parseStructuredOutput` requires the runtime `mutations` array to contain
 * EXACTLY one entry per case below — no missing, no extra, no duplicate
 * names — each with exactly its authorized `caughtBy`. This closes the gap
 * where a one-entry report was previously accepted as "well-formed".
 */
export const MIGRATION_ORACLE_CASES_V1 = [
  { name: "dropped test file", caughtBy: "executedSetEquivalence.missingAfter" },
  { name: "silently-skipped test", caughtBy: "skipReasonEquivalence.changed" },
  { name: "reduced assertion count", caughtBy: "assertionCountEquivalence.decreased" },
  { name: "changed skip reason (dynamic expression text)", caughtBy: "skipReasonEquivalence.changed" },
  { name: 'off-by-one "../" import specifier', caughtBy: "verifyFileImportsResolve" },
  { name: "stale literal source path referencing a renamed file", caughtBy: "scanFileForStaleLiteralPaths" },
  { name: "de-classifying rename (foo.test.ts -> foo-helper.ts)", caughtBy: "executedSetEquivalence.declassified" },
] as const;

/** Versioned digest of the case-set identity, folded into this adapter's judgeIdentity so a receipt is bound to the exact inventory it was validated against. */
export const MIGRATION_ORACLE_CASE_SET_DIGEST = digestOf({
  version: "MIGRATION_ORACLE_CASES_V1",
  cases: MIGRATION_ORACLE_CASES_V1,
});

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
    // Resolve on "close", not "exit": "exit" fires the instant the process
    // itself terminates, but stdio pipes can outlive the process (this
    // child is spawned `detached: true` as its own process-group leader —
    // a grandchild it spawned, or a lingering fd duplicate, can keep a pipe
    // open after the parent process has already exited). Resolving on
    // "exit" risked returning `stdoutPrefix` before every already-buffered
    // "data" event had actually been delivered. "close" fires only after
    // Node has observed EOF on every stdio stream, so `stdoutPrefix` is
    // guaranteed final by the time this resolves. exitCode/signal are
    // captured from "exit" (the only event that carries them) and reused
    // here.
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.on("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, signal: exitSignal, stdoutPrefix, stdoutTotalBytes, deadlineFired, byteCapExceeded });
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
    intentDigest: options.intent.intentDigest,
    policyVersion: options.policyVersion,
    baseCommitSha: options.intent.baseCommitSha,
    mutantIdentity: null,
    judgeIdentity: digestOf({ script: migrationOracleScriptPath(), command, caseSetDigest: MIGRATION_ORACLE_CASE_SET_DIGEST }),
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
    intentDigest: options.intent.intentDigest,
    policyVersion: options.policyVersion,
    baseCommitSha: options.intent.baseCommitSha,
    mutantIdentity: null,
    judgeIdentity: digestOf({
      script: migrationOracleScriptPath(),
      command: deriveEffectiveCommand(),
      caseSetDigest: MIGRATION_ORACLE_CASE_SET_DIGEST,
    }),
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

function fail(detail: string): never {
  throw new Error(`migration-oracle-adapter: structured output failed validation — ${detail}`);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    fail(`${label} must be a boolean, got ${JSON.stringify(value)}`);
  }
  return value;
}
function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}
/** `detail` may legitimately be empty (some oracle checks record no detail text); every other string field must be non-empty. */
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail(`${label} must be a string, got ${JSON.stringify(value)}`);
  }
  return value;
}

interface OkDetailPair {
  detail: string;
  ok: boolean;
}
function requireOkDetailPair(value: unknown, label: string): OkDetailPair {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  return { ok: requireBoolean(record.ok, `${label}.ok`), detail: requireString(record.detail, `${label}.detail`) };
}

/**
 * Validates ONE mutation-case entry's full shape (never just presence of
 * the array). A well-formed-but-wrong oracle — e.g. `caught: "true"`
 * (string, not boolean), a missing `caughtBy`, or a non-string `name` —
 * must fail here, not slip through as a cast.
 */
function requireMutationCase(
  value: unknown,
  index: number
): { caught: boolean; caughtBy: string; detail: string; name: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`mutations[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  return {
    name: requireNonEmptyString(record.name, `mutations[${index}].name`),
    caught: requireBoolean(record.caught, `mutations[${index}].caught`),
    caughtBy: requireNonEmptyString(record.caughtBy, `mutations[${index}].caughtBy`),
    detail: requireString(record.detail, `mutations[${index}].detail`),
  };
}

/**
 * Enforces MIGRATION_ORACLE_CASES_V1 against the runtime `mutations` array:
 * exactly one result per expected case name (no missing, no extra, no
 * duplicate), and each entry's `caughtBy` must equal the policy-authorized
 * value for that name. A report claiming only one of the seven cases (e.g.
 * the historically-accepted `{name:"x",...}` single-entry report) fails
 * here on both a missing-case and an unrecognized-name basis.
 */
function requireExactCaseInventory(
  mutations: Array<{ caught: boolean; caughtBy: string; detail: string; name: string }>
): void {
  const expectedByName = new Map(MIGRATION_ORACLE_CASES_V1.map((c) => [c.name as string, c.caughtBy as string]));
  const seenNames = new Set<string>();
  const duplicates: string[] = [];
  const unrecognized: string[] = [];
  const wrongCaughtBy: string[] = [];
  for (const mutation of mutations) {
    if (!expectedByName.has(mutation.name)) {
      unrecognized.push(mutation.name);
      continue;
    }
    if (seenNames.has(mutation.name)) {
      duplicates.push(mutation.name);
      continue;
    }
    seenNames.add(mutation.name);
    const authorizedCaughtBy = expectedByName.get(mutation.name);
    if (mutation.caughtBy !== authorizedCaughtBy) {
      wrongCaughtBy.push(
        `${mutation.name}: expected caughtBy ${JSON.stringify(authorizedCaughtBy)}, got ${JSON.stringify(mutation.caughtBy)}`
      );
    }
  }
  const missing = MIGRATION_ORACLE_CASES_V1.map((c) => c.name as string).filter((name) => !seenNames.has(name));
  if (missing.length > 0 || unrecognized.length > 0 || duplicates.length > 0 || wrongCaughtBy.length > 0) {
    fail(
      "mutations does not match the required MIGRATION_ORACLE_CASES_V1 inventory — " +
        `missing: ${JSON.stringify(missing)}, unrecognized/extra: ${JSON.stringify(unrecognized)}, ` +
        `duplicate: ${JSON.stringify(duplicates)}, wrong caughtBy: ${JSON.stringify(wrongCaughtBy)}`
    );
  }
}

/**
 * Throws on missing/malformed structured output — never returns a partial
 * or inferred report. This does the FULL schema validation the earlier
 * implementation skipped: every mutation-case entry's shape (not just
 * `Array.isArray`), the nested `positiveControl`/`rollback` objects' own
 * `ok`/`detail` fields (not just truthiness of the parent object), enum-
 * shaped fields, AND independently recomputes the derived invariants the
 * oracle itself claims to guarantee — `holes` must be EXACTLY the set of
 * mutation names with `caught: false` (in order), and `ok` must be exactly
 * `positiveControl.ok && holes.length === 0 && rollback.ok` (see
 * scripts/test-migration/mutation-oracle.ts's own `buildStructuredReport`,
 * which this recomputation mirrors). A report that is well-formed JSON but
 * internally inconsistent with its own claimed invariants (e.g. `ok: true`
 * despite a failed positive control, or a hole/caught-set disagreement) is
 * rejected here rather than trusted at face value.
 */
export function parseStructuredOutput(stdout: string): StructuredOracleReportShape {
  const matchingLines = stdout.split("\n").filter((entry) => entry.startsWith(STRUCTURED_LINE_PREFIX));
  if (matchingLines.length === 0) {
    throw new Error("migration-oracle-adapter: no structured-output line found in stdout (partial or missing output)");
  }
  if (matchingLines.length > 1) {
    throw new Error(
      `migration-oracle-adapter: expected exactly one structured-output line, found ${matchingLines.length} — never take the first and ignore the rest`
    );
  }
  const [line] = matchingLines;
  if (!line) {
    throw new Error("migration-oracle-adapter: no structured-output line found in stdout (partial or missing output)");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(STRUCTURED_LINE_PREFIX.length));
  } catch (error) {
    throw new Error(`migration-oracle-adapter: structured-output line is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("top-level structured output must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.mutations)) {
    fail("mutations must be an array");
  }
  const mutations = record.mutations.map((entry, index) => requireMutationCase(entry, index));
  const positiveControl = requireOkDetailPair(record.positiveControl, "positiveControl");
  const rollback = requireOkDetailPair(record.rollback, "rollback");
  if (!Array.isArray(record.holes) || !record.holes.every((entry) => typeof entry === "string")) {
    fail("holes must be an array of strings");
  }
  const holes = record.holes as string[];
  const ok = requireBoolean(record.ok, "ok");
  requireExactCaseInventory(mutations);

  // Independently recompute the derived invariants — never trust the
  // caller's own `holes`/`ok` fields at face value.
  const expectedHoles = mutations.filter((m) => !m.caught).map((m) => m.name);
  if (holes.length !== expectedHoles.length || holes.some((name, i) => name !== expectedHoles[i])) {
    fail(
      `holes ${JSON.stringify(holes)} does not match the mutations actually reported as uncaught ${JSON.stringify(expectedHoles)}`
    );
  }
  const expectedOk = positiveControl.ok && holes.length === 0 && rollback.ok;
  if (ok !== expectedOk) {
    fail(
      `ok=${ok} is inconsistent with its own reported inputs (positiveControl.ok=${positiveControl.ok}, holes.length=${holes.length}, rollback.ok=${rollback.ok} => expected ok=${expectedOk})`
    );
  }

  return { mutations, holes, ok, positiveControl, rollback };
}

export { recordRecoveryReceipt };
