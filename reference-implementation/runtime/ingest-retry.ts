// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Bounded retry policy for the connector runtime's RECORD-batch ingest POST.
//
// ─── Why this exists ────────────────────────────────────────────────────────
//
// The RS answers a SYSTEMIC ingest failure — a storage/coordination fault that
// never proved any record's own data invalid — with 503 `ingest_batch_storage_error`
// (see server/routes/ref-error-status.ts, whose own comment states 503 means
// "not your fault, safe to retry the identical batch"). The dominant real-world
// producer of that 503 is `connector_instance_busy`: the writer-admission gate
// in server/connector-instance-write-coordinator.ts is GLOBAL across connector
// instances (`PDPP_INGEST_ACTIVE_BATCH_LIMIT`, default 4, waiting
// `PDPP_INGEST_LOCK_WAIT_MS`, default 2000ms), so unrelated background work can
// starve an otherwise-healthy run for a few hundred milliseconds.
//
// The server said "retry me". Until this module existed, the runtime did not:
// `flushBatch` issued a bare `fetch` and threw on any non-2xx, killing the whole
// run and discarding every record still buffered for it.
//
// ─── Relationship to the device-exporter path ───────────────────────────────
//
// The local device/collector path already survives exactly this 503 storm, and
// it is the reference this module mirrors — deliberately, at the level of
// POLICY rather than code:
//
//   - `classifyLocalDeviceFailure` (packages/polyfill-connectors/src/collector-runner.ts)
//     classifies retryability from STRUCTURED fields only — a typed HTTP status,
//     a typed timeout class — never from error message prose. {@link isRetryableIngestStatus}
//     keeps that rule: it reads a numeric status and nothing else.
//   - `failOutboxItem` (same file) honors the server's `Retry-After` bounded by
//     `maxRetryAfterMs`, and otherwise falls back to its own backoff schedule.
//     {@link nextIngestRetryDelayMs} keeps that precedence and that bound.
//
// The two paths deliberately do NOT share an implementation, because they do
// not share a mechanism. The device path is DURABLE: a failed batch stays a
// `ready` row in a SQLite outbox and is re-attempted on a later runner
// invocation, so its "retry" spans process lifetimes and its bound is an
// attempt counter persisted in a table. The connector runtime holds its batch
// only in memory inside `flushBatch`, so its retry must complete within the
// call or the records are gone. Extracting a common helper would have to
// abstract over "durable row" vs "in-memory array", producing a shallow
// wrapper that hides no real depth — and would put the one path that
// demonstrably works at risk to serve the one that does not. The shared thing
// worth sharing is the policy, which is documented here and asserted by tests
// in both places.
//
// ─── Why an in-request retry is safe here (idempotency) ─────────────────────
//
// Re-POSTing an identical batch cannot double-write, and this was verified
// against the storage layer rather than assumed.
//
// The `records` table carries `UNIQUE(connector_instance_id, stream, record_key)`
// on both backends (server/db.ts for SQLite, server/postgres-storage.ts for
// Postgres), and every write is an upsert — `ON CONFLICT (connector_instance_id,
// stream, record_key) DO UPDATE` (server/postgres-records.ts, and the SQLite
// equivalent in server/records.ts). `record_key` is the connector-supplied
// envelope `key`, canonically encoded by `encodeKey`. A record that landed on
// attempt 1 is therefore OVERWRITTEN on attempt 2, not appended; when the
// payload is byte-identical the write short-circuits to a no-op that does not
// even bump the row's version.
//
// This matters more than it might appear, because a batch is NOT written
// atomically. `ingestRecordsWithinCoordinator` (server/records.ts) commits each
// record in its OWN transaction, so when a few records in a batch of 100 fail
// on `connector_instance_busy`, the other 96 have already committed durably —
// the 503 changes only what the HTTP response reports, never what is in the
// table. Replaying the whole batch re-upserts those 96 onto their existing rows
// instead of duplicating them, which is exactly why an accepted-prefix does not
// corrupt data on retry. The operation documents this contract at
// operations/rs-records-ingest/index.ts, `ref-error-status.ts` states a 503 is
// "safe to retry the identical batch", and
// test/runtime-ingest-systemic-failure-contract.test.ts proves the end-to-end
// no-duplicate-rows property against a real server.
//
// The one caveat, which belongs to the connector rather than to this module:
// dedup is keyed on the record key the CONNECTOR emits. A connector that emits
// a nondeterministic key (a fresh uuid, a collection timestamp) for the same
// logical record would write two rows on a replay, and no server-side
// constraint can detect that. Retrying does not introduce that hazard — a
// connector with unstable keys already duplicates across ordinary re-runs — but
// it does mean retry-safety here rests on key stability, which is a per-
// connector property this module cannot enforce.
//
// ─── What this module deliberately does NOT retry ───────────────────────────
//
// Only a status the server marked retryable. A 4xx stays fatal on the first
// response exactly as before: a 400/422 means the RS rejected this batch on its
// CONTENT, and replaying identical content would only reproduce the rejection
// while delaying an honest terminal failure. 401/403 are credential faults that
// no amount of waiting repairs. A 2xx envelope reporting `records_rejected` is
// the per-record isolation contract and never reaches this module.

/**
 * Bounds for one batch's retry sequence. Every field is finite by
 * construction: the sequence can never exceed `maxAttempts` requests, and
 * cannot wait longer than `maxAttempts - 1` sleeps each capped at
 * `maxDelayMs`/`maxRetryAfterMs`.
 */
export interface IngestRetryPolicy {
  /** First backoff, before exponential growth and jitter. */
  baseDelayMs: number;
  /** Total requests, INCLUDING the first. `1` disables retrying. */
  maxAttempts: number;
  /** Ceiling on a single computed backoff sleep. */
  maxDelayMs: number;
  /** Ceiling on a single sleep derived from a server `Retry-After`. */
  maxRetryAfterMs: number;
}

/**
 * Default bounds, sized against the failure this fix targets.
 *
 * The gate that produces the 503 waits `PDPP_INGEST_LOCK_WAIT_MS` (2000ms by
 * default) before rejecting, and admission frees up as soon as any one of the
 * four global slots finishes a batch — an event measured in hundreds of
 * milliseconds, not minutes. The observed live storm bears that out: the device
 * path took 57 consecutive 503s and was fully accepted roughly a minute later.
 *
 * 4 attempts with a 500ms base therefore spans a worst case of
 * 500 + 1000 + 2000 = 3500ms of nominal backoff (up to 5250ms with the +50%
 * jitter ceiling, and never more than 3 × `maxDelayMs` = 24000ms even if
 * `baseDelayMs` were raised) — comfortably longer than a saturation episode,
 * and short enough that a genuinely wedged server surfaces an honest terminal
 * failure quickly rather than parking a run for minutes.
 */
export const DEFAULT_INGEST_RETRY_POLICY: Readonly<IngestRetryPolicy> = Object.freeze({
  baseDelayMs: 500,
  maxAttempts: 4,
  maxDelayMs: 8000,
  maxRetryAfterMs: 15_000,
});

/**
 * `failure_reason` carried by the terminal error thrown once the retry bound is
 * exhausted. Distinct from `ingest_http_error` (a single non-retryable ingest
 * rejection) precisely so an operator can tell "the ingest endpoint stayed
 * saturated and we gave up waiting" apart from "the RS rejected this batch."
 * Those need different responses — the first is a capacity/backpressure
 * problem, the second is a data or configuration defect.
 */
export const INGEST_SATURATED_FAILURE_REASON = "ingest_endpoint_saturated";

/**
 * Is this HTTP status one the server is telling us to retry?
 *
 * STRUCTURED input only — a number. This function never inspects a response
 * body or an error message, mirroring `classifyLocalDeviceFailure`'s rule that
 * a live failure is classified from typed fields, never from prose that a
 * proxy or connector could have folded an unrelated "503" into.
 *
 * 503 is the ONLY status this loop retries, plus 408. That is not a narrowing
 * of the RS contract, it IS the RS contract: every ingest failure the server
 * classifies as retryable backpressure answers 503 —
 * `connector_instance_busy`, `ingest_batch_storage_error`, and `run_terminal`
 * (`routes/ref-error-status.ts`). 408 (request timeout) is included for the
 * same reason the device path includes it: an explicit, standard "this
 * attempt, not this content" signal.
 *
 * A BARE 500 IS NOT RETRIED. Retrying the whole 5xx band swept in a class the
 * server never means as backpressure: the one RS code that maps to 500 is
 * `connector_instance_store_required`, a configuration defect that no amount
 * of waiting clears. `ref-device-exporters.ts` names the distinction directly
 * — it returns "a typed 503 with Retry-After instead of the misleading untyped
 * 500". Burning the retry budget on a 500 only delays an honest terminal
 * failure and, worse, hides it: the run reports `ingest_endpoint_saturated`
 * ("we waited and it stayed busy") for what is really a misconfigured store.
 * 502/504 are likewise left out — an intermediary's own fault is not the
 * server telling us to retry.
 *
 * 429 IS ALSO DELIBERATELY EXCLUDED, for a different reason than 500: not
 * "the server does not mean retry" but "this is not the layer that should".
 * A 503 here is writer-admission contention
 * (`connector_instance_busy`) — local, sub-second, and genuinely cleared by
 * waiting a few hundred milliseconds, which is exactly what this runtime's
 * 4-attempt / ~3.5s budget buys. A 429 is SOURCE PRESSURE from the upstream
 * provider, measured in minutes to hours, and retry ownership for it belongs
 * to the SCHEDULER, not this runtime:
 *
 *   - `server/stores/terminal-gap-classifier.ts:20` states the rule directly:
 *     429 is explicitly transient, must NEVER terminalize a gap, and arms the
 *     source-pressure cooldown instead.
 *   - `scheduler-source-pressure-cooldown.ts` owns that cooldown, backs off up
 *     to `DEFAULT_MAX_COOLDOWN_MS` (6 hours), and persists it ACROSS runs.
 *
 * Absorbing a 429 here actively destroys runs. This loop burns its whole ~3.5s
 * budget against a limit that will not lift in 3.5s, then fails terminally as
 * `INGEST_SATURATED_FAILURE_REASON` — so the scheduler never observes the
 * `rate_limit_error` it keys on, never arms the cooldown, and never retries.
 * Letting the 429 through on its first response surfaces it intact to the
 * layer that can actually wait it out.
 *
 * The 429 -> `rate_limit_error` mappings in `routes/ref-error-status.ts` and
 * `ingest-failures.ts` are load-bearing for that handoff and must stay.
 */
export function isRetryableIngestStatus(status: number): boolean {
  return status === 408 || status === 503;
}

/**
 * Structured error codes that mean "the TCP/TLS connection to the RS never
 * produced a response" — as opposed to a response the RS chose to send (a
 * status code, handled by {@link isRetryableIngestStatus}). Node's `fetch`
 * (undici) throws `TypeError: fetch failed` for this whole class, with the
 * actual cause nested one level down in `error.cause.code`; this reads that
 * structured field, never the outer message string, for the same reason
 * {@link isRetryableIngestStatus} reads a numeric status and nothing else.
 *
 * This is a distinct failure mode from every case this module already
 * retries: no HTTP response ever arrived, so there is no status and no body
 * to inspect. Before this exists, a `fetch()` throw here is UNCAUGHT — it
 * propagates straight past the retry loop and kills the whole run,
 * discarding every buffered record and, worse, every stream's staged
 * checkpoint if the throw lands on the terminal STATE commit instead of a
 * mid-run batch. Retrying it is safe for the same idempotency reason
 * {@link isRetryableIngestStatus} is retried: ingest is an upsert on
 * `(connector_instance_id, stream, record_key)`, and the STATE PUT overwrites
 * the same cursor row every time.
 */
export function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }
  const { cause } = error as { cause?: unknown };
  const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "EPIPE" ||
    code === "UND_ERR_SOCKET"
  );
}

/**
 * Parse a `Retry-After` header value into milliseconds.
 *
 * Accepts both RFC 9110 forms: delta-seconds, and an HTTP-date (converted to a
 * delay relative to `nowMs`). Returns null when the header is absent, blank, or
 * unparseable — the caller then falls back to computed backoff rather than
 * treating an unreadable hint as "retry immediately". A past date or a negative
 * delta clamps to 0 rather than going negative.
 *
 * The owner-token ingest route does not currently send this header (it answers
 * through `rejectMutation`, which sets only the error envelope), so in practice
 * the backoff path is what runs today. It is honored anyway because the header
 * is the server's authoritative instruction whenever it IS present — from a
 * future server revision or an intermediary proxy — and because ignoring it
 * would let the client hammer a server that just told it exactly how long to
 * wait.
 */
export function parseIngestRetryAfterMs(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.ceil(seconds * 1000));
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) {
    return null;
  }
  return Math.max(0, dateMs - nowMs);
}

/**
 * How long to wait before attempt N+1.
 *
 * Precedence matches the device path: an explicit server `Retry-After` wins and
 * is clamped to `maxRetryAfterMs` (so a large or hostile value cannot stall the
 * run past the policy's budget); otherwise a jittered exponential backoff
 * bounded by `maxDelayMs`.
 *
 * Jitter is multiplicative in [0.5, 1.5) — full-width around the nominal delay
 * rather than only downward — so that several runs whose batches collided on
 * the same saturated gate do not all retry in the same instant and re-collide.
 * `random` is injected so tests get a deterministic schedule without sleeping.
 */
export function nextIngestRetryDelayMs({
  attempt,
  policy,
  random = Math.random,
  retryAfterMs,
}: {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  policy: IngestRetryPolicy;
  random?: () => number;
  retryAfterMs: number | null;
}): number {
  if (retryAfterMs !== null) {
    return Math.max(0, Math.min(policy.maxRetryAfterMs, retryAfterMs));
  }
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exponential * (0.5 + random()));
  return Math.max(0, Math.min(policy.maxDelayMs, jittered));
}
