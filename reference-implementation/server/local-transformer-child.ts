// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import readline from "node:readline";
import type { DataType, FeatureExtractionPipeline } from "@huggingface/transformers";

/**
 * The embedding config the parent (`local-transformer-executor.ts`) forwards
 * unmodified as part of every job -- it treats it as an opaque
 * `Record<string, unknown>` and never inspects the fields itself. The real
 * shape is built by `server/search-semantic.js`'s embedding-profile
 * resolver (`modelId`, `dtype`, `cacheDir`, `downloadAllowed`); that file is
 * untyped `.js` and out of this migration's scope, so the fields are typed
 * `unknown` here and narrowed defensively at each read, same as the
 * pre-migration code's own implicit (and unchecked) assumptions.
 *
 * `intraOpNumThreads` is set by `embedding-concurrency.ts`'s
 * `resolveEmbeddingConcurrency()` (via the parent executor) and forwarded
 * into ONNX Runtime's own `SessionOptions.intraOpNumThreads`. Left unset,
 * a single inference session defaults to one native thread PER PHYSICAL
 * CORE (confirmed against ONNX Runtime's own threading docs and the
 * installed onnxruntime-common SessionOptions type) -- admitting several
 * concurrent jobs without capping this means each session independently
 * tries to claim every core, which a controlled benchmark measured as
 * consistently SLOWER than running one job at a time, not faster.
 */
interface TransformerJobConfig {
  cacheDir?: unknown;
  downloadAllowed?: unknown;
  dtype?: unknown;
  intraOpNumThreads?: unknown;
  modelId?: unknown;
}

/** Wire shape read from a single JSON line on stdin. */
interface TransformerJob {
  attempt?: unknown;
  backendIdentity?: unknown;
  config: TransformerJobConfig;
  generation?: unknown;
  jobId?: unknown;
  text?: unknown;
}

interface TransformerTelemetry {
  active: number;
  highWater: number;
  queueDepth: number;
  rssBytes: number;
}

/** Wire shape written to stdout for both the success and failure replies. */
interface TransformerReply {
  attempt: unknown;
  backendIdentity: unknown;
  error?: string;
  generation: unknown;
  jobId: unknown;
  telemetry: TransformerTelemetry;
  vector?: number[];
}

const extractors = new Map<string, Promise<FeatureExtractionPipeline>>();
const workLimit = boundedPositive(process.env.PDPP_LOCAL_TRANSFORMER_WORK_LIMIT, 2, 8);
const queueLimit = boundedPositive(process.env.PDPP_LOCAL_TRANSFORMER_QUEUE_LIMIT, 32, 256);
const queue: TransformerJob[] = [];
let active = 0;
let highWater = 0;

function boundedPositive(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

/**
 * Build the `{ dtype }` options fragment for pipeline(), omitting the key
 * entirely when absent rather than setting it to `undefined` --
 * exactOptionalPropertyTypes distinguishes "key absent" from "key present
 * with value undefined", and the pipeline() options type only accepts the
 * former. The value itself is forwarded verbatim from opaque job-config
 * JSON via a plain assertion (this module never branches on it); narrowing
 * further would invent validation this module never performed.
 */
function dtypeOption(value: unknown): { dtype: DataType | Record<string, DataType> } | Record<string, never> {
  return value === undefined ? {} : { dtype: value as DataType | Record<string, DataType> };
}

/**
 * Build the `{ session_options }` fragment for pipeline(), omitting the key
 * entirely when `intraOpNumThreads` is absent/invalid rather than forcing
 * some other value -- an invalid value falls back to ONNX Runtime's own
 * default (one thread per physical core) instead of this module inventing
 * validation it never performed elsewhere.
 */
function sessionOptions(value: unknown): { session_options: { intraOpNumThreads: number } } | Record<string, never> {
  const threads = Number(value);
  return Number.isInteger(threads) && threads > 0 ? { session_options: { intraOpNumThreads: threads } } : {};
}

async function extractorFor(config: TransformerJobConfig): Promise<FeatureExtractionPipeline> {
  const key = `${config.modelId}\u0000${config.dtype}\u0000${config.cacheDir}\u0000${config.downloadAllowed}\u0000${config.intraOpNumThreads}`;
  const cached = extractors.get(key);
  if (cached) {
    return cached;
  }
  const promise = import("@huggingface/transformers").then(async ({ env, LogLevel, pipeline }) => {
    env.allowLocalModels = true;
    env.allowRemoteModels = Boolean(config.downloadAllowed);
    env.cacheDir = typeof config.cacheDir === "string" ? config.cacheDir : null;
    if (LogLevel?.ERROR !== undefined) {
      env.logLevel = LogLevel.ERROR;
    }
    return pipeline("feature-extraction", typeof config.modelId === "string" ? config.modelId : undefined, {
      ...dtypeOption(config.dtype),
      ...sessionOptions(config.intraOpNumThreads),
    });
  });
  extractors.set(key, promise);
  return promise;
}

function telemetry(): TransformerTelemetry {
  return {
    active,
    highWater,
    queueDepth: queue.length,
    rssBytes: process.memoryUsage().rss,
  };
}

function send(value: TransformerReply): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function rejectJob(job: TransformerJob | null): void {
  send({
    attempt: job?.attempt ?? -1,
    backendIdentity: job?.backendIdentity ?? "",
    error: "transformer_compute_failed",
    generation: job?.generation ?? -1,
    jobId: job?.jobId ?? "",
    telemetry: telemetry(),
  });
}

async function runJob(job: TransformerJob): Promise<void> {
  try {
    const extractor = await extractorFor(job.config);
    const output = await extractor(String(job.text || ""), { normalize: true, pooling: "mean" });
    const vector = Array.from(output.data);
    send({
      attempt: job.attempt,
      backendIdentity: job.backendIdentity,
      generation: job.generation,
      jobId: job.jobId,
      telemetry: telemetry(),
      // Tensor.data's own type is AnyTypedArray | any[] (the pipeline never
      // returns a BigInt64Array for feature-extraction, only float/int
      // typed arrays); asserting the narrower number[] documents that
      // real contract instead of leaving the any[] branch of the upstream
      // union to silently widen this reply's own vector?: number[] field.
      vector: vector as number[],
    });
  } catch {
    rejectJob(job);
  } finally {
    active -= 1;
    queueMicrotask(pump);
  }
}

let shuttingDown = false;

function pump(): void {
  while (!shuttingDown && active < workLimit && queue.length > 0) {
    const job = queue.shift();
    if (!job) {
      break;
    }
    active += 1;
    highWater = Math.max(highWater, active);
    runJob(job).catch(() => undefined);
  }
}

// Stop admitting work and exit on a supervisor signal. Without this the child
// relies on Node's default disposition, which never fires while the main thread
// is blocked in a synchronous native call — the parent then has to escalate to
// SIGKILL. This handler cannot rescue a child already wedged inside native code,
// but it makes an ordinary busy child shut down promptly instead of being killed.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    queue.length = 0;
    process.exit(0);
  });
}

const input = readline.createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: process.stdin });
input.on("line", (line: string) => {
  let job: TransformerJob;
  try {
    job = JSON.parse(line) as TransformerJob;
  } catch {
    rejectJob(null);
    return;
  }
  if (queue.length >= queueLimit) {
    rejectJob(job);
    return;
  }
  queue.push(job);
  pump();
});
