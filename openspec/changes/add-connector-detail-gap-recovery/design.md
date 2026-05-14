# Design: connector detail-gap recovery

## Context

Bounded-run cursor honesty is the right default: a failed or cancelled collection run must not durably advance a cursor past required data that may not have been collected. That rule prevented the current ChatGPT connector from reproducing the old connector's silent lossy success mode.

The operational problem is now narrower. ChatGPT list enumeration can discover a bounded tranche of conversations, but required conversation detail hydration can exhaust recoverable upstream pressure. After that happens, replaying the whole uncommitted tranche is wasteful and can keep hitting the same pressure bucket.

The old February ChatGPT connector likely succeeded because it tolerated detail failures and emitted placeholder conversations with `messages: []`. This change explicitly rejects that behavior. A missing required detail is only acceptable if it is recorded as a recoverable gap/backlog entry with enough targeting information for a later run to fetch the missing detail.

## Capability Placement

The spec delta modifies `reference-implementation-architecture` because this is a reference runtime and connector architecture decision:

- It changes bounded-run checkpoint behavior in the reference implementation.
- It depends on runtime-owned durable backlog storage and recovery scheduling.
- It needs `_ref` observability and owner diagnosis, but not a new public PDPP API.
- It is not yet Collection Profile normativity.

No existing `openspec/specs/` capability is a perfect connector-runtime home. `reference-implementation-architecture` is the narrowest existing capability that already covers collection boundary classification, checkpoint staging versus commit, `_ref` surfaces, and open design questions around run durability.

## Model

The reference implementation adds a durable detail-gap backlog for connector streams that collect by list-plus-detail:

1. The connector enumerates list items for a bounded cursor tranche.
2. The connector attempts required detail hydration for each listed item.
3. If detail hydration exhausts recoverable pressure for an item, the connector reports a recoverable detail gap instead of emitting a fake complete record.
4. Before advancing the list cursor, the connector emits a reference-only coverage attestation for the cursor boundary: which listed keys required detail, which keys were hydrated, which keys were explicitly optional/skipped, and which keys were recorded as pending detail recovery.
5. The runtime durably records any gap with source, stream, record key or safe upstream locator, list cursor boundary, reason, attempt metadata, and recovery status.
6. The run may succeed and commit list-level cursor progress only if the declared coverage has no uncovered required detail: every required key is hydrated, explicitly optional/skipped, or backed by a durable recoverable gap entry.
7. Future runs prioritize pending gap recovery before, or in the same run as, forward list collection.
8. When recovery succeeds, the runtime marks the gap recovered and the connector emits the real hydrated record.

The main cursor remains honest because it no longer means "all detail is present." It means "list enumeration is complete through this boundary and any required missing detail inside the boundary is durably represented as recoverable backlog."

The runtime cannot infer arbitrary source detail completeness from ordinary records alone. This tranche therefore enforces the invariant for connectors that opt into this reference-only list-plus-detail coverage contract. Connectors that do not emit coverage do not get the new successful-with-pending-detail cursor semantics.

## Data Shape

The implementation should use an internal reference-only durable representation. The exact table and event names can be finalized during implementation, but the shape needs these fields:

- `source`: canonical source object or equivalent internal source binding.
- `run_id`: run that discovered or last updated the gap.
- `stream`: affected stream.
- `key`: connector record key when known.
- `detail_locator`: safe connector-specific locator needed to retry detail hydration.
- `list_cursor`: cursor boundary or tranche marker that makes the gap's relationship to main cursor advancement auditable.
- `reason`: low-cardinality class such as `rate_limited`, `retry_exhausted`, `temporary_unavailable`, or `upstream_pressure`.
- `status`: `pending`, `in_progress`, `recovered`, `terminal`, or equivalent.
- `attempt_count`, `last_attempt_at`, `next_attempt_after`, and safe last-error metadata.

Sensitive upstream URLs, cookies, bearer tokens, request bodies, and raw private payloads must not be stored in the gap record. The locator must be enough for the connector to retry, not a dump of the failed request.

Coverage attestations are internal run messages, not durable public records. They should be small enough to audit the current cursor boundary and should contain only stable list/detail keys, not raw private payloads.

## Run Semantics

This change is not sub-run durable checkpointing in the broad sense. It does not create named durable run segments with independent success/failure states. It creates one explicit exception to all-detail-or-fail behavior for list-plus-detail connectors: list cursor progress may commit only when missing required detail is durably externalized as targeted backlog.

Required detail can end in four states for a cursor tranche:

- Hydrated and emitted as a real record.
- Recorded as a pending recoverable gap.
- Skipped only if the connector and stream semantics make that detail optional and the skip is explicit.
- Terminal failure, which fails the run and prevents cursor commit.

The runtime must reject or fail any run that tries to commit a cursor boundary while required detail is neither emitted nor represented by a durable pending gap.

That rejection is only mechanically enforceable for boundaries where the connector has declared the required-detail key set through the reference coverage signal. Without that declaration, the runtime cannot know which un-emitted detail items exist.

## Recovery Scheduling

Recovery should be connector-general but source-aware:

- A future run for the same source should load pending gaps relevant to the requested scope.
- Pending gaps should be attempted before forward collection when they are inside already-committed list cursor boundaries.
- Gap recovery should use the same adaptive lane, retry, pacing, and cancellation controls as normal detail hydration.
- Recovery success should emit the hydrated record and mark the gap recovered.
- Recovery exhaustion may leave the gap pending with updated attempt metadata and `next_attempt_after`.
- Permanent errors may mark a gap terminal only with explicit evidence, not just a transient pressure timeout.

ChatGPT is the pilot because its conversations stream has direct evidence: `run_1778776165021` hit pressure around `30/278` despite max concurrency `1` and adaptive lane cooldown visibility.

## Observability

The owner must be able to distinguish:

- Fully collected records.
- Pending recoverable detail gaps.
- Recovered detail gaps.
- Terminal unrecoverable gaps.

The first tranche may expose this through reference-only `_ref` timeline or summary surfaces. Those surfaces must be labeled reference-only. They should avoid raw upstream identifiers unless the connector supplies a safe label.

## Collection Profile Boundary

Reference-only in the first tranche:

- Durable gap storage.
- Gap recovery scheduling.
- `_ref` gap observability.
- ChatGPT pilot behavior.
- Internal connector messages or runtime APIs used to report gaps.
- Internal connector messages used to attest detail coverage for a list cursor boundary.

Not Collection Profile protocol yet:

- A standard wire message for detail gaps.
- A standard wire message for detail coverage.
- Normative meaning of committing a list cursor while detail backlog exists.
- A standard backlog schema for interoperable connectors.
- Owner-visible protocol fields for gap state.

This is a non-commitment boundary. The reference implementation may use internal `DETAIL_GAP` and detail-coverage signals to connect connector output to runtime backlog storage and commit validation, but those signals are not portable Collection Profile messages. Protocol readers must not infer that PDPP has standardized a gap schema, a coverage schema, a cursor meaning for incomplete detail hydration, or a cross-runtime recovery contract.

The durable abstraction should be evaluated as pending detail recovery work/backlog. "Detail gap" is useful diagnostic language for the missing-data condition, but it should not become the public primitive unless a later root protocol change proves that naming and contract are the right general model.

Potential future Collection Profile work:

- A connector `GAP` or `BACKLOG` message if multiple runtimes need to interoperate.
- Standard recovery guarantees for list-plus-detail streams.
- Standard owner disclosure of incomplete-but-recoverable collection state.

## Alternatives Considered

### Keep failing the whole run

This preserves the strongest cursor invariant but has become operationally expensive for ChatGPT. It repeats already-flushed work and can make a large source fail indefinitely on the same pressure point.

### Silently emit placeholder records

Rejected. Returning conversations with `messages: []` for failed detail hides missing required data as success and makes later recovery ambiguous.

### Broad sub-run checkpoints

Deferred. Named durable segments and partial-success checkpoints are a larger durability model. Detail-gap recovery solves the immediate list-plus-detail failure mode without defining general segment commits.

### Connector-local backlog only

Rejected for the reference. If the runtime commits the main cursor, the runtime must also own or validate the durable evidence that makes that commit honest.

## Acceptance Checks

- A ChatGPT-style fixture can list 278 conversations, exhaust recoverable detail pressure for one item, record a pending detail gap, and commit the list cursor without emitting a fake complete conversation.
- A later run can target the pending gap and recover the real detail without replaying the full 278-item list tranche.
- A run that attempts to commit list progress with missing required detail and no durable gap fails.
- Optional detail skips remain explicit and do not create required-detail backlog.
- `_ref` or equivalent reference observability reports pending and recovered gaps without leaking secret-bearing request data.
