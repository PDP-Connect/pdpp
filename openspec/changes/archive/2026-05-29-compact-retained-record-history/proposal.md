## Why

Connector-local fingerprint cursors (`a08d7a0a`, `47ec8edd`) stopped active churn at the connector boundary for Gmail `threads`, Slack `workspace`/`users`/`files`, and YNAB `payee_locations`. Forward emissions are now no-op-suppressed. The five streams still carry large amounts of *historical* redundant `record_changes` rows from the bug window — Gmail `threads` is the headline at ~3.16M historical versions across ~12k keys, Slack `workspace` at ~31k versions for 1 key, Slack `users` at ~73k for 292 keys, YNAB `payee_locations` at ~21k for 77 keys (per the churn data-quality report dated 2026-05-26).

Those historical versions are not source mutations — for each affected stream, the connector now has a versioned semantic fingerprint policy that defines what "the record actually changed" means. Adjacent historical versions with the same fingerprint are provably redundant under that same policy. Compacting them does not change the current `records` row payload, does not change `version_counter`, does not change what a grant-scoped read returns for any key, and does not destroy any version-boundary that the policy considers meaningful.

The 2026-05-26 record-version-semantics prior-art note explicitly deferred this work until "an owner explicitly chooses retention cleanup with backup and dry-run preview." This change is that workstream, scoped narrowly to the streams whose connectors already ship a fingerprint policy. It is deny-by-default elsewhere.

## What Changes

- Add a reference-implementation-local, owner/operator-only operational tool that compacts provably-redundant adjacent historical `record_changes` versions for a registered set of `(connector_id, stream)` policy pairs.
- Define a per-stream compaction policy by re-using the same semantic fingerprint definition the connector uses to suppress no-op emits. The five initial policies cover Gmail `threads`, Slack `workspace` (with `fetched_at` excluded), Slack `users`, Slack `files`, and YNAB `payee_locations`.
- The tool SHALL default to dry-run, SHALL require an explicit `--apply` flag for mutation, and SHALL refuse to `--apply` without first materialising a per-run Postgres backup table named `compact_record_history_backup_<runId>` containing every row it intends to delete, inside the same transaction as the delete.
- The tool SHALL NOT mutate or delete any `records` (current) row, SHALL NOT touch `version_counter`, SHALL NOT cross `(connector_instance_id, stream, record_key)` boundaries, SHALL preserve the current row's version, SHALL preserve the most recent prior version whose fingerprint differs from the current, and SHALL preserve every tombstone (`deleted = TRUE`) row.
- The tool SHALL mark each touched `(connector_instance_id, stream)` retained-size projection dirty after a successful apply so the existing rebuild path corrects retained-size accounting on the next pass.
- The tool SHALL refuse any stream that does not have a registered policy. Registering a new policy is a code-review gate.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- New script: `reference-implementation/scripts/compact-record-history.mjs`.
- New tests: `reference-implementation/test/compact-record-history.test.js` (pure helpers and Postgres-backed apply path, gated on `PDPP_TEST_POSTGRES_URL`).
- No protocol surface change. No public HTTP route. No change to `/v1/records`, `/v1/records/changes_since`, or `/_ref/` shapes.
- No new schema migration. The backup table is created per-run inside the apply transaction and is the operator's rollback handle.
- Out of scope: compacting streams without a fingerprint policy (Codex, ChatGPT messages, Slack messages/reactions, Linear messages, Gmail messages/labels, etc.); deleting tombstones; cross-record-key dedupe; cross-connection dedupe; rewriting existing `record_changes` rows; changing `version_counter`; touching the current `records` row payload; an HTTP-fronted compactor; an automatic background job; a retention policy framework.
