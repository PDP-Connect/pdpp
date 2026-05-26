## 1. Postgres No-Op Detection Fix

- [ ] 1.1 Add a regression test against the Postgres-backed conformance harness driver proving that two byte-identical `postgresIngestRecord` calls allocate at most one version.
- [ ] 1.2 Add an assertion in the same test that the `record_changes` table gains at most one row.
- [ ] 1.3 Change `postgres-records.js` no-op detection to fetch `record_json::text AS record_json_text` and compare it as a string against the inbound serialized payload.
- [ ] 1.4 Keep `record_json` available for the delete-history append path (or fetch both columns in one query so the existing `JSON.stringify(current.record_json)` write for `record_changes` delete rows continues to produce the expected jsonb payload).
- [ ] 1.5 Run the existing record-mutation conformance harness against both SQLite and Postgres drivers and confirm no other suites regress.

## 2. Spec Delta Alignment

- [ ] 2.1 Confirm the modified "No-op writes do not allocate" requirement reads naturally alongside the existing "Record version allocation SHALL be atomic with the durable mutation" requirement from `harden-record-version-allocation-atomicity`.
- [ ] 2.2 If `harden-record-version-allocation-atomicity` is still active (not archived), call out the dependency in the proposal so closeout sequences correctly.

## 3. Ingest Observability

- [ ] 3.1 Emit a structured `pdpp.ingest` log line per ingest call on both adapters with `outcome ∈ { changed, noop_byte_equivalent, noop_delete_absent }`, `connector_id`, `connector_instance_id`, `stream`, and a stable hash of `record_key`.
- [ ] 3.2 Add a focused test asserting the log line appears with the expected `outcome` value on a byte-identical re-ingest.

## 4. Repair Tool

- [ ] 4.1 Add `reference-implementation/scripts/repair/record-derived-field-backfill.mjs` (or `.ts`) gated on owner-token auth and explicit connector/stream/key scope.
- [ ] 4.2 Implement a `--dry-run` flag (default on) that prints the rows that would change, the prior version each refill would be sourced from, and the fields it would refill. The tool SHALL refuse to execute mutations without `--apply`.
- [ ] 4.3 Implement a connector-registered "repair policy" interface so new streams opt in via code review. Land the Codex `sessions` policy (refill `message_count` and `function_call_count` from the most recent byte-equivalent history row with non-null values).
- [ ] 4.4 The repair SHALL allocate a new version through the existing atomic allocator and append one `record_changes` row per repaired record. It SHALL NOT mutate or delete any existing `record_changes` row.
- [ ] 4.5 Unit-test the repair policy against a fixture postgres database (or in-memory shim) covering: current row null + prior non-null, current row non-null (skip), no prior history (skip), and cross-key isolation.
- [ ] 4.6 Run the repair tool in dry-run mode against the live local Postgres for the Codex `peregrine Codex` connection (`cin_ece4bfe5096b8bf67a1468c2`) and capture the preview output. Confirm session `019d922d-c38b-7e11-ae99-9187af386148` appears with source version `175854`.

## 5. Validation

- [ ] 5.1 Run the record-mutation conformance harness for both SQLite and Postgres drivers.
- [ ] 5.2 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [ ] 5.3 Run `pnpm --filter pdpp-reference-implementation check`.
- [ ] 5.4 Run `openspec validate repair-record-version-noop-detection --strict`.
- [ ] 5.5 Run `openspec validate --all --strict`.

## Acceptance Checks

- The Postgres no-op regression test fails on the unfixed code and passes after the fix.
- A dry-run repair against the local Postgres lists Codex session `019d922d-c38b-7e11-ae99-9187af386148` as repairable with source version `175854`.
- Structured ingest log line emits `outcome=noop_byte_equivalent` on a second byte-identical ingest.
- No public API response shape changes.
