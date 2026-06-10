## Context

Two manifest sources collide on the same `connector_id`:

- `reference-implementation/manifests/<id>.json` — fixture manifests, served by the deterministic seed connector at `reference-implementation/connectors/seed/index.js`.
- `packages/polyfill-connectors/manifests/<id>.json` — shipped polyfill manifests, served by the real polyfill at `packages/polyfill-connectors/connectors/<id>/`.

The seed connector emits records keyed under fixture identities (`spotify:artist:0L8ExT028jH3ddEcZwqJJ5` "Taylor Swift", `seedowner/personal-site`, etc.). The polyfill connector emits records keyed under whatever the real source returned.

`reconcilePolyfillManifests` runs at server boot. It only touches connectors whose persisted manifest is structurally different from the shipped polyfill manifest, and it calls `registerConnector(shipped)`. `registerConnector` updates the manifest row and rebuilds search indexes — but it never touches the `records` table. So a database that was seeded by `pdpp seed` (which writes the *reference fixture* manifest, then emits seed records) will, after the very next reference restart, end up advertising the polyfill manifest while still serving seed-fake records.

## Decisions

### Decision 1: Conservative invalidation, narrowly gated by fingerprint

We chose to **delete** records for the affected connector, but only when reconciliation observes the specific reference-fixture → polyfill fingerprint transition. Generic structural diffs (which fire on description tweaks, semantic_fields additions, polyfill v0.1.0 → v0.2.0, etc.) re-register the manifest and preserve records.

Rationale:

- The audit failure mode is `pdpp seed` writing the reference-fixture manifest and emitting fixture-keyed records, followed by a server restart that flips the persisted manifest to the polyfill shape. That transition is identifiable because the persisted manifest's `(version, sorted-stream-names)` fingerprint matches the on-disk reference-fixture manifest's fingerprint. We gate invalidation on this match.
- The opposite failure mode — wiping real owner data on every manifest fix — is just as unacceptable. Real polyfill evolution is common (semantic_fields rollout, view additions, range_filter declarations, schema additions, copy revisions). Any one of those trips a structural diff but NOT the fingerprint transition, so records are preserved.
- The fingerprint comparison is the same one the controller's `resolveDefaultConnectorPath` already uses to decide between seed vs polyfill execution paths (see `reference-implementation/runtime/controller.ts`). Reusing the predicate keeps the system's two "is this the seed-flow shape?" decisions aligned.
- Records emitted under a fixture-shape manifest already have unknown safety against the polyfill manifest's schema declarations (different streams, different lexical/semantic field sets, possibly different keys). Dropping them on the seed flip avoids a layering violation; preserving them on ordinary evolution is safe because the records were emitted by the same polyfill connector that authored the new manifest version.

Alternatives considered:

- **Invalidate on any fingerprint change.** This was the first cut and was rejected during owner review: it would wipe real owner data on common manifest fixes (semantic_fields, descriptions, polyfill version bumps with the same stream set).
- **Stamp records with `manifest_fingerprint` and filter on read.** More elegant, more invasive. Touches every read path (records, lexical, semantic, blob, dataset summary, change history). Higher risk that a leaky read path accidentally exposes a stale record. Defer; can be added later as a soft warning surface without conflicting with the deletion-first contract.
- **Mark records with a `seed=true` flag at ingest time.** Requires a schema column and write-path changes in the runtime ingest pipeline plus the seed connector. The fingerprint-gated approach achieves the same outcome with one read-side predicate at boot, no schema migration, and no per-record write overhead. Worth revisiting if seed/non-seed coexistence ever becomes a steady-state requirement.
- **Refuse reconciliation when records exist.** Brittle. The polyfill manifests are the deployed source of truth; refusing to update them just means demos and integrations stay stuck with stale schemas.

### Decision 2: Fingerprint loaded from `reference-implementation/manifests/`

The reconcile module reads fixture fingerprints from `reference-implementation/manifests/` at boot, mirroring the controller's existing pattern. The directory is configurable via `opts.referenceFixturesDir` for tests; the production default resolves relative to this file. If the dir is missing or empty, the fingerprint map is empty and the transition predicate returns false for every connector — i.e. no invalidation, conservatively defaulting to record preservation.

### Decision 3: Implementation lives in `records.js`, not in `auth.js`

`registerConnector` is called from many code paths (HTTP `POST /connectors`, tests, manual reseeds). We intentionally do not invalidate records inside `registerConnector` — re-registering the same manifest from a CLI must remain a no-op for existing data. The invalidation is the reconciliation loop's responsibility, because only the reconciliation loop has the fixture-fingerprint context to know the diff is the seed flip rather than ordinary evolution.

## Acceptance checks

1. Polyfill manifest reconciliation that observes the reference-fixture → polyfill fingerprint transition deletes all records previously persisted under that `connector_id`, including `record_changes`, `version_counter`, blob bindings, and lexical/semantic indexes.
2. Polyfill manifest reconciliation that finds the manifest already up to date (structurally equal) does **not** delete records.
3. Polyfill manifest reconciliation that observes a structural diff which is NOT the fixture transition (description-only, semantic_fields-only, polyfill version bump with the same stream set, polyfill-only connector with no fixture collision) re-registers and **preserves** records.
4. First-time registration via the reconciliation loop is unreachable (the loop returns early when `persisted` is null), so no records are deleted on initial registration.
5. Direct `registerConnector` calls (HTTP `POST /connectors`, CLI re-registration) do **not** delete records.
6. Reconciliation logs an explicit `invalidated <connector_id>: <count> record(s)` line per affected connector when the narrow transition fires.

## Open questions

- Should the operator-facing dashboard surface a "stale records were invalidated on last boot" banner? Probably yes, but that is a UI follow-up (Finding #2 in the audit) and lives outside this change's scope.
- Long-term, a record-level `seed=true` flag (or `manifest_fingerprint` stamp) would let mixed seed-and-real datasets coexist with read-time filtering. Not required to ship the trust fix today.
