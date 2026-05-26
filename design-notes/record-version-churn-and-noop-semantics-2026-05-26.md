# Record Version Churn And No-Op Semantics

Status: captured
Owner: reference implementation owner
Created: 2026-05-26
Updated: 2026-05-26
Related: openspec/changes/add-record-mutation-conformance-harness, openspec/changes/harden-record-version-allocation-atomicity, openspec/changes/add-dashboard-summary-read-model, design-notes/retained-size-and-data-explorer-substrate-2026-05-22.md, tmp/workstreams/codex-growth-investigation-report.md

## Question

How should the reference implementation distinguish meaningful source changes from redundant connector emissions so record history stays trustworthy without unbounded storage churn?

## Context

The Codex local collector exposed a concrete bug class: `state_5.sqlite` changed frequently, causing every thread session to be re-emitted even when the thread's source facts had not changed. Some re-emissions also regressed derived counts to `null` when the current run had not re-parsed the underlying rollout JSONL. A forward fix added per-thread fingerprints so unchanged sessions are skipped and prior counts are preserved, but it does not repair already-regressed current rows or compact historical churn.

Current Postgres ingest suppresses exact identical current-record upserts, but that only catches byte-equivalent records after normalization. It does not define semantic no-ops, protect against volatile fields, prevent lossy derived-field toggles, or explain which historical versions are meaningful to users.

Live retained-history evidence shows this is broader than one Codex stream. High versions-per-record exist in mutable metadata streams such as Slack `workspace` and `users`, Gmail `threads` and `labels`, YNAB metadata streams, Codex `sessions`, `messages`, and `function_calls`, and some local Claude Code streams. Some churn may be legitimate source mutation; some may be redundant snapshot emission; the contract is not explicit enough to tell.

## Stakes

- Storage and dashboard retained-size growth can become misleading or expensive.
- Record history can imply changes that did not happen at the source.
- Query, search, aggregation, and future data-explorer UX inherit noisy historical facts.
- Connector-specific patches can mask the same design gap in other connectors.
- Over-aggressive deduplication can lose real source history, especially for mutable remote objects.

## Current Leaning

Use layered defenses rather than one global hack:

- Connectors should avoid emitting unchanged records when they can cheaply maintain source-level cursors or fingerprints.
- The runtime should continue suppressing exact current-record no-ops and should make version/no-op decisions observable.
- Connector records should exclude volatile collection-time fields from durable record identity unless those fields are source facts.
- Derived summary records should preserve prior stable values when an incremental run has not re-read the underlying evidence.
- Historical compaction/backfill should be an explicit operator/admin tool with connector-specific safety rules, not an automatic retention side effect.
- Cross-connection dedupe remains opt-in and rule-driven. `(connection_id, stream, record_id)` is the canonical identity unless an approved cross-instance identity rule says otherwise.

## Promotion Trigger

Promote this into OpenSpec before changing ingest/version allocation semantics, adding content-hash or semantic no-op contracts, changing retained-size/read-model accounting, adding history compaction, or requiring connector telemetry for emitted/skipped/changed counts.

## Decision Log

- 2026-05-26: Captured after Codex churn investigation and live Postgres evidence showed high versions-per-record across several mutable connector streams. A spot check of Codex session `019d922d-c38b-7e11-ae99-9187af386148` still showed `message_count` and `function_call_count` as `null` in the current row, confirming that forward cursor fixes are not sufficient as data repair.
