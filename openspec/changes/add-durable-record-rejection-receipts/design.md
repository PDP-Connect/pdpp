## Context

See `proposal.md` for motivation. The confirmed defect spans the hosted connector runtime and the resource server:

- `runtime/index.ts` accepts any balanced `2xx` `{records_accepted, records_rejected}` envelope, increments `totalFlushed` by the submitted batch length, clears the batch, and later stages and commits connector state.
- `server/records.ts` correctly defaults unknown write errors to systemic failure, but its allowlisted permanent per-record failure becomes only a response count and bounded error. The failed record transaction rolls back and no durable recovery identity remains.
- Accepted records commit independently, so a batch may have durable prefix effects before a later record fails. Retry therefore must be idempotent and must not assume batch atomicity.
- SQLite and PostgreSQL are both supported. PDPP runs on heterogeneous hosts, so the contract cannot depend on one host's filesystem, service manager, or external queue.

The local device-exporter path is materially different. It durably owns an outbox and checkpoint and currently treats any rejected item as a retryable batch failure. This change must not silently widen that protocol.

## Goals / Non-Goals

**Goals:**

- Close the hosted cursor-advance data-loss hole with server-committed recovery evidence.
- Preserve per-record isolation: one invalid record does not force valid siblings to be discarded.
- Make exact request replay safe after response loss or process restart.
- Keep rejected personal data owner-bound, bounded, and inspectable through a read-only interface.
- Give implementation agents deterministic SQLite and optional-PostgreSQL oracles without requiring browser testing.

**Non-Goals:**

- Changing the Collection Profile wire protocol or connector output messages.
- Adding partial-rejection semantics to device-exporter ingestion.
- Automatically editing malformed payloads, silently discarding them, or declaring them accepted.
- Building a general dead-letter platform or a cross-service queue.
- Retrying, editing, resolving, or discarding quarantine entries. Those mutations require a separate change after receipt durability is proven.
- Encrypting quarantine data differently from other owner records in the same configured storage backend. Storage-at-rest hardening is a separate deployment concern.

## Decisions

### D1. Store a recoverable quarantine payload, not a hash-only receipt

The canonical ingest operation owns an ordered array of exact non-empty NDJSON line byte slices before it strictly decodes valid records and passes only objects to the host batch optimization. It must preserve `{inputIndex, rawLineBytes, parsedRecord?}` until every line has a terminal outcome. `inputIndex` is zero-based in that non-empty-line sequence; blank lines do not consume indexes.

For each permanent line failure, the server retains that exact bounded byte slice, its SHA-256 digest, typed reason, admitted binding, and pending metadata. This includes strict UTF-8 failure with reason `invalid_utf8`, JSON parse failure after lossless UTF-8 decode with reason `malformed_ndjson`, and the storage classifier's narrow permanent allowlist. A digest, counter, or timeline event alone cannot reconstruct a source item after its cursor moves.

The payload stays in the same owner storage boundary as records. List, timeline, log, and health projections expose metadata only. The owner must make a separate authorized detail request to retrieve the payload.

Alternatives rejected:

- **Fail the whole run forever:** avoids data loss but lets one deterministic poison item permanently block every later item.
- **Store only a digest/error:** proves something failed but cannot recover the data.
- **Write rejected payloads to logs or a host directory:** breaks owner binding, portability, retention, and transactional durability.

### D2. Use a persisted opaque receipt plus a server-derived replay key

The store assigns a cryptographically random, non-enumerable opaque receipt id and enforces a unique replay key over:

`storage owner namespace + connector_instance_id + stream + SHA-256(exact input bytes) + reason_code + rejection_generation`

`rejection_generation` is a versioned server constant tied to the classifier and retained-input format. The byte-native follow-up uses `record-rejection-v2` because invalid UTF-8 classification and reason-bound replay identity changed the proof semantics. It prevents a future classifier migration from accidentally treating an old receipt as proof under incompatible semantics. The receipt also records `connector_id`, `run_id` when supplied, first and latest input indexes, first/last seen timestamps, and a bounded replay count, but those fields do not change replay identity. Replay does not emit one durable audit event per retry; the bounded replay fact is the receipt row's `replay_count`, `latest_input_index`, and `last_seen_at`.

The receipt id is not a row id, timestamp, digest prefix, or sequence. The server recomputes the digest and replay key; callers do not choose either. An exact replay returns the existing receipt. Equivalent JSON with different bytes may produce another receipt; this is safe and keeps v1 independent of a new canonical-JSON dependency. The applicable owner quota bounds duplicates.

Alternative rejected: a caller-supplied idempotency key would require the runtime to durably preserve batch ids across crashes before this change can be safe.

### D3. A successful ingest response carries a complete per-input rejection vector

The additive response shape is:

```json
{
  "records_attempted": 2,
  "records_accepted": 1,
  "records_rejected": 1,
  "rejections": [
    {
      "input_index": 1,
      "receipt_id": "rr_...",
      "code": "invalid_record_identity"
    }
  ]
}
```

On `2xx`, the server and runtime both enforce:

- attempted equals the number of non-empty NDJSON lines and, for the connector runtime, its serialized `RECORD` batch size;
- attempted equals accepted plus rejected;
- `rejections.length` equals rejected;
- every rejection index is a unique integer inside the batch; duplicate exact lines may use the same receipt id at different indexes;
- accepted inputs have no rejection entry.

The additive rejection vector does not repeat payloads or underlying exception messages. Older runtimes ignore the additive fields, but the new server still prevents loss by persisting quarantine first. A new runtime connected to an old server fails closed because the complete receipt vector is absent.

### D4. Persist the rejection after the record transaction rolls back and before acknowledgement

`executeRecordsIngest` retains the raw line/index mapping and receives one narrow host dependency:

`insertOrReplayRejection({rawLineBytes, inputIndex, connectorId, connectorInstanceId, stream, runId, reasonCode})`

The route adapter supplies it only after manifest visibility and one exact owner connection namespace are admitted. Connector-only addressing must be resolved before `executeRecordsIngest`; accepted records and rejection receipts must use that same admitted instance. A malformed or invalid-UTF-8 line calls the dependency directly. For a parsed line, the normal record write keeps its existing transaction; if that write returns an allowlisted permanent error, the record transaction must be fully rolled back before the operation calls the dependency. The batch capability must preserve the typed reason code as well as `retryable`; message text is not classification authority.

The dependency opens a short quarantine transaction. Inside that same transaction it re-checks connection writable status and, when `runId` is present, the exact run/connection running fence used by record ingest. It then performs concurrency-safe quota admission and insert-or-replay before returning the receipt. SQLite acquires its write transaction before quota read/update; PostgreSQL locks or conditionally updates the applicable quota owner. Cancellation, revocation, deletion, or terminalization that wins before this transaction's checks causes a retryable failure, never a receipt.

If quarantine persistence fails, the request returns a typed retryable non-2xx failure. A crash after quarantine commit but before response is safe: exact replay returns the existing receipt. Unknown/systemic record errors retain the current non-2xx behavior and never enter quarantine.

This design does not claim whole-batch atomicity. Already accepted sibling records and already committed rejection receipts may survive a later systemic batch failure; re-ingestion is safe because accepted identical records are existing no-ops and rejected inputs replay their receipts.

### D5. First tranche exposes read-only owner inspection

The owner reference surface is scoped below one connection:

- `GET /_ref/connections/{connection_id}/record-rejections`
- `GET /_ref/connections/{connection_id}/record-rejections/{receipt_id}`

Both routes require the existing owner session and resolve the connection before receipt lookup so they do not disclose cross-owner existence. The list uses a configured maximum page size and an opaque cursor over stable logical ordering fields; it returns metadata only. The detail route returns `payload_base64`, `payload_encoding: "base64"`, and a nullable `payload_text` preview only when strict UTF-8 decoding is lossless. List and detail responses use `Cache-Control: private, no-store`. Because this tranche adds no cookie-backed mutations, it adds no new CSRF exception or JSON-POST ambiguity.

Retry, discard, payload replacement, and resolution state transitions are deferred. Their follow-up design must use narrow backend-local record transaction seams so record acceptance and receipt resolution cannot crash apart; it must not add a generic unit-of-work abstraction. Read-only retrieval is enough to prove that cursor advancement did not make the rejected source input irrecoverable.

### D6. Enforce durable quota admission and no automatic expiry for pending payloads

The table tracks pending payload bytes and pending receipt count. A configured per-owner payload-byte limit, per-owner receipt-count limit, and per-connection receipt-count fair-share limit are checked inside the fenced quarantine transaction with the backend serialization described in D4. If a new pending payload cannot be admitted, the ingest request fails retryably and the runtime cannot stage later state. Exact receipt replay does not consume quota again and updates bounded replay metadata instead of appending unbounded audit rows.

Pending payloads do not expire automatically because source replay may be impossible after cursor commit. Owner recovery/disposition for a quota-exhausted connection is deletion of the owning connection in this tranche, which removes all associated quarantine rows and releases byte/count quota inside the existing source-of-truth deletion transaction, or through an `ON DELETE CASCADE` proven active on both backends. Retry, discard, replacement, and status resolution remain explicit follow-up mutations after shared transaction/outbox integration. The migration defines conservative default quotas and exposes deployment configuration without assuming this development host's capacity. Owner metadata exposes a near-limit signal derived from active quota policy.

### D7. Project quarantine into honest accounting and server observability

Runtime counters use these meanings:

- `records_emitted`: valid connector `RECORD` messages observed;
- `records_attempted`: connector `RECORD` messages submitted toward the destination in this run, counted by run-local input ordinal rather than payload identity;
- `records_accepted`: records confirmed accepted by successful ingest responses;
- `records_permanently_rejected`: records backed by durable receipt entries in successful responses;
- `records_unresolved_retryable`: attempted records without a confirmed accepted or receipt-backed outcome when the run terminates.

At a terminal boundary, emitted/attempted differences and attempted outcome totals remain explicit. A network failure can make a durable server outcome epistemically unknown to the runtime; the runtime conservatively reports it unresolved until a replay obtains a successful complete response. It does not guess from transport failure.

`run.batch_ingested`, terminal spine events, and run history use these names and omit payloads. The legacy `records_flushed` and `total_records_flushed` fields, if retained for shape compatibility, count confirmed accepted records only; they never include receipt-backed rejections. Server-side quarantine audit facts use a fixed allowlist of receipt id, connection id, stream, typed reason, payload byte count and digest, timestamps, and actor; they exclude payload bytes and parser/storage exception text. Replay evidence is coalesced in the receipt row instead of one event per retry. The read-only owner route remains authoritative even while an older runtime emits legacy accounting.

### D8. Keep the first implementation tranche hosted and reference-only

The durable-rejection store and invariants are reusable, but device-exporter ingestion does not consume them in this change. The shared record operation must require an explicit hosted-rejection mode selected only after the ordinary hosted route has admitted an owner and connection; a device reservation must refuse that mode. Manual-upload and source-webhook callers retain their current behavior unless they explicitly adopt the same complete receipt response contract. The device path continues to fail/retry the poisoned batch and block its checkpoint. A later change may add typed device outcomes only after defining collector outbox acknowledgement and checkpoint parity.

This boundary prevents an apparently shared abstraction from hiding two different progress owners. It also gives the hosted P1 a bounded landing path.

## Risks / Trade-offs

- **[Rejected payloads are sensitive owner data]** → Keep them in owner-bound storage, exclude them from list/timeline/log output, use explicit detail authorization, cascade connection deletion, and include them in storage accounting.
- **[Pending poison records can consume quota indefinitely]** → Bound bytes durably; fail closed at quota; expose pending items through owner inspection instead of expiring data silently.
- **[Byte-derived replay permits semantically equivalent duplicates]** → Accept this bounded v2 trade-off; exact replay is deterministic and avoids a cross-language canonicalizer. Measure duplicates before adding canonical JSON.
- **[Mixed server/runtime versions]** → Deploy schema and server first. New server plus old runtime is loss-safe because quarantine commits before the old response; new runtime plus old server fails closed on missing receipts.
- **[Rollback can reintroduce silent loss]** → Runtime rollback is safe while the new server remains. Do not roll the server below receipt persistence while hosted runs are enabled; retain the additive table through rollback.
- **[Read-only recovery is incomplete product UX]** → Land the data-preservation invariant first; require a separate reviewed change for atomic retry/discard and operator workflow rather than braiding it into the P1 fix.
- **[A growing permanent-error allowlist can misclassify outages]** → Keep the allowlist explicit, code-based, and independently tested; unknown errors always remain systemic.
- **[First/latest occurrence provenance is still compact]** → This tranche keeps one `run_id` plus latest index/time and does not add first/latest run ids or an occurrence table. Production release remains blocked until a follow-up names `first_run_id`/`latest_run_id` semantics or adds bounded occurrence facts.
- **[Retained-size projection does not yet include quarantine rows]** → Quarantine byte/count quota is authoritative inside `record_rejection_quota`, and owner rejection list/detail expose payload bytes. The owner retained-size projection must include rejection payload bytes/count before production release or the PR description must keep this as a release blocker.
- **[Pending receipts can become stale after later acceptance]** → This tranche preserves recovery evidence and does not auto-resolve `pending` after later accepted writes. Retry/discard/resolve/status transitions remain deferred to the owner-disposition change after shared transaction/outbox integration.
- **[Large single-line requests are still bounded in memory, not streamed]** → The transport keeps the hosted request limit and per-line limit, but byte slicing still operates on the buffered request body. Production release must either lower/prove the configured 200 MiB boundary on constrained hosts or replace it with streaming line handling.
- **[#108 backup inventory must be refreshed after schema changes]** → The byte-native `record_rejections.payload` and `record_rejection_quota.pending_receipt_count` schema changes require the schema-derived backup inventory to be rerun before transplant/landing. Until that evidence exists, backup/restore remains a release blocker.

## Migration Plan

1. Add the SQLite and PostgreSQL quarantine table, indexes, byte and count accounting, byte-native `BLOB`/`BYTEA` payload storage, and connection-delete cascade. A server that already ran the first #123 draft migrates `payload_text` to byte-native payload storage losslessly for the UTF-8 text rows that draft could store, backfills pending payload bytes and receipt counts, and transactionally rekeys only rows not already stamped with `record-rejection-v2`. The migration preserves receipt ids and digests, rolls back as one backend transaction on failure, and performs no row rewrites on a second clean restart. Past pre-#123 rejected payloads remain unreconstructable and receive no fabricated receipts.
2. Add the store and fault-injection oracles, including exact replay, malformed lines, quota, admission fencing, rollback, restart, concurrency, and cross-owner cases.
3. Make hosted ingest preserve raw line/index pairs, persist malformed and allowlisted storage failures, and return the additive complete receipt vector. Keep current clients compatible.
4. Deploy the server/schema before the runtime. Exercise a real invalid-identity batch on each configured backend and verify the receipt survives server restart.
5. Update the runtime to require and validate complete rejection vectors, rename accounting, and gate state staging.
6. Add the bounded read-only owner list/detail surface and connection-delete integration before calling the change complete.

Rollback the runtime independently if needed. Keep the new server and schema in place. If the server must be rolled back, disable hosted connector runs first; otherwise the original cursor-advance defect returns.
