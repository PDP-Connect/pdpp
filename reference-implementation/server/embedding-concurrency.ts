// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single shared derivation of embedding concurrency for BOTH layers that
 * need it: `search-semantic.ts`'s semantic-work admission semaphore and
 * `local-transformer-executor.ts`'s own `workLimit` (forwarded to the
 * child's job-dispatch pump). Computed once, from the same inputs — see
 * `docs`/report residual notes for the pre-fix state where each called
 * `effectiveCpuCount()` independently.
 *
 * `workLimit` is ALWAYS a member of `{1, 2, 4, 8}` (both the CPU- and
 * memory-derived candidates are snapped through `concurrencyStepFor`
 * before the final `min()`), so the two consumers' own default-derivation
 * call sites (`local-transformer-executor.ts`'s unsnapped
 * `Math.min(resolveEmbeddingConcurrency().workLimit, 8)` and
 * `search-semantic.ts`'s `semanticWorkLimitStepForCpuCount(...)`) land on
 * the identical number, not merely on values where one side's is provably
 * always >= the other's. An earlier version of this function only snapped
 * the CPU candidate, which left a real (if non-blocking — an independent
 * review proved the resulting mismatch could only ever manifest as unused
 * executor headroom, since the semaphore is always the sole caller of
 * `executor.embed()` and stayed the binding outer gate) gap whenever memory
 * was the tighter constraint and its raw worker count landed on a
 * non-step value (3, 5, 6, 7, ...) — see `test/embedding-concurrency.test.ts`
 * for the exact `cpu=4, mem=1200MiB` case that exercised it.
 *
 * Three inputs are combined, and the model deliberately does NOT treat
 * "more CPUs" as "more concurrency" on its own:
 *
 * 1. CPU quota (`cpu-quota.ts`). A quota below one whole core, or an
 *    `"unknown"` quota (cgroup mounted but unreadable — the Fly.io/
 *    Firecracker guest-visibility ambiguity this module's sibling
 *    documents), floors to a CPU budget of 1 and this function returns the
 *    safe floor immediately.
 *
 * 2. Memory quota (`cpu-quota.ts`). A single embedding worker's measured
 *    peak child RSS on the shipped `minilm` (q4 MiniLM) profile was
 *    ~291MB (`/tmp/embedding-transformer-benchmark-0809*.json`, concurrency
 *    1, two independent runs, max observed). `PER_WORKER_MEMORY_BUDGET_BYTES`
 *    below adds headroom over that measured peak (a short synthetic
 *    benchmark's peak-sampling window can understate sustained load), plus
 *    a fixed reservation for the parent Node process's own baseline
 *    footprint (routes, DB connections, other in-flight work) that a
 *    worker-only RSS measurement does not capture. On the shipped Fly.io
 *    reference deploy (512MiB total, `deploy/flyio/fly.toml`), this alone
 *    caps concurrency at 1 — there is no safe memory headroom for a second
 *    concurrent worker on that target regardless of CPU quota.
 *
 * 3. ONNX Runtime's own threading model (verified against
 *    https://onnxruntime.ai/docs/performance/tune-performance/threading.html
 *    and the installed `onnxruntime-common@1.24.3` SessionOptions type: a
 *    single inference session defaults to one native thread PER CORE when
 *    `intraOpNumThreads` is left unset — concurrency and per-session
 *    threading are not independent knobs, they compound. A controlled
 *    benchmark isolating this (concurrency x intraOpNumThreads grid,
 *    3 runs, `Xenova/all-MiniLM-L6-v2` q4, this box's 24 logical cores)
 *    confirmed: concurrency=8 with unset threads is CONSISTENTLY THE
 *    WORST result (630-836ms median for 100 embeds, worse than
 *    concurrency=1), while splitting the SAME core budget across a few
 *    concurrent sessions with `intraOpNumThreads` explicitly capped
 *    (concurrency=2/intraOp=6, or concurrency=1/intraOp=cpuBudget) was
 *    consistently the fastest (~150-230ms, 3-4x faster), with
 *    bitwise-identical output at every point. `resolveEmbeddingConcurrency`
 *    therefore always returns a `workLimit`/`intraOpNumThreads` PAIR whose
 *    product does not exceed the CPU budget, never a `workLimit` alone.
 */

import { effectiveCpuCount, effectiveMemoryBudgetBytes } from "./cpu-quota.ts";

// Measured max observed peak_child_rss_bytes at concurrency=1 across two
// benchmark runs was 290996224 (~277.5MiB). Adds ~25% headroom for
// sustained-load underestimation by a short synthetic benchmark, rounded
// to a clean value.
const PER_WORKER_MEMORY_BUDGET_BYTES = 350 * 1024 * 1024;
// Reserves room for the parent Node process's own baseline (routes, DB
// connections, other in-flight work) that a child-only RSS measurement
// does not capture — distinct from any one worker's own footprint.
const PARENT_BASELINE_MEMORY_BYTES = 150 * 1024 * 1024;

export interface EmbeddingConcurrencyPlan {
  /** Native ONNX Runtime threads (`intraOpNumThreads`) each session should use. */
  readonly intraOpNumThreads: number;
  /** How many embedding jobs may run concurrently (JS-level dispatch admission). */
  readonly workLimit: number;
}

/**
 * Highest power-of-two-ish step at or below `cpuBudget`, matching the
 * measured benchmark grid's own concurrency levels (1, 2, 4, 8) — the
 * values this module's benchmark actually exercised, not an unmeasured
 * interpolation.
 */
function concurrencyStepFor(cpuBudget: number): number {
  const steps = [1, 2, 4, 8] as const;
  let selected: number = steps[0];
  for (const step of steps) {
    if (step <= cpuBudget) {
      selected = step;
    }
  }
  return selected;
}

/**
 * `intraOpNumThreads` for a GIVEN `workLimit` (which may be an explicit
 * operator override of either PDPP_SEMANTIC_WORK_LIMIT or
 * PDPP_LOCAL_TRANSFORMER_WORK_LIMIT, not necessarily this module's own
 * derived default) against a given CPU budget. Exported so both env-var
 * override paths can still divide the SAME core budget across whatever
 * workLimit ends up in effect, instead of only cooperating when neither
 * side is overridden — an operator who overrides one env var without the
 * other still gets threads sized to the ACTUAL concurrency that will run,
 * not to this module's own unused default.
 */
export function intraOpNumThreadsForWorkLimit(workLimit: number, cpuCount: number = effectiveCpuCount()): number {
  const cpuBudget = Math.max(1, Math.floor(cpuCount));
  const safeWorkLimit = Math.max(1, Math.floor(workLimit) || 1);
  return Math.max(1, Math.floor(cpuBudget / safeWorkLimit));
}

/**
 * Joint derivation used by both the semantic-work semaphore default and the
 * transformer executor's own `workLimit` default. Always returns a safe
 * pair (`workLimit * intraOpNumThreads` never exceeds the CPU budget,
 * `workLimit` never exceeds what the memory budget can hold).
 */
export function resolveEmbeddingConcurrency(
  cpuCount: number = effectiveCpuCount(),
  memoryBudgetBytes: number = effectiveMemoryBudgetBytes()
): EmbeddingConcurrencyPlan {
  const memoryForWorkers = memoryBudgetBytes - PARENT_BASELINE_MEMORY_BYTES;
  const rawMemoryAllowedWorkers =
    memoryForWorkers > 0 ? Math.max(1, Math.floor(memoryForWorkers / PER_WORKER_MEMORY_BUDGET_BYTES)) : 1;
  // Snapped through the SAME step function as the CPU side, before the
  // min() below — otherwise a memory-bound raw worker count that lands on
  // a non-step value (3, 5, 6, 7, ...) makes `workLimit` itself a non-step
  // value. That is safe (an independent review proved the executor's own
  // unsnapped Math.min(rawWorkLimit, 8) default is always >= the
  // semaphore's snapped default, so the semaphore — the sole caller of
  // executor.embed() — remains the binding outer gate either way) but it
  // means the two default-derivation call sites literally disagree on the
  // number, not just safely nest. Snapping here makes them agree exactly,
  // not just safely, closing that gap at the source instead of relying on
  // both call sites individually reasoning about which one wins.
  const memoryAllowedWorkers = concurrencyStepFor(rawMemoryAllowedWorkers);

  const cpuBudget = Math.max(1, Math.floor(cpuCount));
  const cpuAllowedWorkers = concurrencyStepFor(cpuBudget);

  const workLimit = Math.max(1, Math.min(cpuAllowedWorkers, memoryAllowedWorkers));
  // Never exceed the CPU budget's product: each of `workLimit` concurrent
  // sessions gets an equal share of the cores this process is actually
  // entitled to, instead of each independently trying to claim all of them
  // (the oversubscription this module exists to prevent).
  const intraOpNumThreads = intraOpNumThreadsForWorkLimit(workLimit, cpuBudget);

  return { intraOpNumThreads, workLimit };
}
