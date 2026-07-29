// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Deterministic completion oracle for the reference-implementation test
// suite (reference-implementation/scripts/run-tests.ts).
//
// This module answers one mechanical question: did the suite actually
// finish, and what precisely happened? It is independent of the runner it
// observes -- it never imports reference-implementation/scripts/run-tests.ts
// or scripts/test-accounting/**, it only spawns the runner as an external
// process, reads its stdout/stderr byte stream, and applies its own bounded
// wait. That independence is the point: an oracle that shares code with the
// thing it is grading can be fooled by the same bug in both places.
//
// Verdict states (see CompletionVerdict.status):
//   - "completed-all-green"    process exited 0, every discovered test file
//                               produced a completion marker, zero failures.
//   - "completed-with-failures" process exited on its own (any code/signal
//                               path the child chose), but at least one test
//                               failed, or a discovered file never produced
//                               a completion marker (silently dropped).
//   - "did-not-complete"       the oracle's own outer deadline fired and it
//                               had to SIGKILL the child itself, OR the
//                               child was killed by an external signal
//                               (SIGKILL/SIGTERM) before finishing. A run the
//                               oracle had to intervene on is NEVER reported
//                               as complete, regardless of how much passed
//                               before the kill.
//
// A run that finishes because an external `timeout(1)` wrapper (or CI's own
// job timeout) killed it looks identical, from this process's point of view,
// to the oracle's own watchdog firing: the child dies by signal without
// reaching its own exit. Both are classified "did-not-complete" -- there is
// no code path that turns a killed process into a green result.

import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const NODE_TEST_EXTENSIONS = [".test.js", ".test.mjs", ".test.ts"] as const;

// Mirrors reference-implementation/scripts/run-tests.ts's own discovery
// exactly (top-level test/*.test.* plus two co-located directories) so the
// oracle can independently answer "was every file the runner was SUPPOSED to
// run actually observed running" without importing that script. Re-derived,
// not shared, on purpose -- see the header comment.
const COLOCATED_TEST_DIRS = [{ dir: join("server", "streaming") }, { dir: "scripts" }] as const;

export interface DiscoveredFile {
  /** Path relative to reference-implementation/, e.g. "test/foo.test.js". */
  relPath: string;
}

export async function discoverExpectedTestFiles(riRoot: string): Promise<DiscoveredFile[]> {
  const isNodeTest = (name: string) => NODE_TEST_EXTENSIONS.some((ext) => name.endsWith(ext));
  const testDir = join(riRoot, "test");
  const topLevel: Dirent<string>[] = await readdir(testDir, { withFileTypes: true });
  const files: DiscoveredFile[] = topLevel
    .filter((entry) => entry.isFile() && isNodeTest(entry.name))
    .map((entry) => ({ relPath: join("test", entry.name) }));

  for (const { dir: relDir } of COLOCATED_TEST_DIRS) {
    const absDir = join(riRoot, relDir);
    let entries: Dirent<string>[];
    try {
      // biome-ignore lint/performance/noAwaitInLoops: fixed, tiny (2-entry) list of co-located test dirs; sequential reads keep a missing directory's fallback (continue) attributable to that one directory.
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && isNodeTest(entry.name)) {
        files.push({ relPath: join(relDir, entry.name) });
      }
    }
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

export interface FileOutcome {
  /** Structured pass/fail/skip counts observed for this file, if any events were seen. */
  assertions: number;
  failed: number;
  passed: number;
  relPath: string;
  skipped: number;
  skipReasons: Record<string, number>;
}

export interface ParsedRunOutput {
  /** Files that produced a "==> <path>" completion marker, in first-seen order. */
  completedFiles: string[];
  /** True if any PDPP_TEST_ACCOUNTING_EVENT line failed to parse as JSON. */
  malformedEventLines: number;
  /** Per-file structured outcome, keyed by relPath, for files whose reporter events were parseable. */
  outcomes: Map<string, FileOutcome>;
}

const FILE_MARKER_PATTERN = /^==> (.+)$/;
const EVENT_PREFIX = "PDPP_TEST_ACCOUNTING_EVENT ";

interface AccountingEventDetails {
  name?: string;
  skip?: boolean | string;
  type?: string;
}
interface AccountingEvent {
  details?: AccountingEventDetails;
  type: string;
}

const SKIP_REASON_SUFFIX_PATTERN = /\(skipped:\s*([^)]+)\)|:\s*skipped\s*\(([^)]+)\)/i;

/**
 * Parse the combined stdout+stderr of a run-tests.js invocation into a
 * per-file ledger. This is a genuinely independent re-derivation of the
 * skip/pass/fail classification scripts/test-accounting/receipt.ts performs
 * (same two data sources: the "==> path" per-file markers run-tests.js
 * writes itself, and the PDPP_TEST_ACCOUNTING_EVENT stream the reporter
 * emits) -- kept separate so a bug shared between the runner's own
 * accounting and this oracle cannot cancel out. Unlike receipt.ts, this
 * function never throws on an unexplained skip reason: an oracle's job is to
 * report what happened, not to enforce a policy about it. A skip whose
 * reason cannot be determined is recorded under the literal string
 * "(unexplained)" rather than crashing the parse.
 */
function newOutcome(relPath: string): FileOutcome {
  return { relPath, assertions: 0, passed: 0, failed: 0, skipped: 0, skipReasons: {} };
}

/** Resolve a skip's display reason: an explicit string, a name-suffix-encoded reason, or "(unexplained)". */
function resolveSkipReason(skip: boolean | string, name: string | undefined): string {
  if (typeof skip === "string") {
    return skip.trim();
  }
  return name?.match(SKIP_REASON_SUFFIX_PATTERN)?.slice(1).find(Boolean)?.trim() ?? "(unexplained)";
}

/** Fold one test:pass/test:fail accounting event into its file's outcome tally. */
function applyTestEvent(outcome: FileOutcome, event: AccountingEvent): void {
  outcome.assertions += 1;
  const { skip } = event.details ?? {};
  if (skip !== false && skip !== undefined && skip !== null) {
    const reason = resolveSkipReason(skip, event.details?.name);
    outcome.skipped += 1;
    outcome.skipReasons[reason] = (outcome.skipReasons[reason] ?? 0) + 1;
    return;
  }
  if (event.type === "test:pass") {
    outcome.passed += 1;
  } else {
    outcome.failed += 1;
  }
}

export function parseRunOutput(output: string): ParsedRunOutput {
  const completedFiles: string[] = [];
  const outcomes = new Map<string, FileOutcome>();
  let malformedEventLines = 0;
  let currentFile: string | undefined;

  const ensureOutcome = (relPath: string): FileOutcome => {
    let outcome = outcomes.get(relPath);
    if (!outcome) {
      outcome = newOutcome(relPath);
      outcomes.set(relPath, outcome);
    }
    return outcome;
  };

  for (const line of output.split("\n")) {
    const markerMatch = line.match(FILE_MARKER_PATTERN);
    if (markerMatch?.[1]) {
      currentFile = markerMatch[1].trim();
      completedFiles.push(currentFile);
      ensureOutcome(currentFile);
      continue;
    }
    if (!line.startsWith(EVENT_PREFIX)) {
      continue;
    }
    let event: AccountingEvent;
    try {
      event = JSON.parse(line.slice(EVENT_PREFIX.length));
    } catch {
      malformedEventLines += 1;
      continue;
    }
    const isCountableTestEvent =
      currentFile !== undefined &&
      (event.type === "test:pass" || event.type === "test:fail") &&
      event.details?.type === "test";
    if (isCountableTestEvent && currentFile !== undefined) {
      applyTestEvent(ensureOutcome(currentFile), event);
    }
  }

  return { completedFiles, outcomes, malformedEventLines };
}

export type CompletionStatus = "completed-all-green" | "completed-with-failures" | "did-not-complete";

// Node's default uncaught-exception crash prints a stack trace ending in a
// bare "Node.js vX.Y.Z" line on stderr, then exits (no signal -- this is a
// normal process exit from the runtime's point of view, distinct from a
// test failure the runner itself observed and accounted for). run-tests.js
// computes its final summary via `results.map(structuredNodeSummary)` AFTER
// every child test file has already finished and reported its own
// individually-correct output; a throw partway through that final map (e.g.
// one file's skip reason the accounting layer cannot explain) still lets
// the process exit non-zero on its own, so it is NOT "did-not-complete" by
// this oracle's signal-based rule. But conflating it with an ordinary test
// failure would hide a materially different defect: every file DID run
// (verified independently via the completedFiles/missingFiles comparison,
// which never depends on the runner's own crashed summary step), yet the
// runner's own accounting output for that run cannot be trusted as
// complete regardless of any exit code
// or `==>` marker.
const NODE_UNCAUGHT_EXCEPTION_PATTERN = /\nNode\.js v\d+\.\d+\.\d+\s*$/;

export interface CompletionVerdict {
  /** Files the runner actually produced a completion marker for. */
  completedFiles: string[];
  /** Wall-clock duration of the spawned process, in milliseconds. */
  durationMs: number;
  /** Exit code the child reported, or null if it never exited on its own. */
  exitCode: number | null;
  malformedEventLines: number;
  /** Files discovery expected but that never got a completion marker. */
  missingFiles: string[];
  /** True only when the ORACLE's own deadline fired and it had to SIGKILL the child. */
  oracleTimedOut: boolean;
  /** First N KB of combined output, for a human to inspect on failure. */
  outputExcerpt: string;
  perFile: FileOutcome[];
  /**
   * True when the child process itself crashed via an uncaught exception
   * (Node's own "Node.js vX.Y.Z" crash signature) rather than exiting
   * through its own normal control flow. When true, `status` is always
   * "completed-with-failures" even if every per-file marker and zero test
   * failures were observed -- an uncaught exception in the runner's own
   * summary step means its aggregate totals were never actually computed
   * and printed by run-tests.js itself; this oracle's totals come from its
   * OWN independent re-parse of the per-file event stream, not from
   * trusting the crashed runner's arithmetic.
   */
  runnerCrashed: boolean;
  /** Signal that terminated the child, or null if it exited normally. */
  signal: NodeJS.Signals | null;
  status: CompletionStatus;
  totals: {
    assertions: number;
    passed: number;
    failed: number;
    skipped: number;
    skipReasons: Record<string, number>;
  };
  /** Files that produced a marker but were not in the expected discovery set. */
  unexpectedFiles: string[];
}

export interface RunSuiteOptions {
  /** Command to run, defaults to `node --import tsx scripts/run-tests.ts`. */
  command?: string[];
  /** Extra env vars merged over process.env for the child. */
  env?: NodeJS.ProcessEnv;
  /** Extra args forwarded to the command (e.g. a single test file to scope the run). */
  extraArgs?: string[];
  /** Absolute path to reference-implementation/. */
  riRoot: string;
  /** Oracle-level outer deadline. Independent of run-tests.js's own PER_FILE_TIMEOUT_MS. */
  timeoutMs?: number;
}

const DEFAULT_COMMAND = ["node", "--import", "tsx", "scripts/run-tests.ts"];
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const OUTPUT_EXCERPT_BYTES = 8000;

/**
 * Run the RI suite (or a scoped subset) to completion or to the oracle's own
 * deadline, and classify the outcome. Never resolves with a "completed-*"
 * status if the oracle had to kill the child itself, and never lets a hung
 * process run forever -- SIGKILL is asymmetric on purpose (mirrors
 * run-tests.js's own per-file watchdog rationale: a hang means the event
 * loop is not responding to its own timers, so a graceful signal is not a
 * reliable way to end it).
 */
export async function runSuiteToCompletion(options: RunSuiteOptions): Promise<CompletionVerdict> {
  const command = options.command ?? DEFAULT_COMMAND;
  const [exe, ...baseArgs] = command;
  if (!exe) {
    throw new Error("runSuiteToCompletion requires a non-empty command");
  }
  const args = [...baseArgs, ...(options.extraArgs ?? [])];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const expected = await discoverExpectedTestFiles(options.riRoot);
  const expectedSet = new Set(expected.map((f) => f.relPath));

  const startedAt = Date.now();
  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    oracleTimedOut: boolean;
    output: string;
  }>((resolve) => {
    const child = spawn(exe, args, {
      cwd: options.riRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let oracleTimedOut = false;

    const deadline = setTimeout(() => {
      oracleTimedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(deadline);
      output += `\n[oracle] child process error: ${err.message}\n`;
      resolve({ exitCode: null, signal: null, oracleTimedOut, output });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(deadline);
      resolve({ exitCode: code, signal, oracleTimedOut, output });
    });
  });
  const durationMs = Date.now() - startedAt;

  const parsed = parseRunOutput(result.output);
  const completedSet = new Set(parsed.completedFiles);
  const missingFiles = expected.filter((f) => !completedSet.has(f.relPath)).map((f) => f.relPath);
  const unexpectedFiles = parsed.completedFiles.filter((f) => !expectedSet.has(f));

  const totals = { assertions: 0, passed: 0, failed: 0, skipped: 0, skipReasons: {} as Record<string, number> };
  for (const outcome of parsed.outcomes.values()) {
    totals.assertions += outcome.assertions;
    totals.passed += outcome.passed;
    totals.failed += outcome.failed;
    totals.skipped += outcome.skipped;
    for (const [reason, count] of Object.entries(outcome.skipReasons)) {
      totals.skipReasons[reason] = (totals.skipReasons[reason] ?? 0) + count;
    }
  }

  const runnerCrashed = NODE_UNCAUGHT_EXCEPTION_PATTERN.test(result.output);

  // A run the oracle had to kill, or that died by an external signal before
  // reaching its own exit, is NEVER completion -- regardless of exit code,
  // regardless of how many files already reported green. This is the
  // load-bearing rule: it is what stops a `timeout`-wrapped hang, or the
  // oracle's own watchdog firing, from ever being reported as success. A
  // runner self-crash (see NODE_UNCAUGHT_EXCEPTION_PATTERN above) is
  // likewise never "all-green" even when every file's own marker and this
  // oracle's own independent per-file tally show zero failures -- the
  // runner's own aggregate arithmetic for that run never actually ran to
  // completion, so nothing about it can be trusted as green.
  let status: CompletionStatus;
  if (result.oracleTimedOut || result.signal !== null) {
    status = "did-not-complete";
  } else if (
    !runnerCrashed &&
    result.exitCode === 0 &&
    missingFiles.length === 0 &&
    unexpectedFiles.length === 0 &&
    totals.failed === 0 &&
    parsed.malformedEventLines === 0
  ) {
    status = "completed-all-green";
  } else {
    status = "completed-with-failures";
  }

  return {
    status,
    durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    oracleTimedOut: result.oracleTimedOut,
    runnerCrashed,
    completedFiles: parsed.completedFiles,
    missingFiles,
    unexpectedFiles,
    perFile: [...parsed.outcomes.values()].sort((a, b) => a.relPath.localeCompare(b.relPath)),
    totals,
    malformedEventLines: parsed.malformedEventLines,
    outputExcerpt:
      result.output.length > OUTPUT_EXCERPT_BYTES ? `${result.output.slice(-OUTPUT_EXCERPT_BYTES)}` : result.output,
  };
}
