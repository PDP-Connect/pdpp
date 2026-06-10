# Record Version Semantics Prior Art

Status: captured
Owner: reference implementation owner
Created: 2026-05-26
Updated: 2026-05-26
Related: design-notes/record-version-churn-and-noop-semantics-2026-05-26.md, openspec/changes/repair-record-version-noop-detection, openspec/changes/harden-record-version-allocation-atomicity, tmp/workstreams/record-version-semantics-prior-art-report.md

## Question

What general record-version semantics should the reference implementation use so personal-data history is trustworthy without adding low-value machinery?

## Findings

The prior-art pattern is consistent:

- Sync systems advance state only after destination-confirmed progress. Airbyte describes checkpointing as valid when the destination echoes state meaning it has committed records up to that point. Meltano/Singer-style state tracks per-stream bookmarks and acknowledges at-least-once delivery rather than exactly-once delivery.
- Log-compacted systems keep the latest value per key while treating compaction as a retention policy, not as the source event history itself. Kafka/Confluent documentation frames compaction as retaining at least the last update per primary key and using null payloads as deletes.
- Idempotent mutation APIs prevent duplicate effects from retries by recording the first result for an idempotency key and comparing repeat parameters. Stripe's API docs are the useful analogy: idempotency is a server-side construction boundary, not a post-hoc cleanup job.

These patterns support PDPP's existing split:

- PDPP Core should keep exposing snapshot-oriented record reads and `changes_since`; it should not standardize reference implementation history tables, content hashes, or compaction jobs.
- The Collection Profile should state the outcome expected from connectors: do not emit redundant records when a cheap source cursor/fingerprint can avoid it, and do not clear derived fields when an incremental run did not re-read the evidence required to recompute them.
- The reference implementation should define adapter-specific no-op equivalence against the stored form, keep `record_changes` append-only by default, and expose version/churn statistics so future regressions are visible without ad-hoc SQL.

## Current Verdict

The Codex incident did not justify a general "cursor versus retained record" reconciler. That would require the resource server to understand source-specific derived-field semantics it does not own. The better construction is:

- fix the connector bug when source evidence exists;
- keep the guarded repair tool for explicit, owner-run recovery of registered derived fields;
- add observability for version churn so the next incident is detected early;
- defer destructive historical compaction until an owner explicitly chooses retention cleanup with a backup and dry-run preview.

## Local Deployment Notes

The local Codex source-evidence gap was repairable because the rollout JSONL files still existed. The durable fix was connector-local: forked Codex rollout files can contain multiple `session_meta` lines, and the parser must keep the first/canonical child id rather than overwriting it with parent metadata. After the parser fix, replaying the affected rollout files regenerated child messages, function calls, and non-null session counts through the normal collector path.

Backup tables created before local replay:

- `backup_20260526_codex_source_replay_records`
- `backup_20260526_codex_source_replay_record_changes`
- `backup_20260526_codex_source_replay_connector_state`

## Sources

- Airbyte checkpointing: https://airbyte.com/blog/checkpointing
- Meltano Singer SDK stream state: https://sdk.meltano.com/en/v0.53.2/implementation/state.html
- Confluent Kafka log compaction: https://docs.confluent.io/kafka/design/log_compaction.html
- Stripe idempotent requests: https://docs.stripe.com/api/idempotent_requests

## Decision Log

- 2026-05-26: Captured after read-only Claude lane and owner verification. Current conclusion: add version/churn observability and possibly a small Collection Profile connector outcome requirement later; do not add content hashes, source-evidence fields, cross-connection dedupe, automatic compaction, or a general cursor-vs-record reconciler now.
