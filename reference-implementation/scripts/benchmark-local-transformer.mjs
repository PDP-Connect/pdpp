#!/usr/bin/env node

/**
 * Operational receipt harness for the child-backed local Transformer profile.
 *
 * It intentionally does no database or HTTP work. Each concurrency receives a
 * fresh bounded child, an untimed warm-up, then two measured rounds. The receipt
 * records parent and child RSS, child execution high-water, cardinality, and
 * bitwise output equality before selecting the lowest safely useful work limit.
 */

import { writeFile } from 'node:fs/promises';

import { makeLocalTransformerBackend } from '../server/search-semantic.js';

const SAMPLE_COUNT = 100;
const CONCURRENCIES = [1, 2, 4, 8];
const MEASURED_ROUNDS = 2;

function parseArgs(argv) {
  const receiptIndex = argv.indexOf('--receipt');
  if (receiptIndex === -1) return { receiptPath: null };
  const receiptPath = argv[receiptIndex + 1];
  if (!receiptPath) throw new Error('--receipt requires a path');
  return { receiptPath };
}

function samples() {
  return Array.from({ length: SAMPLE_COUNT }, (_, index) =>
    `Synthetic local-transformer benchmark record ${index}: durable collector index repair payload.`,
  );
}

function vectorDigest(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

async function mapWithMeasuredConcurrency(items, concurrency, worker, sample) {
  const results = new Array(items.length);
  let active = 0;
  let highWater = 0;
  let next = 0;
  const run = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      active += 1;
      highWater = Math.max(highWater, active);
      sample();
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        results[index] = { error: error?.code || 'transformer_compute_failed' };
      } finally {
        active -= 1;
        sample();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return { highWater, results };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

async function runMeasuredRound(backend, inputs, concurrency, baseline) {
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
  let mapped;
  try {
    mapped = await mapWithMeasuredConcurrency(inputs, concurrency, (input) => backend.embedDocument(input), sample);
  } finally {
    clearInterval(sampler);
    sample();
  }
  const elapsedMs = performance.now() - started;
  const vectors = mapped.results.filter((result) => result instanceof Float32Array);
  const errors = mapped.results.filter((result) => !(result instanceof Float32Array));
  const digests = vectors.map(vectorDigest);
  const telemetry = backend.executionTelemetry();
  const equalToBaseline =
    baseline === null ||
    (errors.length === 0 && digests.length === baseline.length && digests.every((digest, index) => digest === baseline[index]));
  return {
    concurrency,
    elapsed_ms: Math.round(elapsedMs),
    output_count: vectors.length,
    output_dimensions: vectors[0]?.length ?? 0,
    output_equal_to_baseline: equalToBaseline,
    parent_high_water: mapped.highWater,
    actual_child_high_water: telemetry.childHighWater,
    peak_parent_rss_bytes: peakParentRssBytes,
    peak_child_rss_bytes: telemetry.peakChildRssBytes,
    peak_combined_rss_bytes: peakCombinedRssBytes,
    errors: errors.map((result) => result.error),
    digests,
  };
}

function assertRound(round, expectedCount) {
  if (round.output_count !== expectedCount) throw new Error('benchmark output cardinality mismatch');
  if (round.errors.length !== 0) throw new Error('benchmark observed transformer errors');
  if (!round.output_equal_to_baseline) throw new Error('benchmark output equality mismatch');
  if (round.parent_high_water !== round.concurrency) throw new Error('benchmark parent concurrency did not reach target');
  if (round.actual_child_high_water !== round.concurrency) throw new Error('benchmark child concurrency did not reach target');
}

async function measureConcurrency(inputs, concurrency, baseline) {
  const backend = makeLocalTransformerBackend(undefined, {
    executorOptions: { workLimit: concurrency, queueLimit: Math.max(32, concurrency * 4) },
  });
  if (!backend.available()) {
    throw new Error('local transformer model cache is unavailable and download is not enabled');
  }
  try {
    // Model initialization is deliberately not part of measured throughput.
    await backend.embedDocument(inputs[0]);
    const rounds = [];
    let knownBaseline = baseline;
    for (let roundNumber = 0; roundNumber < MEASURED_ROUNDS; roundNumber += 1) {
      const round = await runMeasuredRound(backend, inputs, concurrency, knownBaseline);
      if (knownBaseline === null) knownBaseline = round.digests;
      assertRound(round, inputs.length);
      rounds.push(round);
    }
    return { baseline: knownBaseline, rounds };
  } finally {
    await backend.close();
  }
}

function selectSafestUsefulDefault(runs) {
  const baseline = runs.find((run) => run.concurrency === 1);
  const baselineMs = median(baseline.rounds.map((round) => round.elapsed_ms));
  const fastestMs = Math.min(...runs.map((run) => median(run.rounds.map((round) => round.elapsed_ms))));
  const candidates = runs.filter((run) => {
    const elapsedMs = median(run.rounds.map((round) => round.elapsed_ms));
    return elapsedMs <= fastestMs * 1.1 && elapsedMs <= baselineMs * 0.85;
  });
  const selected = candidates.length > 0 ? candidates.sort((left, right) => left.concurrency - right.concurrency)[0] : baseline;
  return {
    work_limit: selected.concurrency,
    rationale:
      selected.concurrency === 1
        ? 'No higher work limit was at least 15% faster while remaining within 10% of the fastest median.'
        : 'Lowest work limit within 10% of the fastest median and at least 15% faster than one worker.',
  };
}

async function main() {
  const { receiptPath } = parseArgs(process.argv.slice(2));
  const inputs = samples();
  const runs = [];
  let baseline = null;
  for (const concurrency of CONCURRENCIES) {
    const result = await measureConcurrency(inputs, concurrency, baseline);
    baseline = result.baseline;
    runs.push({ concurrency, rounds: result.rounds });
  }
  const receipt = {
    kind: 'pdpp_local_transformer_benchmark_receipt',
    recorded_at: new Date().toISOString(),
    input_count: inputs.length,
    measured_rounds: MEASURED_ROUNDS,
    backend_identity: makeLocalTransformerBackend().identity(),
    selected_default: selectSafestUsefulDefault(runs),
    runs: runs.map(({ concurrency, rounds }) => ({
      concurrency,
      rounds: rounds.map(({ digests, ...round }) => round),
      median_elapsed_ms: median(rounds.map((round) => round.elapsed_ms)),
    })),
  };
  const encoded = `${JSON.stringify(receipt, null, 2)}\n`;
  if (receiptPath) await writeFile(receiptPath, encoded, 'utf8');
  process.stdout.write(encoded);
}

await main();
