# Preserve current-history anchors during record-history pruning

## Why

Live evidence found a current/history projection-integrity failure across
multiple connections: the current `records` projection silently lost keys whose
authoritative `record_changes` history still said they existed. Chase
`transactions` was the first symptom (1,145 latest non-deleted keys in history,
15 current rows). A harder evidence-first scan later found more repairable
drift: `usaa/transactions` (859 missing_current), `reddit/submitted` and
`github/issues` (1 stale_current each), all repaired live by the owner. After
repair, exact scans still show residue that retained history can no longer
prove: `reddit/submitted` 36 and `github/issues` 66 `unresolved_pruned` rows.

The recurrence question pointed at history pruning. Both SQLite and Postgres
prune `record_changes` with a pure per-stream **version cutoff**
(`version <= nextVersion - PDPP_CHANGE_HISTORY_LIMIT`). A current `records` row
at version `V` is projected from the `record_changes` row at the same
`(connector_instance_id, stream, record_key, version)`. A cutoff deletes that
anchor whenever **other** keys advance the per-stream version past
`V + limit` — stranding the unchanged current row of a cold key as
`unresolved_pruned`. The existing single-key pruning test could never catch
this: with one key, the per-stream version always equals that key's latest
version, so the cutoff never reaches the anchor. The bug requires at least two
keys — one cold, one hot. This was reproduced deterministically.

SLVP-ideal pruning must stay bounded but must never delete the retained history
row that anchors a still-current `records` row.

The forward fix prevents *new* stranding, but it cannot reconstruct the residue
already stranded before it deploys (the live `reddit/submitted` 36 /
`github/issues` 66 `unresolved_pruned` rows), nor residue left by a non-atomic
bulk delete. The authoritative source can: when a connector resyncs and re-sends
the byte-identical payload of an unanchored current row, ingest has everything it
needs to re-anchor it. So this change pairs the forward fix with a recovery fix —
ingest self-heals an unanchored current row on an otherwise-no-op reingest —
without weakening the anti-churn no-op suppression for the normal anchored case.

## What Changes

- **Anchor-preserving prune (forward fix), both backends.** The
  `record_changes` history prune SHALL NOT delete the row whose
  `(connector_instance_id, stream, record_key, version)` equals a current
  `records` row's `(…, version)` for that key. Implemented as a `NOT EXISTS`
  guard added to the prune DELETE in SQLite
  (`queries/records/ingest/prune-record-changes.sql`) and Postgres
  (`postgres-records.js`). The retained-size delta accounting (pruned row/byte
  counts) carries the **identical** guard so the read model still matches the
  rows actually removed. Bounded pruning is preserved for hot keys: only the
  one anchor row per live key is exempt; all older history and all history of
  keys whose current row has since advanced still prune.
- **Self-heal of unanchored current rows on unchanged reingest (recovery fix),
  both backends.** When ingest would suppress a write as a no-op (incoming
  payload byte-identical to the current live state) but no `record_changes` row
  anchors the current row at its `version`, ingest SHALL re-anchor the current
  row by allocating a new head-of-window per-stream version and appending a fresh
  `record_changes` row, instead of returning a plain no-op. The new version
  (not the stranded one) keeps the re-anchor durable against the next prune.
  Implemented symmetrically in SQLite (`records.js`, gated by a new anchor-probe
  query) and Postgres (`postgres-records.js`). An identical reingest of a still
  anchored row stays a true no-op — the anti-churn no-op suppression (the Slack
  `workspace` 31k-version regression guard) is preserved. The success envelope
  surfaces an additive `self_healed: true` for operator/test observability.
- **Multi-key recurrence guard tests.** The current-projection recurrence guard
  suite gains tests that fail against version-cutoff pruning and pass with
  anchor preservation, covering at least one cold unchanged current row plus a
  hot row that advances the stream past the limit, a deleted cold anchor (no
  resurrection), and a many-cold-keys-one-hot-key shape; plus self-heal tests
  that strand an anchor directly (raw delete, not via prune) and assert an
  unchanged reingest re-anchors at a new version, that an anchored reingest stays
  a no-op, and that a full source resync converges a multi-key stranded
  projection to zero drift.
- **All-stream, payload-free drift scanner (read-only operator tool).** A new
  `scripts/repair/record-current-projection-scan-all.mjs` audits the current
  projection against retained history across every `(connector_instance_id,
  stream)` in Postgres at once, never writing and never printing payloads. It
  reports a finer remediation taxonomy than the per-scope repair tool:
  `missing_current`, `stale_current`, `latest_deleted`,
  `current_no_retained_history`,
  `current_version_newer_than_retained_history`,
  `current_payload_matches_latest_history_but_version_differs`, and
  `unverified_current_payload_differs_from_latest_history` — each with a
  remediation disposition.
- **Remediation policy (design only, no live apply).** The design records what
  is safely repairable from latest retained history, what is a safe
  current-version correction (payload byte-equals latest retained history), and
  what requires source resync or an explicit owner-gated synthetic maintenance
  anchor. No synthetic anchor is written by code in this change.

No new HTTP route, schedule, or automatic job. No change to public record
reads, public `changes_since` responses, grant enforcement, or the
`PDPP_CHANGE_HISTORY_LIMIT` retention bound itself. Live data mutation of the
existing `unresolved_pruned` residue is deferred and owner-gated.

## Capabilities

- Modified: reference-implementation-architecture

## Impact

- `reference-implementation/server/queries/records/ingest/prune-record-changes.sql`
  — anchor-preserving `NOT EXISTS` guard on the prune DELETE.
- `reference-implementation/server/records.js` — `PRUNE_ANCHOR_PRESERVE_CLAUSE`
  applied to the pruned-bytes and pruned-count helpers so delta accounting
  matches the DELETE; SQLite `ingestRecord` gates the unchanged-upsert no-op on
  anchor presence and falls through to the changed-write path to self-heal.
- `reference-implementation/server/postgres-records.js` — identical
  `NOT EXISTS` guard on the Postgres prune SELECT (count/bytes) and DELETE;
  symmetric anchor-probe self-heal in `postgresIngestRecord`.
- `reference-implementation/server/queries/records/ingest/get-record-change-anchor.sql`
  — new anchor-presence probe (does a `record_changes` row exist for
  `(cin, stream, key)` at the current row's exact `version`?).
- `reference-implementation/server/queries/records/ingest/get-current-record-state.sql`
  — adds `version` to the current-state read so ingest can probe the anchor.
- `reference-implementation/server/queries/index.ts` — registers
  `recordsIngestGetRecordChangeAnchor`.
- `reference-implementation/test/current-projection-recurrence-guard.test.js`
  — multi-key anchor-preservation tests (falsifiable against the old cutoff)
  plus self-heal / anti-churn-no-op / full-resync-convergence tests.
- `reference-implementation/test/postgres-records-ingest-noop.test.js`
  — env-gated Postgres self-heal test (unanchored reingest re-anchors at a new
  version, then stays a no-op once anchored).
- `reference-implementation/scripts/repair/record-current-projection-scan-all.mjs`
  — new read-only all-stream payload-free scanner + remediation dispositions.
- `reference-implementation/test/record-current-projection-scan-all.test.js`
  — pure-classifier unit tests for all seven drift classes.
- `openspec/specs/reference-implementation-architecture/spec.md` — via this
  change's deltas.
