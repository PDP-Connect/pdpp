## 1. Records helper

- [x] 1.1 Add `deleteAllRecordsForConnector(connectorId)` to `reference-implementation/server/records.js` that deletes from `records`, `record_changes`, `version_counter`, and `blob_bindings` for that connector, and tears down lexical and semantic indexes per affected stream.
- [x] 1.2 Return the number of records deleted plus the list of streams it touched, so the reconciliation log line is informative.

## 2. Reconciliation wiring

- [x] 2.1 In `reference-implementation/server/polyfill-manifest-reconcile.ts`, load the on-disk reference-fixture manifests' `(version, sorted-stream-names)` fingerprints (configurable via `opts.referenceFixturesDir`).
- [x] 2.2 When the persisted manifest differs from the shipped manifest, gate record invalidation on the predicate "persisted fingerprint matches the reference-fixture fingerprint AND shipped fingerprint differs from it". On the gated branch, call the new invalidation helper before re-registering. On every other branch, re-register without touching records.
- [x] 2.3 Log the invalidation result per connector when the gated branch fires.
- [x] 2.4 Keep the existing first-time-registration skip (early-continue when `persisted` is null).

## 3. Tests

- [x] 3.1 Add `reference-implementation/test/polyfill-manifest-reconcile-invalidation.test.js` covering:
    - Seed-fake records are deleted on the reference-fixture → polyfill fingerprint transition.
    - Owner records survive a `semantic_fields`-only manifest update.
    - Owner records survive a `display_name`/description-only manifest update.
    - Owner records survive a polyfill version bump with the same stream set.
    - Owner records survive evolution of a polyfill-only connector that has no reference-fixture collision.
    - Records persist when the persisted manifest already matches the shipped polyfill manifest (no fingerprint change → no invalidation).
    - Direct `registerConnector` re-registration does not delete records.
    - First-time registration is skipped without invalidation.

## 4. Validation

- [x] 4.1 Run `openspec validate reconcile-invalidates-stale-records --strict`.
- [x] 4.2 Run `openspec validate --all --strict`.
- [x] 4.3 Run `node --test reference-implementation/test/polyfill-manifest-reconcile-invalidation.test.js`.
- [x] 4.4 Run the existing reconcile/manifest tests to confirm no regression.
- [x] 4.5 Run `pnpm --dir reference-implementation verify`.
