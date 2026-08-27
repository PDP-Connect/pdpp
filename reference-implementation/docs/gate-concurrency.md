# Gate concurrency: measured safe ceiling

## The finding

`scripts/run-tests.ts` caps file concurrency at **2**:

```ts
const defaultConcurrency = Math.max(1, Math.min(2, availableParallelism?.() ?? 1, testFiles.length || 1));
```

On a 24-core host that is the difference between a ~20-minute gate and an
~8-minute one. `PDPP_TEST_CONCURRENCY` already overrides it — no code change is
required to go faster.

## Measured, on 24 cores

| Concurrency | Elapsed | Exit | Failures |
|---|---:|---:|---:|
| 2 (default) | ~1200s | 0 | 0 |
| 6 | **465s** | **0** | **0** |
| 12 | 399s | 1 | 4 |

995 files, 9,935 passing assertions at concurrency 6 — identical verdict to the
default, in 39% of the wall clock.

## Why 12 fails, and why the cap is not arbitrary

The four failures at 12 are all timing/lock-sensitive:

- `SQLite connector-wide bulk deletion serializes the actual same-instance writer, while a sibling instance overlaps`
- `SQLite direct ingest queued before bulk deletion deterministically leaves the bulk-delete final state`
- `SQLite lexical manifest backfill waits on its actual instance but does not block a sibling writer`
- `a WhatsApp .txt upload well past the old 1 GiB cap streams to disk and validates successfully`

All four pass in isolation (26 tests, 0 failures), so these are CONTENTION
ARTIFACTS, not code defects. Three assert real serialization ordering against
SQLite writers; the fourth streams a >1 GiB file. Under enough parallel load
they lose their timing assumptions.

That is worth stating plainly: a faster gate that reports failures which are
not real is worse than a slow one, because it teaches the reader to discount
red. **6 is the measured ceiling at which the verdict stays trustworthy on this
host.** It is a host-specific number, not a universal one — re-measure on
different hardware rather than porting the constant.

## Recommendation

Do NOT change `defaultConcurrency`. The cap of 2 is a safe default for unknown
hardware, and CI may well be a 2-core runner where raising it would only cause
contention.

Set it per-invocation where the host is known:

```sh
PDPP_TEST_CONCURRENCY=6 pnpm --dir reference-implementation test
```

## Sharding beyond this

Per-package parallelism (RI / connectors / console as concurrent invocations)
is orthogonal to this and stacks with it: those suites share no SQLite files or
temp directories, so they do not contend the way intra-RI files do. RI is by
far the longest pole, so raising ITS concurrency is where the wall-clock win
actually is — a separate console/connectors invocation saves little if RI still
takes 8 minutes alone.
