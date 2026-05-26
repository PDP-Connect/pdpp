## 1. Policy Helper

- [x] 1.1 Add `reference-implementation/scripts/compact-record-history.mjs` with a `COMPACTION_POLICIES` registry keyed by `(connector_id, stream)`, declaring the per-stream fingerprint definition (full record_json or excluded-keys-list) for the five initial policies.
- [x] 1.2 Implement `recordFingerprint(recordJson, excludeKeys)` using stable-stringify + SHA-1, mirroring the connector-side `recordFingerprint` / `buildThreadFingerprint` / `payeeLocationFingerprint` definitions so a "redundant" classification here matches the connector's "no-op" classification.
- [x] 1.3 Document fidelity: each registered policy entry references the connector source file it mirrors.

## 2. Retention Selector

- [x] 2.1 Implement `selectRemovableVersions(rowsAscByVersion, currentVersion, policy)` returning the set of versions whose `record_changes` rows are safe to remove under the rules in design.md §Retention rule. Pure function; no DB.
- [x] 2.2 Cover: first version always retained, current version always retained, tombstones always retained and serve as boundaries, the version immediately preceding the current with a different fingerprint always retained, adjacent same-fingerprint non-tombstone runs collapse to their first member.

## 3. Compaction Script

- [x] 3.1 CLI argument parsing: `--connector-instance-id`, `--stream`, optional `--connector-id`, `--limit-keys`, `--apply`. Reject invalid `--limit-keys` with a non-zero exit.
- [x] 3.2 Dry-run path: for each in-scope key, load all `record_changes` rows for that key, compute the retention selector output, and print one summary row per `(connector_instance_id, stream)` with: `scannedKeys`, `scannedVersions`, `removableVersions`, `retainedVersionsAfter`, and `estimatedRemovedBytes` summed from `octet_length(record_json::text)` on the rows it would remove.
- [x] 3.3 Apply path (only when `--apply` is passed):
  - 3.3.1 Generate `runId`.
  - 3.3.2 Create `compact_record_history_backup_<runId>` with the `record_changes` column shape plus a `compacted_at TIMESTAMPTZ NOT NULL DEFAULT now()` column.
  - 3.3.3 Open one transaction per `(connector_instance_id, stream)` scope.
  - 3.3.4 Inside the transaction: `INSERT INTO …_backup_<runId> SELECT … FROM record_changes WHERE …` for the removable versions; `DELETE FROM record_changes WHERE …`. Assert insert and delete row counts match.
  - 3.3.5 Commit; call `markRetainedSizeStreamDirty({ connectorInstanceId, stream })` post-commit.
- [x] 3.4 The script SHALL refuse to `--apply` if `PDPP_DATABASE_URL` / `PDPP_TEST_POSTGRES_URL` is unset.
- [x] 3.5 The script SHALL refuse any `(connector_id, stream)` not in `COMPACTION_POLICIES`.

## 4. Tests

- [x] 4.1 Pure-helper tests in `reference-implementation/test/compact-record-history.test.js`:
  - 4.1.1 `recordFingerprint` is stable across key order; excluded keys are dropped before hashing.
  - 4.1.2 `selectRemovableVersions` honours every retention rule from §2.2 across a hand-built scenario per stream class (no tombstone, with tombstone, all-same-fingerprint, all-different-fingerprint, single-version edge case).
  - 4.1.3 `parseLimitKeys` rejects non-positive integers.
  - 4.1.4 `COMPACTION_POLICIES` exposes only the five registered policies.
- [x] 4.2 Postgres-backed test (gated on `PDPP_TEST_POSTGRES_URL`):
  - 4.2.1 Seed a `(connector_instance_id='cin_compact_<suffix>', stream='workspace')` with the shape from design.md acceptance: six versions whose only differences are `fetched_at` (the live workspace churn shape). Verify dry-run reports `removableVersions=4`.
  - 4.2.2 Apply: verify exactly four `record_changes` rows are removed, exactly four rows now exist in the backup table, the current `records` row is byte-identical to before, `version_counter.max_version` is unchanged, the surviving `record_changes` rows are byte-identical to their pre-apply values, and the `retained_size_stream` projection dirty bit is set.
  - 4.2.3 No-op safety: seed a stream where every version has a different fingerprint; verify dry-run reports `removableVersions=0` and `--apply` removes zero rows.
  - 4.2.4 Tombstone safety: seed a sequence first, same, tombstone, same, current; verify the tombstone bounds the compaction (the "same" before the tombstone is removable only by reference to the first, never crossing the tombstone).
  - 4.2.5 Unknown-stream safety: invoke with `--stream=messages` against a registered connector; verify the script exits non-zero before touching the database.

## 5. Validation

- [x] 5.1 `openspec validate compact-retained-record-history --strict`.
- [x] 5.2 `openspec validate --all --strict`.
- [x] 5.3 Run the pure-helper tests (`node --test reference-implementation/test/compact-record-history.test.js`).
- [x] 5.4 Run the Postgres-backed tests with `PDPP_TEST_POSTGRES_URL` set if a Postgres proof service is available locally; otherwise note skip.
- [x] 5.5 `git diff --check`.
- [x] 5.6 grep readback: every policy stream name in design.md, the script, and the tests is spelled identically (`threads`, `workspace`, `users`, `files`, `payee_locations`).

## Acceptance Checks

- Dry-run against a `(connector_instance_id, stream)` whose history is known-redundant reports a non-zero `removableVersions` count and changes nothing in the database.
- `--apply` removes only versions classified removable by the retention selector, atomically populates the backup table with the same row set, leaves the current `records` row payload unchanged, leaves `version_counter.max_version` unchanged, and marks the retained-size projection dirty so the next rebuild corrects accounting.
- The script refuses to operate on any stream without a registered policy and refuses to `--apply` without database access.
- A subsequent connector run after compaction allocates the next version monotonically (no collisions with surviving versions).
