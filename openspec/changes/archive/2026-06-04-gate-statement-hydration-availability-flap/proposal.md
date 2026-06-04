# Gate the statement hydration-availability flap (chase + usaa)

## Why

`chase/statements` and `usaa/statements` re-version an immutable statement whenever
PDF hydration availability flips, not when any real data changes.

A statement's identity (`id`, `account_id`, `title`, `date_delivered`) is immutable
and its hydrated fields (`document_url`, `pdf_path`, `pdf_sha256`) are
content-addressed — the path embeds the sha256, and the bytes at that path never
move. The intended steady state is ~1 version per statement. But when a run that
previously hydrated a statement later fails to re-download its PDF, both connectors
fall back to an all-null index-only body, so the three hydrated fields flap
`value -> null` (and back to `value` on a later successful run).

Each flap is a real fingerprint boundary. Both streams gate on a per-statement
fingerprint cursor with `excludeFromFingerprint: ["fetched_at"]`, so the cursor
correctly collapses a true no-op refresh — but it deliberately does NOT collapse a
`value <-> null` change on the hydrated fields, because to the fingerprint that is a
real body change. The already-shipped `extend-chase-run-clock-churn-gates` change
makes this explicit and intentional: a "newly-hydrated `pdf_path`/`pdf_sha256`/
`document_url`" SHALL remain a fingerprint boundary that is never collapsed. The
existing `fetched_at`-only compaction policy is therefore contractually forbidden
from removing the flap, and SHOULD be — the value↔null oscillation is not run-clock
churn. It is a record body that asserts "this statement has no PDF" on a run that
merely failed to re-fetch a PDF that still exists.

The fix belongs at the connector emit layer, not the compaction layer: on a
hydration failure for a statement that was previously hydrated, carry the prior
hydrated pointers forward instead of emitting null. This keeps the steady state at
~1 version, preserves the legitimate `null -> value` first-hydration version, and
keeps the per-run `SKIP_RESULT` honest about the failed download.

This carry-forward is **not a new runtime primitive**. The polyfill connector
authoring layer already specifies a per-record fingerprint cursor that carries
skipped records forward and "exposes the prior fingerprint value so a connector
with derived-field-preservation policy can read it." Codex already ships exactly
this derived-field-preservation construction over `openCarryForwardCursor<T>`: when
a run does not re-parse a session's rollout file, it pulls the prior
`message_count`/`function_call_count` forward rather than clobbering them with null.
The statement flap is the same pattern over `{pdf_path, pdf_sha256, document_url}`.

It changes a durable, tested record-body retention invariant across two connectors
(the all-null index-only fallback is pinned by `chase/integration.test.ts` and
`usaa/integration.test.ts`), so it is a contract change, not a local fix.

## What Changes

- The connector statement-record body contract gains a carry-forward rule:
  on a hydration failure for a previously-hydrated statement, the connector SHALL
  re-emit the prior `document_url`/`pdf_path`/`pdf_sha256` rather than null. A
  statement never hydrated stays index-only (all three null) — `null -> value` is a
  real first hydration and SHALL still version exactly once. The per-run
  `SKIP_RESULT` for the failed download is unchanged.
- The carry-forward source is the existing per-statement STATE cursor, extended from
  a hash-only fingerprint map to also retain the prior hydrated pointers keyed by
  statement `id`. No new stream, no new manifest field, no public RECORD/STATE wire
  change (the map lives inside the connector's opaque STATE cursor).
- The tested all-null index-only fallback invariant is replaced by the stronger,
  explicit carry-forward invariant. The index-only-when-never-hydrated case
  (all-null) is preserved as a distinct, still-tested branch.
- The `fetched_at`-only compaction policies for `chase/statements` and
  `usaa/statements` are unchanged: carry-forward removes the flap at the source, so
  the compaction layer never has to (and still must not) collapse a real
  `null -> value` first hydration.

## Capabilities

### Modified

- `reference-implementation-architecture` — the polyfill connector statement-record
  body contract (carry-forward of prior hydrated pointers on hydration failure) and
  the per-record fingerprint cursor primitive's derived-field-preservation surface.

### Added

- none

### Removed

- The all-null index-only fallback as the *sole* statement-failure body contract.
  It is not deleted outright: it is narrowed to the never-hydrated case and replaced
  for the previously-hydrated case by the carry-forward invariant (see the spec
  delta's REMOVED + MODIFIED requirements).

## Impact

- Connectors: `packages/polyfill-connectors/connectors/chase/index.ts`
  (`processStatementRow`, `emitStatementIndexOnly`, `readPriorStatementFingerprints`,
  statements STATE cursor) and
  `packages/polyfill-connectors/connectors/usaa/index.ts`
  (`emitStatementRecords`, `readPriorStatementFingerprints`, statements STATE cursor).
- Shared runtime: `packages/polyfill-connectors/src/fingerprint-cursor.ts` — the
  carry-forward of prior hydrated pointers reuses `openCarryForwardCursor<T>` /
  the prior-value surface; whether the statements cursor moves to a structured
  fingerprint type or keeps a hash cursor plus a sibling prior-body map is a design
  choice recorded in `design.md`. No public wire change either way.
- Tests: the pinned all-null fallback assertions in `chase/integration.test.ts`
  ("Invariant 4") and `usaa/integration.test.ts` ("failed hydration emits index-only
  record") are updated to the carry-forward contract; new fingerprint tests pin the
  six acceptance cases.
- Compaction tool / policies: unchanged. No `--apply` behavior change.
- PDPP Core, public record reads, `changes_since`, and grant enforcement: unaffected.
