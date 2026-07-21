#!/usr/bin/env node

/**
 * Benchmark for the claude_code two-pass (parent-first) change.
 *
 * Question: is the 2x jsonl I/O acceptable for real operator use?
 *
 * Baseline-correctness note (owner feedback 2026-04-23): the first
 * version of this bench used `scanProjectDirs({ buildOnly: false })`
 * as the "single-pass baseline." That was NOT a faithful pre-Tranche-C
 * reconstruction — current code only updates session accumulators when
 * buildOnly is TRUE, so the baseline run emitted 0 sessions. This
 * version fixes that by importing the actual pre-Tranche-C
 * `scanProjectDirs` from git (commit `0cf0f51^`) as
 * `bench/legacy/claude-code-pre-tranche-c.ts`. Its parseJsonlFile
 * always calls updateSessionAccumulator and processJsonlLine always
 * emits — exactly the pre-change contract. The session count in the
 * baseline run now matches the two-pass run.
 *
 * Method:
 *   - Point `baseDir` at `$CLAUDE_CODE_PROJECTS_DIR` if set, else
 *     `~/.claude/projects` — real operator-scale corpus.
 *   - Mode A (baseline): import legacy `scanProjectDirs` from
 *     `bench/legacy/`. One scan that updates accumulators AND emits
 *     messages/attachments inline, then emitSessionsFromAccumulators.
 *     This is the code that ran in production before 0cf0f51.
 *   - Mode B (current): two-pass — `scanProjectDirs` from current
 *     index.ts with buildOnly=true, then emitSessionsFromAccumulators,
 *     then scanProjectDirs with buildOnly=false.
 *   - Run each mode 3 times. Report median wall-clock + emitted-record
 *     totals. Also record per-pass breakdown for B.
 *
 * Caveats (honest limitations):
 *   - OS filesystem cache gets warmer between runs. A warmup pass runs
 *     before measurement, so both modes see a hot cache. Mode order
 *     is alternated run-by-run (A,B,A,B,A,B) to minimize systematic
 *     cache asymmetry between modes.
 *   - emitRecord is a no-op counter; we're measuring scan+parse cost,
 *     not downstream ingest.
 */

import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { emitSessionsFromAccumulators, scanProjectDirs } from "../connectors/claude_code/index.ts";
import type { SessionAccumulator } from "../connectors/claude_code/types.ts";
import type { EmittedMessage, RecordData, StreamScope } from "../src/connector-runtime.ts";
import {
  type ScanProjectDirsArgs as LegacyScanProjectDirsArgs,
  emitSessionsFromAccumulators as legacyEmitSessionsFromAccumulators,
  scanProjectDirs as legacyScanProjectDirs,
} from "./legacy/claude-code-pre-tranche-c.ts";

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

async function runLegacyBaseline(): Promise<RunResult> {
  // This calls the verbatim pre-Tranche-C scanProjectDirs (from commit
  // 0cf0f51^, saved at bench/legacy/claude-code-pre-tranche-c.ts). That
  // implementation's parseJsonlFile always calls updateSessionAccumulator
  // and its processJsonlLine always emits — one scan, inline everything.
  const counters = { records: 0, sessions: 0, messages: 0, attachments: 0 };
  const sessionAccumulators = new Map<string, SessionAccumulator>();
  const fileMtimes: Record<string, number> = {};
  const newMtimes: Record<string, number> = {};
  const requested = makeRequested();
  const emitRecord = makeCountingEmit(counters);
  const args: LegacyScanProjectDirsArgs = {
    baseDir,
    emit: silentEmit(),
    emitRecord,
    fileMtimes,
    newMtimes,
    requested,
    sessionAccumulators,
  };

  const t0 = performance.now();
  await legacyScanProjectDirs(args);
  await legacyEmitSessionsFromAccumulators({ emitRecord, requested, sessionAccumulators });
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
  process.stderr.write(`[bench] corpus: ${baseDir}\n`);
  process.stderr.write("[bench] warmup pass (results ignored) — legacy baseline...\n");
  await runLegacyBaseline();
  process.stderr.write("[bench] warmup pass (results ignored) — current two-pass...\n");
  await runTwoPass();

  // Interleave runs (A,B,A,B,A,B) rather than (A,A,A,B,B,B) to minimize
  // systematic cache drift between modes. Median across iterations
  // already tames single-outlier effects; interleaving tames mode-order
  // asymmetry too.
  process.stderr.write(`[bench] Interleaved ${ITERATIONS} iterations of (legacy baseline, two-pass)\n`);
  const singleRuns: RunResult[] = [];
  const twoPassRuns: RunResult[] = [];
  const pass1Times: number[] = [];
  const emitSessionsTimes: number[] = [];
  const pass2Times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const r = await runLegacyBaseline();
    process.stderr.write(
      `  iter ${i + 1} legacy baseline: ${r.elapsedMs.toFixed(0)}ms (records=${r.records}, sessions=${r.sessions}, messages=${r.messages}, attachments=${r.attachments})\n`
    );
    singleRuns.push(r);

    const { result, pass1Ms, emitSessionsMs, pass2Ms } = await runTwoPass();
    process.stderr.write(
      `  iter ${i + 1} two-pass:         ${result.elapsedMs.toFixed(0)}ms (pass1=${pass1Ms.toFixed(0)}ms emitSessions=${emitSessionsMs.toFixed(0)}ms pass2=${pass2Ms.toFixed(0)}ms, records=${result.records}, sessions=${result.sessions}, messages=${result.messages}, attachments=${result.attachments})\n`
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
  process.stdout.write(`legacy baseline median (pre-Tranche-C, commit 0cf0f51^): ${single.medianMs.toFixed(0)}ms\n`);
  process.stdout.write(`current two-pass median:                                 ${twoPass.medianMs.toFixed(0)}ms\n`);
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
