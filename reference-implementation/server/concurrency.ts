/**
 * Bounded parallel map. Preserves input order in the output, runs at most
 * `limit` workers at a time, and exposes an in-flight counter via the optional
 * `onInFlightChange` hook so tests can prove the bound holds.
 *
 * Intentionally minimal: no dependency, no early-exit semantics, no
 * AbortSignal. Failures reject the returned promise once any in-flight worker
 * finishes; pending work is still drained to avoid hanging connections,
 * matching the prior `Promise.all` behavior.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: { readonly onInFlightChange?: (inFlight: number) => void } = {}
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let inFlight = 0;
  let firstError: unknown = null;
  const onChange = options.onInFlightChange;
  const runOne = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      inFlight++;
      onChange?.(inFlight);
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      try {
        results[index] = await worker(item, index);
      } catch (err) {
        if (firstError === null) {
          firstError = err;
        }
      } finally {
        inFlight--;
        onChange?.(inFlight);
      }
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < effectiveLimit; i++) {
    workers.push(runOne());
  }
  await Promise.all(workers);
  if (firstError !== null) {
    throw firstError;
  }
  return results;
}
