import readline from 'node:readline';

const extractors = new Map();
const workLimit = boundedPositive(process.env.PDPP_LOCAL_TRANSFORMER_WORK_LIMIT, 2, 8);
const queueLimit = boundedPositive(process.env.PDPP_LOCAL_TRANSFORMER_QUEUE_LIMIT, 32, 256);
const queue = [];
let active = 0;
let highWater = 0;

function boundedPositive(value, fallback, maximum) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

async function extractorFor(config) {
  const key = `${config.modelId}\u0000${config.dtype}\u0000${config.cacheDir}\u0000${config.downloadAllowed}`;
  if (extractors.has(key)) return extractors.get(key);
  const promise = import('@huggingface/transformers').then(async ({ env, LogLevel, pipeline }) => {
    env.allowLocalModels = true;
    env.allowRemoteModels = config.downloadAllowed;
    env.cacheDir = config.cacheDir;
    if (LogLevel?.ERROR !== undefined) env.logLevel = LogLevel.ERROR;
    return pipeline('feature-extraction', config.modelId, { dtype: config.dtype });
  });
  extractors.set(key, promise);
  return promise;
}

function telemetry() {
  return {
    active,
    highWater,
    queueDepth: queue.length,
    rssBytes: process.memoryUsage().rss,
  };
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function rejectJob(job) {
  send({
    generation: job?.generation ?? -1,
    jobId: job?.jobId ?? '',
    attempt: job?.attempt ?? -1,
    backendIdentity: job?.backendIdentity ?? '',
    error: 'transformer_compute_failed',
    telemetry: telemetry(),
  });
}

async function runJob(job) {
  try {
    const extractor = await extractorFor(job.config);
    const output = await extractor(String(job.text || ''), { pooling: 'mean', normalize: true });
    const vector = Array.from(output?.data ?? output);
    send({
      generation: job.generation,
      jobId: job.jobId,
      attempt: job.attempt,
      backendIdentity: job.backendIdentity,
      vector,
      telemetry: telemetry(),
    });
  } catch {
    rejectJob(job);
  } finally {
    active -= 1;
    queueMicrotask(pump);
  }
}

function pump() {
  while (active < workLimit && queue.length > 0) {
    const job = queue.shift();
    active += 1;
    highWater = Math.max(highWater, active);
    runJob(job).catch(() => undefined);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let job;
  try {
    job = JSON.parse(line);
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
