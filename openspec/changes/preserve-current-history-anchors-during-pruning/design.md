# Design: Preserve current-history anchors during pruning

## Problem statement

`record_changes.version` is unique per `(connector_instance_id, stream)`.
`records.version` is the stream version of the mutation that last wrote the
current row. Normal ingest appends exactly one `record_changes` row per current
mutation, then prunes older history by `PDPP_CHANGE_HISTORY_LIMIT`.

Both backends prune with a pure per-stream version cutoff:

```sql
DELETE FROM record_changes
 WHERE connector_instance_id = ? AND stream = ?
   AND version <= ?            -- nextVersion - PDPP_CHANGE_HISTORY_LIMIT
```

The cutoff is computed from the per-stream `nextVersion`, which advances on
**every** key's mutation. A cold key written once at version `V` and never
touched again keeps its current `records` row at `V`; its sole anchor is the
`record_changes` row at `V`. Once hot keys push `nextVersion` past
`V + limit`, the cutoff `nextVersion - limit >= V`, and the cutoff deletes the
cold key's anchor. The current row at `V` is now `unresolved_pruned` —
authoritative history can no longer prove it.

### Deterministic reproduction

```
PDPP_CHANGE_HISTORY_LIMIT=2
upsert(cold, v1)             # cold.records.version = 1, anchor at v1
for v in 1..8: upsert(hot)   # nextVersion reaches 9
# cutoff = 9 - 2 = 7 >= 1  → old prune deletes cold@1 (its anchor)
# detectCurrentProjectionDrift → cold is unresolved_pruned
```

The pre-existing single-key pruning test cannot catch this: with one key the
per-stream version always equals that key's latest version, so
`version <= nextVersion - limit` never reaches the current anchor.

## Fix: anchor preservation

Exempt exactly the anchor row — the `record_changes` row whose
`(connector_instance_id, stream, record_key, version)` matches a current
`records` row's `(…, version)`:

```sql
DELETE FROM record_changes rc
 WHERE rc.connector_instance_id = ? AND rc.stream = ? AND rc.version <= ?
   AND NOT EXISTS (
     SELECT 1 FROM records r
      WHERE r.connector_instance_id = rc.connector_instance_id
        AND r.stream = rc.stream
        AND r.record_key = rc.record_key
        AND r.version = rc.version
   )
```

### Why this is correct and minimal

- A live current row at version `V` exempts exactly its anchor at `V`; older
  history for that key still prunes.
- A deleted current row (tombstone at `V`) exempts its deleted anchor at `V`,
  keeping the `(deleted latest, deleted current)` consistent classification —
  no resurrection, no orphan.
- A key with no current row (fully gone) exempts nothing; all its history is
  prunable.
- The just-written key's current row is at `nextVersion`, far above the cutoff;
  its older versions below the cutoff are not anchors and still prune. Bounded
  pruning for hot keys is preserved — measured: a hot key keeps exactly `limit`
  rows; a cold key keeps exactly its 1 anchor; total history stays bounded at
  `(#live keys) + (bounded hot tail)`, not the full version log.

### Retained-size accounting must match the DELETE

The pruned row/byte counts feeding the dataset-summary and retained-size
read-model deltas are computed with the **same predicate** as the DELETE. If
they diverged, the read model would over-report pruned bytes/rows for keys whose
anchor we now keep. The SQLite helpers (`getPrunedRecordChangeCount`,
`getPrunedRecordChangeJsonBytes`) share a single `PRUNE_ANCHOR_PRESERVE_CLAUSE`
constant with the prune SQL; the Postgres count/bytes SELECT and the DELETE
carry the identical `NOT EXISTS` clause. Order is preserved: the current
`records` row is upserted/marked before the count and the DELETE, so all three
observe the same `records` state within the write transaction.

### Interaction with `changes_since` cursor expiry

Cursor expiry uses `MIN(version)` over retained `record_changes` for the stream
(`get-min-record-change-version.sql`). Retaining cold anchors below the old
cutoff keeps `MIN(version)` lower, so **fewer** cursors expire. This is strictly
safer, not less correct: a `changes_since` delta reads
`version > after AND version <= max` grouped by key taking `MAX(version)`. Cold
anchors at `version <= after` are excluded by `version > after`, and any key
whose latest change is `> after` always has that latest version retained as its
anchor. The delta therefore stays complete; the only effect is that a client can
resume from an older point we now actually have the history to honor. The
single-key cursor-expiry integration test is unaffected (verified green).

## All-stream payload-free scanner

`record-current-projection-repair.mjs` is per-`(cin, stream)` and collapses
"current outran retained history" into `unresolved_pruned` and version/payload
disagreement into `stale_current`. Remediation needs a finer split, because the
**safe action differs**. The new read-only scanner classifies, across all
streams in one pass:

| class | meaning | remediation disposition |
|---|---|---|
| `missing_current` | latest retained history non-deleted, no usable current row | repairable from latest retained history (repair tool, no new version) |
| `stale_current` | live current behind a newer retained version (same-version payload disagreement, or older live current) | repairable from latest retained history |
| `latest_deleted` | latest retained history is a tombstone, live current survives | owner-gated delete reconciliation (`--apply-deletes`) |
| `current_payload_matches_latest_history_but_version_differs` | live current `version != latest`, but payload byte-equals latest retained history | **safe current-version correction** — align `records.version`; no resync |
| `unverified_current_payload_differs_from_latest_history` | live current `version != latest`, payload differs | source resync (re-run connector); never a blind version stomp |
| `current_version_newer_than_retained_history` | current strictly newer than every retained row (anchor pruned) | source resync **or** owner-gated synthetic maintenance anchor |
| `current_no_retained_history` | current row, zero retained history (torn bulk delete / fully pruned) | source resync **or** owner-gated synthetic maintenance anchor |

Output discipline: only versions, deleted flags, byte counts, payload-equality
booleans, and truncated identifiers — never raw payloads (`record_json IS NOT
DISTINCT FROM` is computed in SQL). Exit code 1 when any drift is found so an
operator/CI can branch on "needs remediation".

The anchor-preserving prune makes the `current_*_history` classes structurally
impossible to **create** going forward; the scanner finds and dispositions the
pre-fix residue and proves, post-deploy, that the residue is bounded.

## Remediation plan for existing `unresolved_pruned` residue

Three disposition tiers, none auto-applied by this change:

1. **Repairable from latest retained history** (`missing_current`,
   `stale_current`). The per-scope repair tool already does this safely
   (`--apply`, no new version). For the live residue, the owner runs the
   existing repair tool per affected `(cin, stream)`.
2. **Safe current-version correction**
   (`current_payload_matches_latest_history_but_version_differs`). The current
   payload provably equals the latest retained history row; only the version
   label disagrees. Aligning `records.version` to the latest retained history
   version is safe (no payload change). This is a candidate for a future
   owner-gated `--apply` path in the scanner; **not implemented here** because
   it mutates live versions and must be owner-reviewed against real data.
3. **Source resync or owner-gated synthetic anchor**
   (`current_version_newer_than_retained_history`,
   `current_no_retained_history`,
   `unverified_current_payload_differs_from_latest_history`). Retained history
   cannot prove the current row. The correct fix is to re-run the connector so
   the source re-establishes the authoritative row. If resync is impossible
   (source no longer holds the record), the only alternative is an explicit,
   owner-gated **synthetic maintenance anchor**: write a new `record_changes`
   row through the atomic allocator that re-anchors the *current* payload at a
   fresh version, with an audit marker. This is design-only and owner-gated;
   the worker does not synthesize anchors in code. The `reddit/submitted` (36)
   and `github/issues` (66) residue falls here pending the owner's scan.

## Alternatives considered

- **Stop pruning entirely.** Rejected: unbounded history growth is the problem
  retained-size churn work exists to bound.
- **Prune by per-key recency instead of stream version.** More invasive (needs
  a per-key retained-count query per prune) and unnecessary: the anchor
  exemption already guarantees the current projection, and the stream-version
  cutoff still bounds the per-key tail for hot keys.
- **Repair-only (no prune change).** Rejected: repair without the prune fix
  leaves the bug live; the projection would re-drift on the next cold-key
  pruning cycle. The prune fix makes integrity a construction, not a cleanup.

## Acceptance checks

- A multi-key cold/hot test fails against the version-cutoff prune and passes
  with anchor preservation (proven: the 3 new tests fail on a reverted SQL).
- Bounded pruning preserved: hot key retains exactly `limit` rows; cold key
  retains exactly 1 anchor; many-cold-one-hot total history bounded.
- Retained-size pruning-boundary test and dataset-summary deltas stay green.
- `changes_since` cursor-expiry integration test stays green.
- Scanner classifies all seven classes (unit + real-Postgres end-to-end).
