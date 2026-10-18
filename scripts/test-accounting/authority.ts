// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  assertCleanSourceTree,
  type Counts,
  contentDigest,
  gitHead,
  gitPath,
  gitRoot,
  type Profile,
  type ProfileEntry,
  type Receipt,
  RUN_AUTHORITY_SCHEMA,
  RUN_COMPLETION_SCHEMA,
  readManifest,
  receiptBinding,
  type Suite,
  selectedRuns,
  sourceTreeDigest,
  trackedFiles,
  treeDigest,
  unaccountedExecutableTests,
  validateIncludeGlobsClassifyExecutable,
  verifyReceipts,
} from "./inventory.ts";
import {
  readStructuredChildResult,
  StructuredNodeSummaryAccumulator,
  type StructuredSummary,
  structuredNodeSummary,
  structuredPythonSummary,
} from "./receipt.ts";

const AUTHORITY_TTL_MS = 2 * 60 * 60 * 1000;
const OPTIONAL_PREDICATE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
// Numeric PGID -> the tracker that owns it. See trackProcessGroup.
const liveProcessGroups = new Map<number, object>();

function signalProcessGroups(): void {
  for (const pid of liveProcessGroups.keys()) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        reportProgress(`could not signal process group ${pid} during shutdown`);
      }
    }
  }
}

// SIGKILL cannot run cleanup; local test-sandbox cgroup cleanup covers that limit.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const forwardTermination = () => {
    signalProcessGroups();
    process.removeListener(signal, forwardTermination);
    process.kill(process.pid, signal);
  };
  process.on(signal, forwardTermination);
}
process.on("exit", signalProcessGroups);

function fail(message: string): never {
  throw new Error(`test accounting authority: ${message}`);
}
function instant(value: number): string {
  return new Date(value).toISOString();
}

interface AuthorityArgs {
  base?: string;
  profile?: string;
  run?: boolean;
  suites: string[];
}

function parseArgs(argv: string[]): AuthorityArgs {
  const value: AuthorityArgs = { suites: [] };
  const take = (index: number, flag: string): string => {
    const item = argv[index + 1];
    if (!item || item.startsWith("--")) {
      fail(`${flag} requires exactly one value`);
    }
    return item;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run") {
      if (value.run) {
        fail("--run may appear only once");
      }
      value.run = true;
    } else if (arg === "--suite") {
      value.suites.push(take(index, arg));
      index += 1;
    } else if (arg === "--profile") {
      value.profile = take(index, arg);
      index += 1;
    } else if (arg === "--base") {
      value.base = take(index, arg);
      index += 1;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (!value.run) {
    fail("use --run");
  }
  if (
    new Set(value.suites).size !== value.suites.length ||
    (value.suites.includes("all") && value.suites.length !== 1)
  ) {
    fail("suite selection must be unique and cannot combine all with other suites");
  }
  return value;
}

async function writeNew(path: string, value: unknown): Promise<void> {
  const fd = await open(path, "wx");
  try {
    await fd.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await fd.sync();
  } finally {
    await fd.close();
  }
}

interface CaptureResult {
  exit_code: number;
  node_summary?: StructuredSummary;
  node_summary_error?: string;
  retained_capture_bytes: number;
  signal: string | null;
  stderr: string;
  stderr_truncated: boolean;
  stdout: string;
  stdout_truncated: boolean;
}
interface TranscriptHandle {
  write: (chunk: string) => Promise<unknown>;
}

function configuredDeadline(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Ten minutes is over 27x the slowest measured suite (22s), even under load.
const LEAF_DEADLINE_MS = configuredDeadline("PDPP_ACCOUNTING_LEAF_DEADLINE_MS", 600_000);
// The site prepare command took about 1.4s in the focused authority tests; two
// minutes leaves substantial room for a loaded checkout while bounding hangs.
const PREPARE_DEADLINE_MS = configuredDeadline("PDPP_ACCOUNTING_PREPARE_DEADLINE_MS", 120_000);
// The 300s silence budget is nearly 3x the 108s full gate under host load and
// is independent of the total runtime deadline for continuously chatty leaves.
const LEAF_STALL_BUDGET_MS = configuredDeadline("PDPP_ACCOUNTING_STALL_BUDGET_MS", 300_000);
const CAPTURE_TAIL_BYTES = 64 * 1024;
const KILL_SETTLE_GRACE_MS = 250;
// How often the watchdog re-checks for silence, and the cadence of the heartbeat
// line printed while a leaf is quiet. Short enough that an operator sees the run
// is alive within seconds of starting it, long enough to add no measurable cost.
// Overridable so lifecycle tests can observe a watchdog tick in milliseconds
// instead of waiting out the production cadence.
const PROGRESS_TICK_MS = configuredDeadline("PDPP_ACCOUNTING_PROGRESS_TICK_MS", 5000);

/**
 * Emit an operator-facing progress line.
 *
 * Deliberately writes to the authority's OWN stderr and nowhere else. The
 * transcript is a digest-verified accounting artifact (verifyTranscript hashes
 * the file and requires `start` first / `end` last), and the child's stdout is
 * parsed for the structured accounting result and event lines, so progress must
 * never enter either. stderr of the authority process is not captured, not
 * hashed, and not parsed by anything — it is the one channel where progress is
 * free of accounting consequences.
 */
function reportProgress(text: string): void {
  process.stderr.write(`[test-accounting] ${text}\n`);
}

/**
 * SIGKILLs a child's process group. Returns true once the group needs no more
 * signals: the kill landed, or the group was already gone (ESRCH). Any other
 * failure falls back to killing the direct child and returns false, so the group
 * stays registered for a later attempt.
 */
function killProcessGroup(child: ReturnType<typeof spawn>): boolean {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return false;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return true;
    }
    reportProgress(`could not signal process group ${child.pid}; falling back to direct child kill`);
    child.kill("SIGKILL");
    return false;
  }
}

/**
 * Register a detached child's process group for shutdown cleanup. The registry
 * maps each numeric PGID to the tracker that owns it. Once a group's members have
 * exited, its PGID can belong to an unrelated group, and a newer tracker may
 * already have registered the same number. So a tracker signals and unregisters
 * only while it still owns its PGID, and never removes an entry it does not own.
 * A kill that lands, or finds the group already gone, unregisters it at that
 * moment, so no later kill, release or shutdown path may signal it again. `kill`
 * SIGKILLs the group while it is owned. `release` SIGKILLs it only if no kill has
 * landed, which catches a same-group descendant that ignored or redirected its
 * stdio and would otherwise outlive the leaf, and then unregisters it for good.
 */
export function trackProcessGroup(child: ReturnType<typeof spawn>): { kill: () => void; release: () => void } {
  const owner = {};
  let pid: number | undefined;
  let unregistered = false;
  const owns = () => pid !== undefined && liveProcessGroups.get(pid) === owner;
  const register = () => {
    const { pid: childPid } = child;
    if (!unregistered && childPid !== undefined) {
      pid = childPid;
      liveProcessGroups.set(pid, owner);
    }
  };
  const unregister = () => {
    unregistered = true;
    if (pid !== undefined && liveProcessGroups.get(pid) === owner) {
      liveProcessGroups.delete(pid);
    }
  };
  const kill = () => {
    if (unregistered) {
      return;
    }
    // A tracker that lost its PGID to a newer tracker has no group left to signal.
    if (!owns() || killProcessGroup(child)) {
      unregister();
    }
  };
  const release = () => {
    if (unregistered) {
      return;
    }
    if (owns()) {
      killProcessGroup(child);
    }
    unregister();
  };
  child.once("spawn", register);
  child.once("error", release);
  register();
  return { kill, release };
}

/** Test seam: the numeric PGIDs the shutdown handler would signal right now. */
export function liveProcessGroupsForTest(): number[] {
  return [...liveProcessGroups.keys()];
}

function destroyChildPipes(child: ReturnType<typeof spawn>): void {
  child.stdout?.resume();
  child.stderr?.resume();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function capture(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  transcript: TranscriptHandle,
  start: { run_id: string; suite: string; profile: string; files: string[] },
  parseNodeEvents = false
): Promise<CaptureResult> {
  return new Promise((resolveResult, reject) => {
    const [file, ...rest] = command;
    if (!file) {
      reject(new Error("capture requires a non-empty command"));
      return;
    }
    const label = `${start.suite}/${start.profile}`;
    const startedAt = Date.now();
    reportProgress(`${label}: started (${start.files.length} files)`);
    const child = spawn(file, rest, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const group = trackProcessGroup(child);
    let stdoutTail = Buffer.alloc(0);
    let stderrTail = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const nodeSummary = parseNodeEvents ? new StructuredNodeSummaryAccumulator() : undefined;
    let bytes = 0;
    let lastOutputAt = Date.now();
    let stalled = false;
    let deadlineExpired = false;
    let nodeSummaryError: string | undefined;
    let writeFailure: unknown;
    let writeChain = Promise.resolve();
    let pendingWrites = 0;
    const appendTail = (current: Buffer, chunk: Buffer, stream: "stdout" | "stderr") => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.length > CAPTURE_TAIL_BYTES) {
        if (stream === "stdout") {
          stdoutTruncated = true;
        } else {
          stderrTruncated = true;
        }
      }
      return combined.length > CAPTURE_TAIL_BYTES ? combined.subarray(combined.length - CAPTURE_TAIL_BYTES) : combined;
    };
    const append = (stream: "stdout" | "stderr", text: string) => {
      const chunk = Buffer.from(text);
      if (stream === "stdout") {
        stdoutTail = appendTail(stdoutTail, chunk, stream);
        if (nodeSummary && !nodeSummaryError) {
          try {
            nodeSummary.write(text);
          } catch (error) {
            nodeSummaryError = (error as Error).message;
          }
        }
      } else {
        stderrTail = appendTail(stderrTail, chunk, stream);
      }
      // Progress is measured as output ARRIVING, which is what distinguishes a
      // slow-but-live leaf from a wedged one. Only the clock and a byte counter
      // move here; the captured text and the transcript record are untouched.
      bytes += chunk.length;
      lastOutputAt = Date.now();
      const record = `${JSON.stringify({ event: stream, run_id: start.run_id, chunk: text })}\n`;
      child.stdout?.pause();
      child.stderr?.pause();
      pendingWrites += 1;
      writeChain = writeChain
        .then(async () => {
          if (!writeFailure) {
            await transcript.write(record);
          }
        })
        .catch((error: unknown) => {
          writeFailure ??= error;
          killForFailure();
        })
        .finally(() => {
          pendingWrites -= 1;
          if (!writeFailure) {
            child.stdout?.resume();
            child.stderr?.resume();
          }
        });
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));

    let settled = false;
    let settling = false;
    let killSettleTimer: NodeJS.Timeout | undefined;
    let exitSettleTimer: NodeJS.Timeout | undefined;
    let ticker: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    // The single terminal path. Every outcome clears every timer and releases the
    // process group exactly once, independently of any pending transcript write,
    // so a settled capture can neither keep the authority process alive nor
    // signal the group again.
    const finish = (outcome: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(ticker);
      clearTimeout(deadlineTimer);
      clearTimeout(killSettleTimer);
      clearTimeout(exitSettleTimer);
      group.release();
      outcome();
    };
    const settleFailureAfterKill = () => {
      if (killSettleTimer) {
        return;
      }
      killSettleTimer = setTimeout(() => {
        destroyChildPipes(child);
        finish(() => reject(captureFailure() ?? new Error(`${label} child was killed`)));
      }, KILL_SETTLE_GRACE_MS);
    };
    const killForFailure = () => {
      try {
        group.kill();
      } finally {
        destroyChildPipes(child);
        settleFailureAfterKill();
      }
    };
    const killForDeadline = () => {
      deadlineExpired = true;
      reportProgress(`${label}: exceeded total deadline ${Math.round(LEAF_DEADLINE_MS / 1000)}s; killing`);
      killForFailure();
    };
    const captureFailure = (): Error | unknown | undefined => {
      if (writeFailure) {
        return writeFailure;
      }
      if (stalled) {
        return new Error(
          `${label} produced no output for ${Math.round(LEAF_STALL_BUDGET_MS / 1000)}s (stall budget PDPP_ACCOUNTING_STALL_BUDGET_MS) and was killed`
        );
      }
      if (deadlineExpired) {
        return new Error(
          `${label} exceeded total leaf deadline ${Math.round(LEAF_DEADLINE_MS / 1000)}s (PDPP_ACCOUNTING_LEAF_DEADLINE_MS) and was killed`
        );
      }
      return undefined;
    };
    const completeCapture = (code: number | null, signal: NodeJS.Signals | null): CaptureResult => {
      let summary: StructuredSummary | undefined;
      if (nodeSummary && !nodeSummaryError) {
        try {
          summary = nodeSummary.finish();
        } catch (error) {
          nodeSummaryError = (error as Error).message;
        }
      }
      reportProgress(
        `${label}: exit ${code ?? "null"}${signal ? ` (signal ${signal})` : ""} after ${Math.round((Date.now() - startedAt) / 1000)}s`
      );
      return {
        exit_code: code ?? 1,
        signal: signal ?? null,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        stdout: stdoutTail.toString(),
        stderr: stderrTail.toString(),
        retained_capture_bytes: stdoutTail.length + stderrTail.length,
        ...(summary ? { node_summary: summary } : {}),
        ...(nodeSummaryError ? { node_summary_error: nodeSummaryError } : {}),
      };
    };
    // The leaf deadline stays armed until the drain and the final transcript
    // write finish, so a wedged transcript write cannot outlive it. Re-ref the
    // timer here: with no child handle left, an unref'd timer would let the
    // process exit while this promise is still pending.
    const settleFromExit = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled || settling) {
        return;
      }
      settling = true;
      clearInterval(ticker);
      clearTimeout(exitSettleTimer);
      deadlineTimer?.ref();
      // Signal the group before waiting on the write chain. The pipes are closed, so
      // the drain needs nothing more from the group, and a slow drain must not hold
      // a registration whose PGID may be reused once the group's members exit.
      group.kill();
      try {
        await writeChain;
        if (settled) {
          return;
        }
        const failure = captureFailure();
        if (failure) {
          finish(() => reject(failure));
          return;
        }
        const result = completeCapture(code, signal);
        finish(() => resolveResult(result));
      } catch (error) {
        finish(() => reject(error));
      }
    };

    deadlineTimer = setTimeout(killForDeadline, LEAF_DEADLINE_MS);
    deadlineTimer.unref?.();

    // Watchdog + heartbeat share one timer: every tick reports liveness, and a
    // tick that finds the silence older than the declared budget kills the leaf
    // and says so. A leaf that keeps producing output resets `lastOutputAt` and
    // is never killed, however long it runs.
    ticker = setInterval(() => {
      const quietMs = Date.now() - lastOutputAt;
      if (quietMs >= LEAF_STALL_BUDGET_MS) {
        stalled = true;
        clearInterval(ticker);
        reportProgress(
          `${label}: STALLED — no output for ${Math.round(quietMs / 1000)}s (budget ${Math.round(LEAF_STALL_BUDGET_MS / 1000)}s); killing`
        );
        killForFailure();
        return;
      }
      reportProgress(
        `${label}: running ${Math.round((Date.now() - startedAt) / 1000)}s, ${bytes} bytes, quiet ${Math.round(quietMs / 1000)}s`
      );
    }, PROGRESS_TICK_MS);
    ticker.unref?.();

    child.on("error", (error) => {
      finish(() => reject(error));
    });
    // After the leaf exits, the pipes normally end on their own once the output is
    // drained. Leftover group members are killed first so a descendant holding the
    // pipes releases them; only then, if the pipes are idle (nothing buffered, no
    // transcript write pending), is a holder outside the group assumed and the
    // pipes destroyed. Anything still draining is waited for, bounded by the leaf
    // deadline, so complete events are never discarded.
    child.on("exit", (code, signal) => {
      clearInterval(ticker);
      const settleWhenDrained = () => {
        if (settled || settling) {
          return;
        }
        const buffered = (child.stdout?.readableLength ?? 0) + (child.stderr?.readableLength ?? 0);
        if (pendingWrites > 0 || buffered > 0) {
          exitSettleTimer = setTimeout(settleWhenDrained, KILL_SETTLE_GRACE_MS);
          return;
        }
        destroyChildPipes(child);
        settleFromExit(code, signal).catch((error: unknown) => {
          reportProgress(`${label}: could not settle capture after child exit: ${String(error)}`);
        });
      };
      exitSettleTimer = setTimeout(() => {
        group.kill();
        exitSettleTimer = setTimeout(settleWhenDrained, KILL_SETTLE_GRACE_MS);
      }, KILL_SETTLE_GRACE_MS);
    });
    child.on("close", async (code, signal) => {
      await settleFromExit(code, signal);
    });
  });
}
/**
 * Test seam over the real `capture` above — same spawn, same append, same
 * watchdog, with the transcript replaced by a sink so a behavioral test can
 * exercise stall-vs-progress discrimination without issuing a receipt. Kept
 * deliberately thin: it adds no logic of its own, so a test through this seam
 * fails exactly when `capture` regresses.
 */
export function runCaptureForTest(
  command: string[],
  cwd: string,
  parseNodeEvents = false,
  writeTranscript: (chunk: string) => Promise<unknown> = () => Promise.resolve()
): Promise<CaptureResult> {
  return capture(
    command,
    cwd,
    process.env,
    { write: writeTranscript },
    { run_id: "test", suite: "fixture", profile: "fixture", files: [] },
    parseNodeEvents
  );
}

/**
 * Materialize a suite's declared generated prerequisites before its children run.
 *
 * Some suites import build artifacts that are gitignored on purpose (e.g. the
 * site's `src/generated/spec-front-matter.ts`, assembled from the normative root
 * spec by apps/site/scripts/sync-spec-docs.mjs). `predev`/`prebuild` build those
 * for the dev and build paths, but the accounting runner spawns the test child
 * directly and so never triggered them — the artifact was simply absent and the
 * import failed closed.
 *
 * Runs with the suite's own cwd and environment so a prepare command sees exactly
 * what its children will see. Failure is fatal and attributed to the suite: a
 * prerequisite that cannot be built must never look like a passing test run.
 * The caller re-asserts a clean source tree afterwards, so a prepare command that
 * writes a TRACKED file is still caught by the existing clean-tree gate.
 */
function prepareSuite(suite: Suite, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const command = suite.prepare;
  if (!command) {
    return Promise.resolve();
  }
  const [file, ...rest] = command;
  if (!file) {
    return Promise.reject(new Error(`${suite.id} prepare command is empty`));
  }
  reportProgress(`${suite.id}: preparing (${command.join(" ")})`);
  return new Promise((resolvePrepare, reject) => {
    const child = spawn(file, rest, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const group = trackProcessGroup(child);
    let output = Buffer.alloc(0);
    let deadlineExpired = false;
    let settled = false;
    let killSettleTimer: NodeJS.Timeout | undefined;
    let exitSettleTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(exitSettleTimer);
      if (killSettleTimer) {
        clearTimeout(killSettleTimer);
      }
      group.release();
      if (code === 0 && !signal && !deadlineExpired) {
        resolvePrepare();
        return;
      }
      reject(
        new Error(
          deadlineExpired
            ? `${suite.id} prepare exceeded deadline ${Math.round(PREPARE_DEADLINE_MS / 1000)}s (PDPP_ACCOUNTING_PREPARE_DEADLINE_MS) and was killed`
            : `${suite.id} prepare failed (exit ${code ?? "null"}${signal ? `, signal ${signal}` : ""}): ${output.toString().trim()}`
        )
      );
    };
    const appendOutput = (chunk: Buffer) => {
      const combined = Buffer.concat([output, chunk]);
      output =
        combined.length > CAPTURE_TAIL_BYTES ? combined.subarray(combined.length - CAPTURE_TAIL_BYTES) : combined;
    };
    child.stdout?.on("data", (chunk) => {
      appendOutput(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      appendOutput(chunk);
    });
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      reportProgress(`${suite.id}: prepare exceeded deadline ${Math.round(PREPARE_DEADLINE_MS / 1000)}s; killing`);
      try {
        group.kill();
      } finally {
        destroyChildPipes(child);
        killSettleTimer = setTimeout(() => {
          destroyChildPipes(child);
          finish(null, null);
        }, KILL_SETTLE_GRACE_MS);
      }
    }, PREPARE_DEADLINE_MS);
    deadlineTimer.unref?.();
    child.on("error", (error) => {
      clearTimeout(deadlineTimer);
      clearTimeout(exitSettleTimer);
      if (killSettleTimer) {
        clearTimeout(killSettleTimer);
      }
      group.release();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("exit", (code, signal) => {
      clearTimeout(deadlineTimer);
      exitSettleTimer = setTimeout(() => {
        group.kill();
        destroyChildPipes(child);
        finish(code, signal);
      }, KILL_SETTLE_GRACE_MS);
    });
    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}

/**
 * Test seam over the real `prepareSuite` above — same spawn, same env
 * composition, same failure attribution. Kept deliberately thin so a test
 * through this seam fails exactly when `prepareSuite` regresses.
 */
export function runPrepareForTest(suite: Suite, root: string): Promise<void> {
  return prepareSuite(suite, resolve(root, suite.cwd), suiteEnvironment(process.env, "default", suite, root));
}

function requiredByDefault(entry: ProfileEntry): boolean {
  return typeof entry === "string" || entry.required !== false;
}
function authorityDirectory(root: string): string {
  return resolve(gitPath("test-accounting", root), "runs");
}
function assertChildResult(
  result: unknown,
  issued: { run_id: string; nonce: string; suite: string; profile: string; files: string[] }
): Counts {
  const value = result as {
    run_id?: string;
    nonce?: string;
    suite?: string;
    profile?: string;
    files?: string[];
    counts?: Counts;
  } | null;
  if (
    !value ||
    value.run_id !== issued.run_id ||
    value.nonce !== issued.nonce ||
    value.suite !== issued.suite ||
    value.profile !== issued.profile
  ) {
    fail(`${issued.suite}/${issued.profile} child did not return its issued authority`);
  }
  if (JSON.stringify(value.files) !== JSON.stringify(issued.files)) {
    fail(`${issued.suite}/${issued.profile} child changed its issued selection`);
  }
  if (!value.counts || typeof value.counts !== "object") {
    fail(`${issued.suite}/${issued.profile} child omitted structured counts`);
  }
  return value.counts;
}
// Node resolves a bare relative --test-reporter value (no leading ./) as a
// package specifier, not a file path, and fails closed. execute.mjs used to
// paper over this by always resolving the reporter to an absolute path
// before spawning; direct leaves must do the same since they run from an
// arbitrary suite cwd, not necessarily the repo root.
function resolveReporterArgument(command: string[], root: string): string[] {
  const resolved = [...command];
  const index = resolved.indexOf("--test-reporter");
  const argument = resolved[index + 1];
  if (index !== -1 && argument) {
    resolved[index + 1] = resolve(root, argument);
  }
  return resolved;
}
export function applyLocalNodeTestConcurrency(command: string[], isCi = Boolean(process.env.CI)): string[] {
  if (
    isCi ||
    command[0] !== "node" ||
    !command.includes("--test") ||
    command.some((argument) => argument === "--test-concurrency" || argument.startsWith("--test-concurrency="))
  ) {
    return command;
  }
  const testIndex = command.indexOf("--test");
  const bounded = [...command];
  bounded.splice(testIndex + 1, 0, "--test-concurrency=2");
  return bounded;
}
interface Run {
  files: string[];
  index: number;
  profile: Profile;
  suite: Suite;
}
export function suiteEnvironment(
  inherited: NodeJS.ProcessEnv,
  profile: string,
  suite: Suite,
  root = process.cwd()
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...inherited, PDPP_TEST_PROFILE: profile, ...(suite.environment ?? {}) };
  const tsconfigPath = environment.TSX_TSCONFIG_PATH;
  if (tsconfigPath && !isAbsolute(tsconfigPath)) {
    environment.TSX_TSCONFIG_PATH = resolve(root, suite.cwd, tsconfigPath);
  }
  for (const name of suite.environment_unset ?? []) {
    delete environment[name];
  }
  return environment;
}
function leafCommand(run: Run, authorityPath: string, issuedArgv: string[]): string[] | null {
  if (run.suite.zero_tests) {
    return null;
  }
  const command = [...issuedArgv];
  if (run.suite.authority_argument) {
    command.push(run.suite.authority_argument, authorityPath);
  }
  if (run.suite.execution === "direct") {
    command.push(...run.files);
  }
  return command;
}
export function assertIssuedArgvMatchesCommand(issuedArgv: string[], command: string[] | null): void {
  if (command && JSON.stringify(command.slice(0, issuedArgv.length)) !== JSON.stringify(issuedArgv)) {
    fail("executed command differs from the argv bound into its authority and receipt");
  }
}
function observedCounts(
  run: Run,
  observed: CaptureResult,
  issued: { run_id: string; nonce: string; suite: string; profile: string; files: string[] }
): Counts {
  if (run.suite.zero_tests) {
    return {
      assertions: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      skip_reasons: {},
      planned_files: 0,
      completed_files: 0,
      zero_test_declaration: true,
    };
  }
  if (run.suite.execution === "authority-runner") {
    if (observed.stdout_truncated) {
      throw new Error("authority-runner stdout exceeded the retained output limit; child result was truncated");
    }
    return assertChildResult(readStructuredChildResult(observed.stdout), issued);
  }
  let counts: Counts;
  if (run.suite.loader === "node-test") {
    if (observed.node_summary_error) {
      throw new Error(observed.node_summary_error);
    }
    counts = observed.node_summary ?? structuredNodeSummary(observed.stdout);
  } else if (run.suite.loader === "python-unittest") {
    if (observed.stdout_truncated || observed.stderr_truncated) {
      throw new Error("python unittest output exceeded the retained output limit; summary was truncated");
    }
    counts = structuredPythonSummary(observed.stdout + observed.stderr, observed.exit_code);
  } else {
    counts = {
      assertions: issued.files.length,
      passed: observed.exit_code === 0 ? issued.files.length : 0,
      failed: observed.exit_code === 0 ? 0 : 1,
      skipped: 0,
      skip_reasons: {},
    };
  }
  return {
    ...counts,
    planned_files: issued.files.length,
    completed_files: observed.exit_code === 0 ? issued.files.length : 0,
  };
}

const SUITE_CONCURRENCY_ENV = "PDPP_ACCOUNTING_SUITE_CONCURRENCY";
// Measured on the full gate (test-ab -n 3): width 3 vs 2 is noise on wall time
// and CPU-seconds and costs ~6% more peak memory, because root-node (~22s,
// wait-bound) is the critical path and one lane for it plus one for the rest
// already reaches that floor.
const LOCAL_SUITE_CONCURRENCY = 2;

/**
 * How many suite/profile runs may execute at once.
 *
 * Each run keeps its own issued authority, transcript, deadlines and process
 * group, so overlap changes scheduling only, not what each run proves. At the
 * local default (2) the full gate measured 35-37% less wall time and 23% more
 * peak memory than serial order, with non-overlapping run ranges. CPU-seconds
 * rose by a median of 8-9%, within the run-to-run range. Locally the default is
 * LOCAL_SUITE_CONCURRENCY; in CI it is 1 unless the workflow sets the variable
 * explicitly, because a CI runner's core count is not known here and each Node
 * leaf already sizes itself to the machine there (see applyLocalNodeTestConcurrency).
 */
export function suiteConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SUITE_CONCURRENCY_ENV];
  if (raw === undefined || raw === "") {
    return env.CI ? 1 : LOCAL_SUITE_CONCURRENCY;
  }
  if (!POSITIVE_INTEGER_PATTERN.test(raw)) {
    fail(`${SUITE_CONCURRENCY_ENV} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return Number.parseInt(raw, 10);
}

/**
 * Split runs into ordered phases of [runs, concurrency limit].
 *
 * Runs go in manifest order, which lists the long suites (root-node,
 * scratch-lifecycle) first, so a greedy pool starts the critical path at once.
 * A suite with a `prepare` step writes generated files into the shared checkout
 * (site: apps/site/src/generated and content/docs), and root-node's
 * authority-prepare test deletes and rebuilds that same artifact, so a
 * concurrent site run can lose its import mid-run. Such suites therefore run
 * alone, after every other run has finished. Concurrency 1 keeps the exact
 * manifest order.
 */
export function schedulePhases(runs: Run[], concurrency: number): [Run[], number][] {
  if (concurrency <= 1) {
    return [[runs, 1]];
  }
  const phases: [Run[], number][] = [
    [runs.filter((run) => !run.suite.prepare), concurrency],
    [runs.filter((run) => run.suite.prepare), 1],
  ];
  return phases.filter(([phaseRuns]) => phaseRuns.length > 0);
}

/**
 * Run `work` over `runs` with at most `limit` in flight. Once `stopped()` is
 * true, or any run throws, no new run starts; runs already in flight finish
 * (each is bounded by its own deadlines) and the first thrown error is rethrown.
 */
async function runPool(
  runs: Run[],
  limit: number,
  work: (run: Run) => Promise<void>,
  stopped: () => boolean
): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  // A worker takes the next run only after its previous run finishes;
  // parallelism comes from starting `limit` workers.
  const worker = async (): Promise<void> => {
    const run = runs[next];
    if (errors.length > 0 || stopped() || !run) {
      return;
    }
    next += 1;
    try {
      await work(run);
    } catch (error) {
      errors.push(error);
    }
    await worker();
  };
  await Promise.all(Array.from({ length: Math.min(limit, runs.length) }, worker));
  if (errors.length > 0) {
    throw errors[0];
  }
}

function runFailed({ observed, counts }: CompletedRun): boolean {
  return observed.exit_code !== 0 || observed.signal !== null || counts.protocol_error !== undefined;
}

function sourceTreeDirty(root: string): boolean {
  try {
    assertCleanSourceTree(root);
    return false;
  } catch {
    return true;
  }
}

interface RunContext {
  baseSha: string;
  directory: string;
  env: NodeJS.ProcessEnv;
  head: string;
  manifestSha256: string;
  root: string;
  sourceTree: string;
  total: number;
}
interface CompletedRun {
  authorityPath: string;
  counts: Counts;
  endedAt: string;
  index: number;
  issued: {
    schema: string;
    run_id: string;
    nonce: string;
    issued_at: string;
    expires_at: string;
    suite: string;
    profile: string;
    files: string[];
    cwd: string;
    argv: string[];
    base_sha: string;
    head_sha: string;
    source_tree_sha256: string;
    selection_tree_sha256: string;
    manifest_sha256: string;
  };
  observed: CaptureResult;
  startedAt: string;
  transcriptPath: string;
}

/** Issue the run's authority, execute its leaf, and close its transcript. */
async function executeRun(run: Run, context: RunContext): Promise<CompletedRun> {
  const { root, env, directory } = context;
  reportProgress(`[${run.index + 1}/${context.total}] ${run.suite.id}/${run.profile.id ?? ""}`);
  const runId = randomUUID();
  const nonce = randomUUID();
  const issuedAt = instant(Date.now());
  const expiresAt = instant(Date.now() + AUTHORITY_TTL_MS);
  const profileId = run.profile.id ?? "";
  const effectiveCommand = applyLocalNodeTestConcurrency(
    resolveReporterArgument(run.suite.command ?? [], root),
    Boolean(process.env.CI)
  );
  const issued = {
    schema: RUN_AUTHORITY_SCHEMA,
    run_id: runId,
    nonce,
    issued_at: issuedAt,
    expires_at: expiresAt,
    suite: run.suite.id,
    profile: profileId,
    files: run.files,
    cwd: run.suite.cwd,
    argv: effectiveCommand,
    base_sha: context.baseSha,
    head_sha: context.head,
    source_tree_sha256: context.sourceTree,
    selection_tree_sha256: treeDigest(root, context.head, run.files),
    manifest_sha256: context.manifestSha256,
  };
  const authorityPath = resolve(directory, `${runId}.authority.json`);
  await writeNew(authorityPath, issued);
  const transcriptPath = resolve(directory, `${runId}.transcript`);
  const transcript = await open(transcriptPath, "wx");
  const startedAt = instant(Date.now());
  await transcript.write(
    `${JSON.stringify({ event: "start", run_id: runId, nonce, started_at: startedAt, suite: issued.suite, profile: issued.profile, files: issued.files, cwd: issued.cwd, argv: issued.argv })}\n`
  );
  const command = leafCommand(run, authorityPath, issued.argv);
  assertIssuedArgvMatchesCommand(issued.argv, command);
  // Keep the effective environment and cwd explicit so the issued command,
  // transcript, and child process all describe the same execution context.
  // One environment and cwd for both the prepare step and the children, so a
  // prerequisite is always built under the same resolver config that will load it.
  const suiteCwd = resolve(root, run.suite.cwd);
  const suiteEnv = suiteEnvironment(env, profileId, run.suite, root);
  let observed: CaptureResult;
  try {
    await prepareSuite(run.suite, suiteCwd, suiteEnv);
    observed = command
      ? await capture(
          command,
          suiteCwd,
          suiteEnv,
          transcript,
          issued,
          run.suite.loader === "node-test" && run.suite.execution !== "authority-runner"
        )
      : {
          exit_code: 0,
          signal: null,
          stdout_truncated: false,
          stderr_truncated: false,
          stdout: "",
          stderr: "",
          retained_capture_bytes: 0,
        };
    if (!command) {
      reportProgress(`${issued.suite}/${issued.profile}: zero-test declaration, nothing spawned`);
    }
  } catch (error) {
    await transcript.close();
    throw error;
  }
  // Resolve the final exit_code (including the protocol-error coercion
  // below) BEFORE the transcript's `end` event is written. The transcript
  // is a digest-verified, append-only artifact — once its `end` event is
  // written and the file is hashed into the receipt, that exit_code can
  // never change. Writing `end` from `observed.exit_code` before this
  // coercion ran let the transcript record the child process's literal
  // exit code (often 0) while the receipt later recorded the coerced code
  // (1, after a protocol error), so `verifyTranscript`'s equality check
  // failed on every run where a suite exited 0 but its structured output
  // failed to parse — a receipt/transcript split, not a concurrency
  // artifact.
  let counts: Counts;
  try {
    counts = observedCounts(run, observed, issued);
  } catch (error) {
    const err = error as Error;
    counts = {
      assertions: 0,
      passed: 0,
      failed: 1,
      skipped: 0,
      skip_reasons: {},
      planned_files: issued.files.length,
      completed_files: 0,
      protocol_error: err.message,
    };
    observed.exit_code ||= 1;
  }
  const endedAt = instant(Date.now());
  await transcript.write(
    `${JSON.stringify({ event: "end", run_id: runId, nonce, ended_at: endedAt, exit_code: observed.exit_code, signal: observed.signal })}\n`
  );
  await transcript.sync();
  await transcript.close();
  return { authorityPath, counts, endedAt, index: run.index, issued, observed, startedAt, transcriptPath };
}

/** Write the completion record and receipt for a run whose transcript is closed. */
async function sealRun(done: CompletedRun, { directory }: RunContext): Promise<Receipt> {
  const { issued, observed, counts, startedAt, endedAt, authorityPath, transcriptPath } = done;
  const transcriptRelative = relative(directory, transcriptPath);
  const completion = {
    schema: RUN_COMPLETION_SCHEMA,
    run_id: issued.run_id,
    nonce: issued.nonce,
    observed: {
      exit_code: observed.exit_code,
      signal: observed.signal,
      transcript: transcriptRelative,
      transcript_sha256: contentDigest(await readFile(transcriptPath)),
      counts,
      files: issued.files,
    },
  };
  const completionPath = resolve(directory, `${issued.run_id}.completion.json`);
  await writeNew(completionPath, completion);
  const receipt: Receipt = {
    schema: "pdpp.test-receipt/v3",
    run_id: issued.run_id,
    nonce: issued.nonce,
    suite: issued.suite,
    profile: issued.profile,
    issued_at: issued.issued_at,
    started_at: startedAt,
    ended_at: endedAt,
    expires_at: issued.expires_at,
    base_sha: issued.base_sha,
    head_sha: issued.head_sha,
    source_tree_sha256: issued.source_tree_sha256,
    selection_tree_sha256: issued.selection_tree_sha256,
    manifest_sha256: issued.manifest_sha256,
    cwd: issued.cwd,
    argv: issued.argv,
    files: issued.files,
    transcript: transcriptRelative,
    transcript_sha256: completion.observed.transcript_sha256,
    exit_code: observed.exit_code,
    signal: observed.signal,
    counts,
    authority_sha256: contentDigest(await readFile(authorityPath)),
    completion_sha256: contentDigest(await readFile(completionPath)),
    binding_sha256: "",
  };
  receipt.binding_sha256 = receiptBinding(receipt);
  await writeNew(resolve(directory, `${issued.run_id}.receipt.json`), receipt);
  return receipt;
}

export async function runAuthority({
  root = gitRoot(),
  suites = [],
  profile,
  base,
  env = process.env,
}: {
  root?: string;
  suites?: string[];
  profile?: string | undefined;
  base?: string | undefined;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const manifest = await readManifest(resolve(root, "test-accounting.manifest.json"), { root, intendedBase: base });
  const files = trackedFiles(root);
  // Fail closed BEFORE selection — this is the fix for the gap the R1
  // remeasure found: the closure oracle existed but nothing on the real
  // `--run` path ever called it, so a silent discovery shrink shipped
  // straight into a live test run with zero error anywhere in CI.
  //
  // Two checks, deliberately different scopes:
  //
  // 1. `validateIncludeGlobsClassifyExecutable`, scoped to the suites this
  //    run actually selects (mirrors `verifyReceipts`'s scoping, see
  //    `965708787`): a suite's include glob that still matches at least
  //    one tracked file (so `planFor`'s own "selects no executable tests"
  //    guard stays silent) can still match a file that no longer
  //    classifies as executable, or a suite's entire include list can go
  //    empty. Scoping this to `suites` means an unrelated suite's stale,
  //    deliberately-empty include glob elsewhere in the manifest cannot
  //    fail a run that never touches it.
  //
  // 2. `unaccountedExecutableTests`, necessarily whole-manifest (ownership
  //    is a global property — a file renamed off the one glob that used to
  //    match it, e.g. mcp-server's `.test.ts` -> `.test.js`, simply stops
  //    being matched by anything; no suite-scoped check can see a file
  //    that fell out of its own suite's purview entirely). This is the
  //    check that closes the N -> N-1 multi-glob partial-rename hole:
  //    `validateIncludeGlobsClassifyExecutable` alone does not catch it
  //    (the file is still executable-classified, just unmatched), and
  //    `planFor`'s per-suite empty-plan guard does not catch it either
  //    (the suite's other globs keep its plan non-empty). It never throws
  //    on an unrelated suite's empty plan, only on a genuinely orphaned
  //    executable file, so it is safe to run unconditionally regardless of
  //    which suites were selected.
  validateIncludeGlobsClassifyExecutable(manifest, files, suites);
  const unaccounted = unaccountedExecutableTests(manifest, files);
  if (unaccounted.length) {
    fail(`unaccounted executable tests: ${unaccounted.join(", ")}`);
  }
  const selection = selectedRuns(manifest, files, { suites, profile });
  if (profile) {
    for (const run of selection.runs) {
      const entry = typeof run.profile === "string" ? { id: run.profile } : run.profile;
      const match = OPTIONAL_PREDICATE_PATTERN.exec(entry.optional_predicate ?? "");
      if (entry.required === false && (!match || env[match[1] ?? ""] !== match[2])) {
        fail(`${run.suite.id}/${entry.id} requires its optional environment predicate`);
      }
    }
  }
  // Reject a disabled optional profile before inspecting mutable source state.
  // No child command has been spawned at this point.
  assertCleanSourceTree(root);
  const head = gitHead(root);
  const runs: Run[] = selection.runs
    .filter((run) => profile || requiredByDefault(run.profile))
    .map((run, index) => ({
      suite: run.suite,
      profile: typeof run.profile === "string" ? { id: run.profile } : run.profile,
      files: run.files,
      index,
    }));
  if (runs.length === 0) {
    fail("no required suite/profile runs were selected");
  }
  const directory = authorityDirectory(root);
  await mkdir(directory, { recursive: true });
  const sourceTree = sourceTreeDigest(root, head);
  const manifestHash = contentDigest(await readFile(resolve(root, "test-accounting.manifest.json")));
  const receipts: Receipt[] = [];
  const concurrency = suiteConcurrency(env);
  reportProgress(`${runs.length} suite/profile runs selected (suite concurrency ${concurrency})`);
  const context: RunContext = {
    root,
    env,
    directory,
    manifestSha256: manifestHash,
    baseSha: manifest.inventory_base_sha,
    head,
    sourceTree,
    total: runs.length,
  };
  // Serial blame, kept under overlap. Serial order checks the checkout after
  // every run, so a run's leftovers are rejected before the next run's setup can
  // remove them. Here a run that ends dirty while siblings still run may have
  // left the files itself or merely caught a sibling's transient ones, and the
  // two cannot be told apart yet. So it stops every lane from starting another
  // run until the last sibling ends and the checkout is judged at rest: still
  // dirty then fails the gate before any further run can hide the files. Sealing
  // (completion + receipt) also waits for that moment. With concurrency 1 every
  // run ends at rest, which is exactly the old check-after-each-run behavior.
  const unsealed: CompletedRun[] = [];
  const sealed = new Map<number, Receipt>();
  let inFlight = 0;
  let suspect = false;
  let stopped = false;
  let atRest: Promise<void> | undefined;
  let endRest = () => {
    suspect = false;
  };
  const waitForRest = () => {
    atRest ??= new Promise<void>((resolveRest) => {
      endRest = () => {
        suspect = false;
        atRest = undefined;
        resolveRest();
      };
    });
    return atRest;
  };
  const settle = async () => {
    assertCleanSourceTree(root);
    if (sourceTreeDigest(root, head) !== sourceTree) {
      fail(
        `${unsealed.map(({ issued }) => `${issued.suite}/${issued.profile}`).join(", ")} changed the full source tree during execution`
      );
    }
    const batch = unsealed.splice(0);
    await Promise.all(
      batch.map(async (done) => {
        sealed.set(done.index, await sealRun(done, context));
      })
    );
  };
  const finishRun = async (indexed: Run) => {
    inFlight += 1;
    let done: CompletedRun | undefined;
    let failure: { error: unknown } | undefined;
    try {
      done = await executeRun(indexed, context);
    } catch (error) {
      failure = { error };
      stopped = true;
    }
    inFlight -= 1;
    if (done) {
      unsealed.push(done);
      // The first failed outcome stops new starts at once; siblings finish.
      stopped ||= runFailed(done);
    }
    if (inFlight > 0) {
      if (failure) {
        throw failure.error;
      }
      suspect ||= sourceTreeDirty(root);
      if (suspect) {
        await waitForRest();
      }
      return;
    }
    // The last run to leave, finished or thrown, judges the checkout at rest and
    // seals every completed run, so a throw never strands its completed siblings.
    try {
      await settle();
    } catch (error) {
      stopped = true;
      failure ??= { error };
    } finally {
      endRest();
    }
    if (failure) {
      throw failure.error;
    }
  };
  let poolFailure: { error: unknown } | undefined;
  try {
    // Phases are ordered: the exclusive phase starts only after the shared phase has drained.
    await schedulePhases(runs, concurrency).reduce(
      (previous, [phaseRuns, limit]) => previous.then(() => runPool(phaseRuns, limit, finishRun, () => stopped)),
      Promise.resolve()
    );
  } catch (error) {
    poolFailure = { error };
  }
  receipts.push(...[...sealed.entries()].sort(([a], [b]) => a - b).map(([, receipt]) => receipt));
  if (poolFailure) {
    // Verify what was sealed once, then surface the original error. Only sealed
    // runs are required: a run that never started or threw has no receipt.
    await verifyReceipts(manifest, files, receipts, {
      root,
      head,
      authorityDirectory: directory,
      sourceTree,
      requiredKeys: receipts.map((receipt) => `${receipt.suite}/${receipt.profile}`),
    }).catch(() => undefined);
    throw poolFailure.error;
  }
  return {
    directory,
    result: await verifyReceipts(manifest, files, receipts, {
      root,
      head,
      authorityDirectory: directory,
      sourceTree,
      requiredKeys: runs.map((run) => `${run.suite.id}/${run.profile.id}`),
    }),
  };
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  const result = await runAuthority({ suites: input.suites, profile: input.profile, base: input.base });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
