# Design

## Problem

Local-device inventory streams append a redundant version of the same metadata
record on every run. `claude-code/backup_inventory` (VPR 24) and `codex/history`
(VPR 5) are the visible cases, but the cause is structural and shared by every
`inventory_only`/`defer` store: `buildLocalSourceInventory` /
`listDirectoryInventory` emit a record with a stable id
(`${store}:${path_hash}`) carrying `mtime_epoch` and `size_bytes`, and those two
file-stat fields move whenever a normal tool write touches the underlying file
or directory. No connector-side fingerprint cursor and no compaction policy
existed for these streams.

## Why these two keys, and only these two

The `local-agent-collector-completeness` spec defines an inventory record as a
completeness-coverage artifact: *this store exists, here is its path, type,
classification, reason.* That is its meaningful version transition. `mtime_epoch`
and `size_bytes` are not part of that meaning — they are incidental stat output.
For a directory store (`backup_inventory`) `size_bytes` is always `null`, so the
churn is entirely `mtime_epoch`. Excluding exactly these two keys is lossless:
any inventory transition (store appear/disappear, file↔directory, path-hash
move, classification/reason change) still yields a distinct fingerprint and a
retained version boundary. The freshness signal the mtime accidentally encodes
is already carried by the sibling `coverage_diagnostics` stream and the
per-stream STATE `fetched_at`.

This is the same construction the API/browser connectors already use to stop
run-clock churn (`excludeFromFingerprint: ["fetched_at"]`); the local-device
inventory path had simply never been gated. The fix reuses the existing
`openFingerprintCursor` primitive rather than inventing a new mechanism — the
new `openInventoryFingerprintCursor` is a thin, named specialization so both
connectors and the compaction policy share one exclude-key definition.

## Construction: gate the shared emit boundary, not the two symptoms

Both connectors emit inventory records through a single `emitLocalInventoryStreams`
function over `inventory.recordsByStream` plus a directory-listing path. The gate
is applied at that boundary (`emitGatedInventoryStream`) so every inventory
stream is fixed by construction — `cache_inventory`, `config_inventory`,
`file_history`, `session_index`, `shell_snapshots`, `logs` would otherwise churn
the same way as soon as their stores are touched. This is the "good construction
before feature lists" bar: fix the class, not the two rows currently visible.

## Codex STATE-clobber subtlety

Codex's `emitStateCursors` wrote a trailing bare `{ fetched_at }` STATE for every
requested inventory stream, including absent ones. Because it ran after the
inventory emit, that bare write clobbered the fingerprint map the gate had just
persisted — which would silently re-open the churn on the next run (the gate
would see no prior fingerprints). The fix makes the gate the sole STATE writer
for the streams in `CODEX_GATED_INVENTORY_STREAMS` and removes them from
`emitStateCursors`; `coverage_diagnostics` (not gated) keeps its point-in-time
STATE. Claude Code never wrote inventory STATE, so it had no clobber. A
regression test (run-1 STATE carries `fingerprints`; run-2 does not re-emit)
locks this.

## Full-scan prune

Inventory enumeration walks the full known-store set under the source home every
run, so the cursors `pruneStale()` before serializing STATE: a store that
disappears drops out and re-emits exactly once when it returns. This matches the
full-scan prune already used for `usaa/inbox_messages` / `chase/accounts`.

## Compaction policy: a third family

The existing registry has two families: "connector fingerprint mirror"
(`excludeKeys` mirrors a connector `fetched_at`-style exclude) and "exact
stable-JSON identity" (local-device record bodies with no volatile field,
`excludeKeys: []`). Inventory records fit neither cleanly — they DO carry
volatile fields, so exact-JSON would over-classify (never collapse), and they
are local-device rather than API/browser. The new "inventory churn gate" family
(`excludeKeys: ["mtime_epoch", "size_bytes"]`) mirrors the new connector cursor
one-for-one, asserted by the fingerprint-parity test.

## Scope and non-goals

- No real source field is excluded from any fingerprint.
- No new HTTP route, scheduler, or background job.
- No change to the compaction retention rule, backup/apply safety, dry-run
  default, or any public read path.
- Live `--apply` (clearing the retained redundant `backup_inventory`/`history`
  versions on the deployed instance) is owner-gated and deferred; this change is
  the forward fix + policy registration so no new churn accumulates.

## Overlapping-delta note

This change MODIFIES the same reference-implementation-architecture
compaction-tool requirement as several in-flight churn changes
(`register-current-churn-compaction-policies`,
`extend-run-clock-churn-gates-remaining-streams`,
`extend-usaa-real-field-churn-incidental-gates`,
`extend-chase-run-clock-churn-gates`). Each grows the policy enumeration
monotonically. This delta restates the requirement adding the third policy
family on top of the canonical two-family body; it does not attempt to also fold
the sibling changes' Family-1 additions. The owner folds the union once at
archive time.

## Alternatives considered

- **Treat mtime/size churn as a real freshness time-series and leave it.**
  Rejected: the spec frames inventory records as coverage, not freshness;
  `coverage_diagnostics` already carries existence/status; and for a directory
  store there is no size signal at all, so the "series" is a per-run clock tick.
- **Gate only `backup_inventory` and `history` (the two visible rows).**
  Rejected: special-casing two streams in a shared code path leaves the same
  latent churn on every sibling inventory stream and violates the
  fix-the-class principle.
- **Exact-JSON identity compaction policy (`excludeKeys: []`).** Rejected: the
  inventory body is not byte-identical across runs (mtime/size move), so an
  exact-JSON policy would never collapse the churn.

## Residual Risks

- **Owner-only live `--apply` (deferred).** Carried into archive per the
  AGENTS.md archive rule. The forward inventory gate + the third-family
  compaction policy are landed and proven offline, so no new churn accumulates.
  The retained pre-gate residue on the deployed instance — `claude-code/backup_inventory`
  and `codex/history` redundant history — is cleared by the owner via live
  `--apply` (or the live `main` release lane) with the per-run
  `compact_record_history_backup_<runId>` table as the rollback handle. This is
  residue cleanup, not a correctness gate — the fingerprint-parity test pins
  `removable == connector no-op`.
- **Cross-change reconciliation (resolved at this archive).** The
  "Overlapping-delta note" above stated this delta restates the requirement with
  only the third policy family on the canonical two-family body and that "the
  owner folds the union once at archive time." That fold was performed: the
  canonical `reference-implementation-architecture` requirement now carries the
  union of all five churn-family deltas — three policy families, the full
  Family-1 enumeration from the sibling changes, the partial-scan paragraph, this
  change's full-scan inventory paragraph, and every scenario set. This change's
  standalone `local-agent-collector-completeness` delta (no sibling collision)
  was applied as-is. No residual reconciliation remains.
