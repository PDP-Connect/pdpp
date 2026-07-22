// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const DEFAULT_POSTGRES_SEARCH_FANOUT_CONCURRENCY = 8;

interface FanoutOptions {
  env?: NodeJS.ProcessEnv | undefined;
  isPostgres?: boolean | undefined;
}

export function resolveSearchFanoutConcurrency({ isPostgres, env = process.env }: FanoutOptions = {}): number {
  const raw = env.PDPP_RS_SEARCH_FANOUT_CONCURRENCY;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const normalized = String(raw).trim().toLowerCase();
    if (normalized === "unbounded" || normalized === "infinity") {
      return Number.POSITIVE_INFINITY;
    }
    const parsed = Number.parseInt(normalized, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return isPostgres ? DEFAULT_POSTGRES_SEARCH_FANOUT_CONCURRENCY : Number.POSITIVE_INFINITY;
}

export async function mapSearchFanout<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => R | Promise<R>,
  { isPostgres, env = process.env }: FanoutOptions = {}
): Promise<R[]> {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const concurrency = resolveSearchFanoutConcurrency({ isPostgres, env });
  if (!Number.isFinite(concurrency) || concurrency >= items.length) {
    return Promise.all(items.map((item, index) => mapper(item, index)));
  }

  const bounded = Math.max(1, Math.trunc(concurrency));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(bounded, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
