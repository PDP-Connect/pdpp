#!/usr/bin/env node

/**
 * Benchmark for the claude_code two-pass (parent-first) change.
 *
 * Question: is the 2x jsonl I/O acceptable for real operator use?
 *
 * Method:
 *   - Point `baseDir` at `$CLAUDE_CODE_PROJECTS_DIR` if set, else
 *     `~/.claude/projects` — real operator-scale corpus.
 *   - Measure mode A: single-pass (buildOnly=false, no parent-first).
 *     This matches pre-Tranche-C behavior — one scan, emits everything
 *     inline. It's the strongest honest baseline; reconstructing the
 *     exact pre-decomposition code would require a checkout swap and
 *     isn't worth the complexity.
 *   - Measure mode B: two-pass (buildOnly=true + emitSessions +
 *     buildOnly=false). This is the current production behavior.
 *   - Run each mode 3 times. Report median wall-clock + emitted-record
 *     totals. Also record per-pass breakdown for B.
 *
 * Caveats:
 *   - OS filesystem cache gets warmer between runs. First run of mode A
 *     is cold; runs 2+ are warm. Mode B runs second, so mostly warm.
 *     Median tames single-outlier effects but does NOT factor out
 *     cache asymmetry. A warmup run is done before the measured runs.
 *   - Mode A is a re-implementation, not a git-checkout-based baseline.
 *     It's behaviorally equivalent to "call scanProjectDirs once with
 *     buildOnly=false then emitSessionsFromAccumulators" — which is
 *     what pre-Tranche-C did, minus the parent-first ordering.
 *   - emitRecord is a no-op counter; we're measuring scan+parse cost,
 *     not the downstream ingest.
 */

import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  emitSessionsFromAccumulators,
  type ScanProjectDirsArgs,
  scanProjectDirs,
} from "../connectors/claude_code/index.ts";
import type { SessionAccumulator } from "../connectors/claude_code/types.ts";
import type { EmittedMessage, RecordData, StreamScope } from "../src/connector-runtime.ts";

const baseDir = process.env.CLAUDE_CODE_PROJECTS_DIR || join(process.env.HOME ?? "", ".claude", "projects");
const ITERATIONS = 3;

interface RunResult {
  attachments: number;
  elapsedMs: number;
  messages: number;
  records: number;
  sessions: number;
}

interface ModeResult {
  emitSessionsMedianMs?: number;
  medianMs: number;
  mode: "single-pass" | "two-pass";
  // For two-pass, also the median per-phase split.
  pass1MedianMs?: number;
  pass2MedianMs?: number;
  perRun: RunResult[];
}

const silentEmit = (): ((msg: EmittedMessage) => Promise<void>) => () => Promise.resolve();

function makeCountingEmit(counters: {
  records: number;
  sessions: number;
  messages: number;
  attachments: number;
}): (stream: string, data: RecordData) => Promise<void> {
  return (stream: string, _data: RecordData): Promise<void> => {
    counters.records++;
    if (stream === "sessions") {
      counters.sessions++;
    } else if (stream === "messages") {
      counters.messages++;
    } else if (stream === "attachments") {
      counters.attachments++;
    }
    return Promise.resolve();
  };
}

function makeRequested(): Map<string, StreamScope> {
  return new Map([
    ["sessions", { name: "sessions" }],
    ["messages", { name: "messages" }],
    ["attachments", { name: "attachments" }],
  ]);
}

async function runSinglePass(): Promise<RunResult> {
  const counters = { records: 0, sessions: 0, messages: 0, attachments: 0 };
  const sessionAccumulators = new Map<string, SessionAccumulator>();
  const fileMtimes: Record<string, number> = {};
  const newMtimes: Record<string, number> = {};
  const requested = makeRequested();
  const emitRecord = makeCountingEmit(counters);
  const args: ScanProjectDirsArgs = {
    baseDir,
    buildOnly: false,
    emit: silentEmit(),
    emitRecord,
    fileMtimes,
    newMtimes,
    requested,
    sessionAccumulators,
  };

  const t0 = performance.now();
  await scanProjectDirs(args);
  await emitSessionsFromAccumulators({ emitRecord, requested, sessionAccumulators });
  const elapsedMs = performance.now() - t0;

  return { elapsedMs, ...counters };
}

async function runTwoPass(): Promise<{
  result: RunResult;
  pass1Ms: number;
  emitSessionsMs: number;
  pass2Ms: number;
}> {
  const counters = { records: 0, sessions: 0, messages: 0, attachments: 0 };
  const sessionAccumulators = new Map<string, SessionAccumulator>();
  const fileMtimes: Record<string, number> = {};
  const newMtimes: Record<string, number> = {};
  const requested = makeRequested();
  const emitRecord = makeCountingEmit(counters);

  const overall0 = performance.now();

  const p1t0 = performance.now();
  await scanProjectDirs({
    baseDir,
    buildOnly: true,
    emit: silentEmit(),
    emitRecord,
    fileMtimes,
    newMtimes,
    requested,
    sessionAccumulators,
  });
  const pass1Ms = performance.now() - p1t0;

  const es0 = performance.now();
  await emitSessionsFromAccumulators({ emitRecord, requested, sessionAccumulators });
  const emitSessionsMs = performance.now() - es0;

  const p2t0 = performance.now();
  await scanProjectDirs({
    baseDir,
    buildOnly: false,
    emit: silentEmit(),
    emitRecord,
    fileMtimes,
    newMtimes,
    requested,
    sessionAccumulators,
  });
  const pass2Ms = performance.now() - p2t0;

  const elapsedMs = performance.now() - overall0;
  return {
    result: { elapsedMs, ...counters },
    pass1Ms,
    emitSessionsMs,
    pass2Ms,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

async function main(): Promise<void> {
  // Warmup run to level the filesystem cache between modes.
  process.stderr.write(`[bench] corpus: ${baseDir}\n`);
  process.stderr.write("[bench] warmup pass (results ignored)...\n");
  await runSinglePass();

  process.stderr.write(`[bench] MODE A — single-pass (baseline), ${ITERATIONS} runs\n`);
  const singleRuns: RunResult[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const r = await runSinglePass();
    process.stderr.write(
      `  run ${i + 1}: ${r.elapsedMs.toFixed(0)}ms (records=${r.records}, sessions=${r.sessions}, messages=${r.messages}, attachments=${r.attachments})\n`
    );
    singleRuns.push(r);
  }

  process.stderr.write(`[bench] MODE B — two-pass (current), ${ITERATIONS} runs\n`);
  const twoPassRuns: RunResult[] = [];
  const pass1Times: number[] = [];
  const emitSessionsTimes: number[] = [];
  const pass2Times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const { result, pass1Ms, emitSessionsMs, pass2Ms } = await runTwoPass();
    process.stderr.write(
      `  run ${i + 1}: ${result.elapsedMs.toFixed(0)}ms (pass1=${pass1Ms.toFixed(0)}ms emitSessions=${emitSessionsMs.toFixed(0)}ms pass2=${pass2Ms.toFixed(0)}ms)\n`
    );
    twoPassRuns.push(result);
    pass1Times.push(pass1Ms);
    emitSessionsTimes.push(emitSessionsMs);
    pass2Times.push(pass2Ms);
  }

  const single: ModeResult = {
    mode: "single-pass",
    perRun: singleRuns,
    medianMs: median(singleRuns.map((r) => r.elapsedMs)),
  };
  const twoPass: ModeResult = {
    mode: "two-pass",
    perRun: twoPassRuns,
    medianMs: median(twoPassRuns.map((r) => r.elapsedMs)),
    pass1MedianMs: median(pass1Times),
    emitSessionsMedianMs: median(emitSessionsTimes),
    pass2MedianMs: median(pass2Times),
  };

  const regression = ((twoPass.medianMs - single.medianMs) / single.medianMs) * 100;

  process.stdout.write("\n=== claude_code two-pass bench ===\n");
  process.stdout.write(`Corpus: ${baseDir}\n`);
  const firstTwoPass = twoPassRuns[0];
  if (firstTwoPass) {
    process.stdout.write(
      `Records per run: ~${firstTwoPass.records.toLocaleString()} (sessions=${firstTwoPass.sessions}, messages=${firstTwoPass.messages}, attachments=${firstTwoPass.attachments})\n\n`
    );
  }
  process.stdout.write(`single-pass median: ${single.medianMs.toFixed(0)}ms (baseline)\n`);
  process.stdout.write(`two-pass median:    ${twoPass.medianMs.toFixed(0)}ms\n`);
  process.stdout.write(`  pass 1 (build):   ${twoPass.pass1MedianMs?.toFixed(0)}ms\n`);
  process.stdout.write(`  emit sessions:    ${twoPass.emitSessionsMedianMs?.toFixed(0)}ms\n`);
  process.stdout.write(`  pass 2 (emit):    ${twoPass.pass2MedianMs?.toFixed(0)}ms\n`);
  process.stdout.write(`\nRegression: ${regression >= 0 ? "+" : ""}${regression.toFixed(1)}%\n`);
  if (regression > 25) {
    process.stdout.write("Verdict: REGRESSION > 25% — stop-and-report per closure instruction.\n");
    process.exit(2);
  } else if (regression > 10) {
    process.stdout.write("Verdict: acceptable with caveat (10-25% regression).\n");
  } else {
    process.stdout.write("Verdict: acceptable (regression < 10%).\n");
  }
}

main().catch((err: unknown): never => {
  process.stderr.write(`bench failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
