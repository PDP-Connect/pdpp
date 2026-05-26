## 1. Postgres No-Op Detection Fix

- [x] 1.1 Add a regression test against the Postgres-backed conformance harness driver proving that two byte-identical `postgresIngestRecord` calls allocate at most one version.
- [x] 1.2 Add an assertion in the same test that the `record_changes` table gains at most one row.
- [x] 1.3 Change `postgres-records.js` no-op detection to compare incoming payload to the stored `record_json` using jsonb structural equality (`$::jsonb IS NOT DISTINCT FROM record_json`) evaluated server-side. This is structural at the `jsonb` level and is independent of `node-postgres`' key-order quirks and Postgres' `::text` whitespace.
- [x] 1.4 Keep `record_json` available for the delete-history append path. The existing `JSON.stringify(current.record_json)` write for `record_changes` delete rows continues to produce the expected jsonb payload because the column is typed `jsonb`.
- [x] 1.5 Run the existing record-mutation conformance harness against both SQLite and Postgres drivers and confirm no other suites regress.

## 2. Spec Delta Alignment

- [x] 2.1 Confirm the modified "No-op writes do not allocate" requirement reads naturally alongside the existing "Record version allocation SHALL be atomic with the durable mutation" requirement from `harden-record-version-allocation-atomicity`.
- [x] 2.2 If `harden-record-version-allocation-atomicity` is still active (not archived), call out the dependency in the proposal so closeout sequences correctly.

## 3. Follow-on Observability (out of scope)

Structured `pdpp.ingest` telemetry with `outcome ∈ { changed, noop_byte_equivalent, noop_delete_absent }` was considered for this change and intentionally deferred. The bug fix in §1 and the repair tool in §4 close the existing damage. The `record_changes` table is itself adequate retrospective telemetry — versions-per-record over time will surface a regression in any future adapter. A separate change should propose the structured log if the operator console grows live regression detection, since wiring `records.js` and `postgres-records.js` through the request-scoped pino logger touches surfaces outside this fix. The design.md Observability section, the spec delta, and the acceptance checks have all been aligned to this descope — no SHALL remains.

## 4. Repair Tool

- [x] 4.1 Add `reference-implementation/scripts/repair/record-derived-field-backfill.mjs` gated on direct database access (`PDPP_DATABASE_URL`) and explicit connector/stream/key scope. (Authorization is by possession of the operator-only database URL, not an HTTP-fronted owner token; design.md spells this out and notes that an HTTP route would re-tighten to owner-token auth.)
- [x] 4.2 Implement a `--dry-run` default (off only when `--apply` is passed) that prints the rows that would change, the prior version each refill would be sourced from, and the fields it would refill. The tool SHALL refuse to execute mutations without `--apply`.
- [x] 4.3 Implement a connector-registered "repair policy" interface so new streams opt in via code review. Land the Codex `sessions` policy (refill `message_count` and `function_call_count`).
- [x] 4.4 The repair SHALL allocate a new version through the existing atomic allocator and append one `record_changes` row per repaired record. It SHALL NOT mutate or delete any existing `record_changes` row.
- [x] 4.5 Implement the equivalence guard: before treating a prior `record_changes` row as a refill source, the tool SHALL compare current and prior with every field in the policy's `derivedFields` removed from both sides using jsonb structural equality. If the normalised payloads are not equal, the prior row SHALL NOT be used even if it carries non-null derived fields. This prevents repair from running when some non-derived field has also changed between the prior and current row.
- [x] 4.6 Validate `--limit` if present: must be a positive integer; the tool SHALL refuse to run otherwise.
- [x] 4.7 Unit-test the repair logic against a fixture postgres database covering: current row null + jsonb-equivalent prior non-null (refill), current row non-null (skip), no non-null history (skip), cross-key isolation, and the equivalence-guard rejection case (prior with non-null derived fields but a different non-derived field).

## 5. Validation

- [x] 5.1 Run the record-mutation conformance harness for both SQLite (memory + sqlite drivers) and Postgres (gated on `PDPP_TEST_POSTGRES_URL`).
- [x] 5.2 Run `openspec validate repair-record-version-noop-detection --strict`.
- [x] 5.3 Run `openspec validate --all --strict`.
- [x] 5.4 Run the targeted Postgres no-op regression test (`reference-implementation/test/postgres-records-ingest-noop.test.js`) with `PDPP_TEST_POSTGRES_URL` set.
- [x] 5.5 Run the targeted repair-policy tests (`reference-implementation/test/record-derived-field-backfill.test.js`) with `PDPP_TEST_POSTGRES_URL` set.

## Acceptance Checks

- The Postgres no-op regression test fails on the unfixed code and passes after the fix.
- A dry-run repair against the local Postgres lists the recoverable Codex session rows for the targeted `(connector_instance_id, stream)` scope and reports a source `record_changes.version` for each.
- The repair tool refuses to use a prior `record_changes` row as a refill source when that prior row differs from the current row in any field outside the policy's `derivedFields`.
- The repair tool refuses to run on a stream without a registered policy and refuses a non-positive-integer `--limit`.
- No public API response shape changes.
