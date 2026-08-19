# The server said retry me and the client heard fatal

**Status:** root-caused on the live instance 2026-08-19. Client-side retry in
progress; the measurement below is complete.

## Scale first

Since 2026-08-16, on this instance:

- **129 runs killed**
- **56,440 buffered records dropped**
- roughly 50 runs a day, spread across all 24 hours — chronic, not a burst
- **9 connectors**: gmail 86, github 13, ynab 11, chatgpt 10, slack 4,
  groupme 2, notion / jellyfin / amazon 1 each

Gmail's 86 is the striking number. A great deal of the connector debugging this
week was chasing a server-side write failure that presents as a connector
failure.

## The chain

1. A few records of a batch hit `connector_instance_busy` — the writer
   admission gate, `DEFAULT_ACTIVE_LIMIT = 4` with a 2000ms wait. That gate is
   **global across all connector instances**, so unrelated background work
   (a startup backfill sweeping 25 connectors) can starve any single run.
2. `classifyIngestFailure` does the right thing: unknown and coordination
   errors are classified systemic, therefore **retryable**.
3. The server fails the whole batch with **503 `ingest_batch_storage_error`**
   and sets `Retry-After`. Three bad records out of five hundred kill all five
   hundred.
4. The client never retries. `runtime/index.ts:3382` is a bare `fetch`;
   `runtimeFailureReasonFromResponse` guards `status >= 400 && status < 500`,
   so a 503 falls through to `null`, `Retry-After` is never read, and the throw
   ends the run.

Every layer behaves correctly except the last one, and the last one is the only
one that decides whether data survives.

## The comment that made it invisible

`runtime/index.ts:3416-3425` states that a 503 becomes "a thrown, **retryable**
failure."

Nothing retries it. The comment describes an intention that was never
implemented, and it has been sitting directly above the code that fails to
implement it — which is exactly why nobody looked here. A reader checking
whether retry existed would have read that comment and moved on.

This is a fourth variant of the diagnosability family: **the code documents the
behavior you were looking for, so you stop looking.** Worse than silence,
because it actively redirects.

## The path that already works

The device-exporter path is not broken. `collector-runner.ts:150` classifies
all 5xx as transient and keeps the outbox row retryable regardless of attempt
count. Proof it self-heals: device `dexp_32b77c2650edf146` took **57
consecutive 503s** at 03:31 and had four batches accepted at 03:32, with zero
loss and only `accepted/201` rows in `device_ingest_batch_outcomes`.

So the correct behavior already exists in this repo, one directory over. The
connector runtime just never grew it.

## Ruled out, with evidence

Everything that looked like a resource problem was not:

- Postgres pool: 17 connections against `max_connections=100`
- Memory: 1.2 GiB of 6 GiB
- Embedding contention: zero semantic activity in the failing window
- `os.cpus()` returning 24 inside a 6-CPU container: the module reads the
  cgroup correctly (`cpu.max = 600000 100000` → `workLimit=4`,
  `intraOpNumThreads=1`). An earlier concern of mine, disproven.

CPU was pegged at 103% of the cap, which is real pressure, but the gate
saturates independently of it.

Batch size is not the trigger either — killed batches range from 15 to 500
records. A smaller batch narrows the window; it does not close it.

## The fix

Client-side retry on the connector ingest path, mirroring the device path:
honor `Retry-After`, bounded attempts and bounded total wait, retry only 5xx
and explicitly retryable classifications, and a distinct honest error when the
bound is exhausted so "the endpoint stayed saturated" never reads as "the data
was rejected."

A no-code stopgap exists — `PDPP_INGEST_ACTIVE_BATCH_LIMIT` 4→8 and
`PDPP_INGEST_LOCK_WAIT_MS` 2000→10000 — and is worth applying immediately
because it costs nothing and reduces the bleed. It widens the window rather
than fixing anything; runs still die under enough load until the client retries.

## Open

- ~~Are the 56,440 records lost, or re-fetched next run?~~ **Answered: not
  lost.** All 129 killed runs ran `checkpointed_streaming` with
  `persist_state: true`, and the failure payloads carry
  `checkpoint_commit: not_committed, retryable: true` — the cursor never
  advanced past the failed batch, so the next run re-fetches from it.
  Corroborated against Gmail's own record stream, the worst-hit connector with
  86 kills: it ingested about 50,000 records a day straight through the outage
  window, and across three days there is exactly one inter-record gap longer
  than two hours (2h40m, the shape of a quiet mailbox overnight, not a hole).

  So this bug cost work, wall-clock, and green status — not data. Worth
  stating plainly, because "56,440 records dropped" reads as loss and is not.
- **What saturated the global gate at 03:10?** No other run touched that
  instance and no semantic work was logged. The gate is global, so any
  concurrent writer counts, but the holder is not identifiable from current
  logs. Instrumenting `acquireAdmission` with holder identity would settle it.
- `ref-device-exporters.ts:2449` maps any unrecognized error to 503 with no
  logging, which would silently mask a genuine bug on the one route that
  currently works.

## Related

`failure-diagnosability-2026-08-18.md` — variants one through three.
`list-page-loses-unfillable-proof-2026-08-19.md` — a fact stranded from its
consumers, the same shape one layer up.
