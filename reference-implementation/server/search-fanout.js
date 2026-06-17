const DEFAULT_POSTGRES_SEARCH_FANOUT_CONCURRENCY = 8;

export function resolveSearchFanoutConcurrency({ isPostgres, env = process.env } = {}) {
  const raw = env.PDPP_RS_SEARCH_FANOUT_CONCURRENCY;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const normalized = String(raw).trim().toLowerCase();
    if (normalized === 'unbounded' || normalized === 'infinity') {
      return Number.POSITIVE_INFINITY;
    }
    const parsed = Number.parseInt(normalized, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return isPostgres ? DEFAULT_POSTGRES_SEARCH_FANOUT_CONCURRENCY : Number.POSITIVE_INFINITY;
}

export async function mapSearchFanout(items, mapper, { isPostgres, env = process.env } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const concurrency = resolveSearchFanoutConcurrency({ isPostgres, env });
  if (!Number.isFinite(concurrency) || concurrency >= items.length) {
    return Promise.all(items.map((item, index) => mapper(item, index)));
  }

  const bounded = Math.max(1, Math.trunc(concurrency));
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(bounded, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
