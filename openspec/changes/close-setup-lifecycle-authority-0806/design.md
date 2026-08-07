## Context

`run_history` is already the durable run-grain reader for owner summaries and
already carries the bounded `facts_json` payload written from terminal runtime
events. `collection_facts` is already the canonical per-stream evidence block:
`considered` is never inferred from `collected`, and a missing fact is not
complete. The setup route should use those primitives rather than maintaining a
second setup ledger.

## Decision

Use a shared pure classifier with three terminal dispositions:

- `verified_empty`: every required/in-scope stream has trusted
  `considered: 0`, no skip or pending detail gap, and a `committed` or `disabled`
  checkpoint;
- `unverified_zero`: terminal success has an observed zero count but the
  collection facts do not prove a valid empty result;
- `unverified_missing_counts`: terminal success has no observed yield count and
  no valid-empty collection facts.

The classifier receives the manifest stream set and the parsed facts. It never
derives proof from an aggregate count. Aggregate zero is only a discriminator
for the unverified case. Count presence is retained in the existing bounded
`facts_json` payload so a generalized run-history writer's schema default of
zero cannot turn a missing runtime field into evidence.

The setup route first checks the active-run table by connection. For terminal
evidence it uses exact connection-scoped run-history lookup when `run_id` is
provided; without `run_id` it reads the latest product run-history row for that
connection. It does not use the global spine terminal lookup for this projection.

The server summary adds the same disposition to each draft connection. The
console's existing shared source-actionability function owns the copy and CTA
for Dashboard, Sources, and Syncs. Drafts continue to route to the setup-status
page and remain excluded from active sync groups and scheduler enrollment.

## Alternatives rejected

- A setup-specific table or enum was rejected because it would create a second
  lifecycle authority and drift from run-history evidence.
- Treating `records_emitted === 0` as empty was rejected because it cannot
  distinguish a silent runtime from a connector that proved an empty account.
- A global `run_id` terminal lookup was rejected because run ids are legitimate
  duplicates across connection instances.
- Activating or scheduling a draft after a terminal zero was rejected because
  accepted records remain the existing activation boundary.

## Acceptance checks

- Setup status returns distinct state and disposition for verified-empty,
  unverified-zero, and missing-count terminal success.
- A duplicate run id cannot cross connection boundaries, and a no-query revisit
  resolves the durable latest result for the addressed connection.
- Dashboard, Sources, and Syncs share the same terminal disposition copy and
  CTA while the draft remains inactive and unscheduled.
- Focused tests plus OpenSpec strict validation pass.
