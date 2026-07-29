#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operational receipt harness for the child-backed local Transformer profile.
 *
 * It intentionally does no database or HTTP work. Each concurrency receives a
 * fresh bounded child, an untimed warm-up, then two measured rounds. The receipt
 * records parent and child RSS, child execution high-water, cardinality, and
 * bitwise output equality before selecting the lowest safely useful work limit.
 */

import { writeFile } from "node:fs/promises";

import type { LocalTransformerExecutionTelemetry } from "../server/local-transformer-executor.ts";
import { makeLocalTransformerBackend } from "../server/search-semantic.ts";

const SAMPLE_COUNT = 100;
const CONCURRENCIES = [1, 2, 4, 8];
const MEASURED_ROUNDS = 2;

/**
 * The subset of `makeLocalTransformerBackend`'s return surface this harness
 * calls. `server/search-semantic.js` is untyped JS (checkJs: false), so its
 * export carries no static type; this interface is the honest contract for
 * exactly the methods used here, cross-checked against the source at
 * server/search-semantic.js:makeLocalTransformerBackend and against the real
 * `LocalTransformerExecutionTelemetry` shape exported by
 * server/local-transformer-executor.ts (already TS).
 */
interface LocalTransformerBackend {
  available: () => boolean;
  close: () => Promise<void>;
  embedDocument: (text: string) => Promise<Float32Array>;
  executionTelemetry: () => LocalTransformerExecutionTelemetry;
  identity: () => string;
  resetExecutionTelemetry: () => void;
}

function hasLocalTransformerTelemetry(
  backend: ReturnType<typeof makeLocalTransformerBackend>
): backend is ReturnType<typeof makeLocalTransformerBackend> & LocalTransformerBackend {
  return (
    "executionTelemetry" in backend &&
    typeof backend.executionTelemetry === "function" &&
    "resetExecutionTelemetry" in backend &&
    typeof backend.resetExecutionTelemetry === "function"
  );
}

interface ParsedArgs {
  receiptPath: string | null;
}

interface MappedResult {
  highWater: number;
  results: Array<Float32Array | { error: string }>;
}

interface MeasuredRound {
  actual_child_high_water: number;
  concurrency: number;
  digests: string[];
  elapsed_ms: number;
  errors: string[];
  output_count: number;
  output_dimensions: number;
  output_equal_to_baseline: boolean;
  parent_high_water: number;
  peak_child_rss_bytes: number;
  peak_combined_rss_bytes: number;
  peak_parent_rss_bytes: number;
}

interface ConcurrencyResult {
  baseline: string[];
  rounds: MeasuredRound[];
}

interface ConcurrencyRun {
  concurrency: number;
  rounds: MeasuredRound[];
}

interface SelectedDefault {
  rationale: string;
  work_limit: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const receiptIndex = argv.indexOf("--receipt");
  if (receiptIndex === -1) {
    return { receiptPath: null };
  }
  const receiptPath = argv[receiptIndex + 1];
  if (!receiptPath) {
    throw new Error("--receipt requires a path");
  }
  return { receiptPath };
}

function samples(): string[] {
  return Array.from(
    { length: SAMPLE_COUNT },
    (_, index) => `Synthetic local-transformer benchmark record ${index}: durable collector index repair payload.`
  );
}

function vectorDigest(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
}

/**
 * Process one item slot into `results[index]`: run the embedding worker and
 * store either the vector or a normalized error (never throws -- an
 * out-of-bounds `item` is itself recorded as an error result rather than
 * propagated, matching the original inline try/catch's blast radius). Extracted
 * from the `run()` dispatch loop below purely to keep that loop's own
 * cognitive complexity under Biome's budget; the error-normalization behavior
 * is unchanged from the inline version it replaces.
 */
async function processMeasuredItem(
  index: number,
  item: string | undefined,
  worker: (item: string) => Promise<Float32Array>,
  results: Array<Float32Array | { error: string }>
): Promise<void> {
  try {
    if (item === undefined) {
      throw new Error(`benchmark input index ${index} is out of bounds`);
    }
    results[index] = await worker(item);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    results[index] = { error: typeof code === "string" ? code : "transformer_compute_failed" };
  }
}

async function mapWithMeasuredConcurrency(
  items: string[],
  concurrency: number,
  worker: (item: string) => Promise<Float32Array>,
  sample: () => void
): Promise<MappedResult> {
  const results: Array<Float32Array | { error: string }> = new Array(items.length);
  let active = 0;
  let highWater = 0;
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      active += 1;
      highWater = Math.max(highWater, active);
      sample();
      // biome-ignore lint/performance/noAwaitInLoops: this IS the bounded-concurrency worker -- `concurrency` copies of `run()` are launched via Promise.all below, each processing one item at a time from the shared `next` cursor, so this await caps in-flight work at exactly `concurrency`.
      await processMeasuredItem(index, items[index], worker, results);
      active -= 1;
      sample();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return { highWater, results };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const middleValue = sorted[middle];
  if (middleValue === undefined) {
    throw new Error("median requires at least one value");
  }
  if (sorted.length % 2 === 1) {
    return middleValue;
  }
  const lowerValue = sorted[middle - 1];
  if (lowerValue === undefined) {
    throw new Error("median requires at least one value");
  }
  return (lowerValue + middleValue) / 2;
}

async function runMeasuredRound(
  backend: LocalTransformerBackend,
  inputs: string[],
  concurrency: number,
  baseline: string[] | null
): Promise<MeasuredRound> {
  backend.resetExecutionTelemetry();
  let peakParentRssBytes = process.memoryUsage().rss;
  let peakCombinedRssBytes = peakParentRssBytes;
  const sample = () => {
    const parentRssBytes = process.memoryUsage().rss;
    const childRssBytes = backend.executionTelemetry().childRssBytes || 0;
    peakParentRssBytes = Math.max(peakParentRssBytes, parentRssBytes);
    peakCombinedRssBytes = Math.max(peakCombinedRssBytes, parentRssBytes + childRssBytes);
  };
  sample();
  const sampler = setInterval(sample, 20);
  const started = performance.now();
  let mapped: MappedResult;
  try {
    mapped = await mapWithMeasuredConcurrency(inputs, concurrency, (input) => backend.embedDocument(input), sample);
  } finally {
    clearInterval(sampler);
    sample();
  }
  const elapsedMs = performance.now() - started;
  const vectors = mapped.results.filter((result): result is Float32Array => result instanceof Float32Array);
  const errors = mapped.results.filter((result): result is { error: string } => !(result instanceof Float32Array));
  const digests = vectors.map(vectorDigest);
  const telemetry = backend.executionTelemetry();
  const equalToBaseline =
    baseline === null ||
    (errors.length === 0 &&
      digests.length === baseline.length &&
      digests.every((digest, index) => digest === baseline[index]));
  return {
    actual_child_high_water: telemetry.childHighWater,
    concurrency,
    digests,
    elapsed_ms: Math.round(elapsedMs),
    errors: errors.map((result) => result.error),
    output_count: vectors.length,
    output_dimensions: vectors[0]?.length ?? 0,
    output_equal_to_baseline: equalToBaseline,
    parent_high_water: mapped.highWater,
    peak_child_rss_bytes: telemetry.peakChildRssBytes,
    peak_combined_rss_bytes: peakCombinedRssBytes,
    peak_parent_rss_bytes: peakParentRssBytes,
  };
}

function assertRound(round: MeasuredRound, expectedCount: number): void {
  if (round.output_count !== expectedCount) {
    throw new Error("benchmark output cardinality mismatch");
  }
  if (round.errors.length !== 0) {
    throw new Error("benchmark observed transformer errors");
  }
  if (!round.output_equal_to_baseline) {
    throw new Error("benchmark output equality mismatch");
  }
  if (round.parent_high_water !== round.concurrency) {
    throw new Error("benchmark parent concurrency did not reach target");
  }
  if (round.actual_child_high_water !== round.concurrency) {
    throw new Error("benchmark child concurrency did not reach target");
  }
}

async function measureConcurrency(
  inputs: string[],
  concurrency: number,
  baseline: string[] | null
): Promise<ConcurrencyResult> {
  const backend = makeLocalTransformerBackend(undefined, {
    executorOptions: { queueLimit: Math.max(32, concurrency * 4), workLimit: concurrency },
  });
  if (!hasLocalTransformerTelemetry(backend)) {
    throw new Error("local transformer backend does not expose execution telemetry");
  }
  if (!backend.available()) {
    throw new Error("local transformer model cache is unavailable and download is not enabled");
  }
  try {
    // Model initialization is deliberately not part of measured throughput.
    const [firstInput] = inputs;
    if (firstInput === undefined) {
      throw new Error("benchmark requires at least one input sample");
    }
    await backend.embedDocument(firstInput);
    const rounds: MeasuredRound[] = [];
    let knownBaseline = baseline;
    for (let roundNumber = 0; roundNumber < MEASURED_ROUNDS; roundNumber += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: rounds must run sequentially on the SAME backend instance -- each round resets execution telemetry and reads it back, and the second round consumes the first round's digests as its equality baseline, so parallelizing would corrupt both the telemetry reset and the baseline comparison.
      const round = await runMeasuredRound(backend, inputs, concurrency, knownBaseline);
      if (knownBaseline === null) {
        knownBaseline = round.digests;
      }
      assertRound(round, inputs.length);
      rounds.push(round);
    }
    // MEASURED_ROUNDS is always >= 1, so the loop above ran at least once and
    // set knownBaseline whenever it started null — it cannot still be null here.
    if (knownBaseline === null) {
      throw new Error("benchmark measured zero rounds; no baseline was established");
    }
    return { baseline: knownBaseline, rounds };
  } finally {
    await backend.close();
  }
}

function selectSafestUsefulDefault(runs: ConcurrencyRun[]): SelectedDefault {
  const baseline = runs.find((run) => run.concurrency === 1);
  if (!baseline) {
    throw new Error("benchmark requires a concurrency=1 baseline run");
  }
  const baselineMs = median(baseline.rounds.map((round) => round.elapsed_ms));
  const fastestMs = Math.min(...runs.map((run) => median(run.rounds.map((round) => round.elapsed_ms))));
  const candidates = runs.filter((run) => {
    const elapsedMs = median(run.rounds.map((round) => round.elapsed_ms));
    return elapsedMs <= fastestMs * 1.1 && elapsedMs <= baselineMs * 0.85;
  });
  const selected =
    candidates.length > 0 ? [...candidates].sort((left, right) => left.concurrency - right.concurrency)[0] : baseline;
  if (!selected) {
    throw new Error("benchmark could not select a default work limit");
  }
  return {
    rationale:
      selected.concurrency === 1
        ? "No higher work limit was at least 15% faster while remaining within 10% of the fastest median."
        : "Lowest work limit within 10% of the fastest median and at least 15% faster than one worker.",
    work_limit: selected.concurrency,
  };
}

async function main(): Promise<void> {
  const { receiptPath } = parseArgs(process.argv.slice(2));
  const inputs = samples();
  const runs: ConcurrencyRun[] = [];
  let baseline: string[] | null = null;
  for (const concurrency of CONCURRENCIES) {
    // biome-ignore lint/performance/noAwaitInLoops: the benchmark deliberately measures each concurrency level in isolation (one bounded child pool at a time) so RSS/throughput samples aren't contaminated by a neighboring level's load; also threads a running `baseline` digest set forward for cross-round equality checks.
    const result = await measureConcurrency(inputs, concurrency, baseline);
    ({ baseline } = result);
    runs.push({ concurrency, rounds: result.rounds });
  }
  const identityBackend = makeLocalTransformerBackend();
  const receipt = {
    backend_identity: identityBackend.identity(),
    input_count: inputs.length,
    kind: "pdpp_local_transformer_benchmark_receipt",
    measured_rounds: MEASURED_ROUNDS,
    recorded_at: new Date().toISOString(),
    runs: runs.map(({ concurrency, rounds }) => ({
      concurrency,
      median_elapsed_ms: median(rounds.map((round) => round.elapsed_ms)),
      rounds: rounds.map(({ digests: _digests, ...round }) => round),
    })),
    selected_default: selectSafestUsefulDefault(runs),
  };
  const encoded = `${JSON.stringify(receipt, null, 2)}\n`;
  if (receiptPath) {
    await writeFile(receiptPath, encoded, "utf8");
  }
  process.stdout.write(encoded);
}

await main();
