// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded parallel map. Preserves input order in the output, runs at most
 * `limit` workers at a time, and exposes an in-flight counter via the optional
 * `onInFlightChange` hook so tests can prove the bound holds.
 *
 * Intentionally minimal: no dependency, no early-exit semantics, no
 * AbortSignal. Failures reject after in-flight/pending read work drains, using
 * the lowest input-index failure so callers keep deterministic serial-style
 * error selection even though the reads overlap.
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
  const errors = new Array<unknown>(items.length);
  const hasError = new Array<boolean>(items.length).fill(false);
  let nextIndex = 0;
  let inFlight = 0;
  const onChange = options.onInFlightChange;
  const runOne = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      inFlight++;
      onChange?.(inFlight);
      const item = items[index] as T;
      try {
        results[index] = await worker(item, index);
      } catch (err) {
        errors[index] = err;
        hasError[index] = true;
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
  for (let index = 0; index < errors.length; index++) {
    if (hasError[index]) {
      throw errors[index];
    }
  }
  return results;
}
