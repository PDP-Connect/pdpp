import assert from 'node:assert/strict';
import test from 'node:test';

import { mapWithConcurrency } from '../server/concurrency.ts';

test('mapWithConcurrency preserves order, bounds concurrency, and accepts undefined values', async () => {
  let peakInFlight = 0;
  const result = await mapWithConcurrency(
    ['a', undefined, 'c'],
    2,
    async (item, index) => {
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 5 : 1));
      return item == null ? `missing-${index}` : `${item}-${index}`;
    },
    {
      onInFlightChange: (inFlight) => {
        peakInFlight = Math.max(peakInFlight, inFlight);
      },
    },
  );

  assert.deepEqual(result, ['a-0', 'missing-1', 'c-2']);
  assert.ok(peakInFlight > 1, `expected overlapping work, saw peak ${peakInFlight}`);
  assert.ok(peakInFlight <= 2, `expected bounded work, saw peak ${peakInFlight}`);
});

test('mapWithConcurrency reports the lowest input-index failure deterministically', async () => {
  const firstError = new Error('first binding failed slowly');
  const laterError = new Error('later binding failed quickly');

  await assert.rejects(
    () =>
      mapWithConcurrency(
        [0, 1, 2],
        3,
        async (item) => {
          if (item === 0) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw firstError;
          }
          if (item === 1) {
            throw laterError;
          }
          return item;
        },
      ),
    firstError,
  );
});
