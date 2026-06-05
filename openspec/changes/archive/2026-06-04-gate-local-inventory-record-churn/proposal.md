# Gate local-device inventory-record churn on incidental file-stat fields

## Why

The 2026-06-03 post-compaction churn ground-truth still shows two local-device
inventory streams appending a new version of the same metadata record on every
run:

- **claude-code / backup_inventory** — VPR 24 (current 1, history 24)
- **codex / history** — VPR 5 (current 1, history 5)

Both are `inventory_only` metadata records produced by
`buildLocalSourceInventory` / `listDirectoryInventory`. The record exists to
answer the local-agent-collector completeness contract: *this known store
exists, here is its path, type, privacy classification, and reason.* Its
meaningful version transition is a change in that inventory meaning — the store
appearing/disappearing, a file becoming a directory, a `path_hash` moving, or
the `classification`/`reason` changing.

The `mtime_epoch` and `size_bytes` fields are incidental file-stat metadata.
Every normal tool write touches the underlying file or directory and ticks the
mtime (and, for files, the size). With a stable record `id`
(`${store}:${path_hash}`) and no fingerprint gate, that pure file-stat tick
re-versions an otherwise-unchanged metadata record on every run. For a
directory store (`backup_inventory`) `size_bytes` is always `null`, so the
churn is driven entirely by `mtime_epoch`.

These streams previously had **no** connector-side fingerprint cursor and **no**
compaction policy. The volatile freshness signal they accidentally encode (does
the store exist? when did the collector last look?) is already carried by the
sibling `coverage_diagnostics` stream and the per-stream STATE `fetched_at` —
not by re-versioning the inventory record itself. The `local-agent-collector-completeness`
spec frames inventory records as completeness coverage, not a freshness
time-series. This is the same class of run-clock churn the `fetched_at`-excluding
gates already stop on the API/browser connectors; it had just never been gated
on the local-device inventory path.

Excluding only `mtime_epoch` and `size_bytes` from the fingerprint is provably
lossless: any real inventory transition (`type`, `path_hash`, `classification`,
`reason`, or a store appearing/disappearing) produces a different fingerprint
and re-emits; only a body byte-identical modulo those two file-stat fields is
suppressed. The fields stay in the record body for point-in-time inspection;
only version churn is suppressed.

Scan classification: inventory enumeration is a **full scan** of the known
stores under the source home, so the cursors prune — a store that disappears
drops out of the cursor and re-emits when it returns.

## What Changes

- Forward fix: add a shared `openInventoryFingerprintCursor` helper
  (`excludeFromFingerprint: ["mtime_epoch", "size_bytes"]`) in
  `packages/polyfill-connectors/src/local-source-inventory.ts`, and gate every
  local-device inventory stream emit through it, writing a per-stream STATE
  cursor `{ fingerprints, fetched_at }` and pruning on the full scan:
  - Claude Code: `backup_inventory`, `cache_inventory`, `config_inventory`,
    `file_history`.
  - Codex: `history`, `session_index`, `shell_snapshots`, `config_inventory`,
    `cache_inventory`, `logs`.
- Codex: the inventory streams now own their STATE inside the gate, so the
  trailing bare `{ fetched_at }` STATE writes for those streams are removed from
  `emitStateCursors` (they would clobber the fingerprint map and re-open the
  churn). `coverage_diagnostics` is not gated and keeps its point-in-time STATE.
- Register a new compaction-policy family ("inventory churn gate", each
  `excludeKeys: ["mtime_epoch", "size_bytes"]`) for the ten inventory streams
  above, mirroring the connector gate one-for-one.
- Extend the canonical compaction-policy enumeration in the
  reference-implementation-architecture capability spec to include the new
  inventory churn-gate family, and pin that a real inventory transition stays a
  fingerprint boundary and that the full-scan cursors prune.
- Extend the local-agent-collector-completeness capability spec to state that
  inventory metadata records are not re-versioned by an incidental
  `mtime_epoch`/`size_bytes` tick.
- Add forward-gate connector tests (unit + two-run integration) and compaction
  registry + fingerprint-parity coverage, including explicit "mtime/size delta
  is not a distinct fingerprint" and "inventory transition is a distinct
  fingerprint" assertions.

No new HTTP route, schedule, or automatic job. No real source field is excluded
from any fingerprint. No change to the retention rule, backup/apply safety,
dry-run default, or any public read path. Live owner `--apply` (clearing the
retained `backup_inventory`/`history` history) is deferred and owner-gated.

## Capabilities

- Modified: reference-implementation-architecture
- Modified: local-agent-collector-completeness

## Impact

- `packages/polyfill-connectors/src/local-source-inventory.ts` —
  `openInventoryFingerprintCursor` + `INVENTORY_FINGERPRINT_EXCLUDE_KEYS`.
- `packages/polyfill-connectors/connectors/claude_code/index.ts` —
  `emitGatedInventoryStream`; `emitLocalInventoryStreams` gains `emit`/`state`
  and gates every inventory stream + `file_history`.
- `packages/polyfill-connectors/connectors/claude_code/types.ts` —
  `ClaudeCodeState` index signature for per-inventory-stream cursor state.
- `packages/polyfill-connectors/connectors/codex/index.ts` —
  `emitGatedInventoryStream`; `CODEX_GATED_INVENTORY_STREAMS`;
  `emitLocalInventoryStreams` gains `nowIso`/`state`; `emitStateCursors` no
  longer writes a clobbering bare STATE for the gated inventory streams.
- `packages/polyfill-connectors/src/local-source-inventory.test.ts` — new
  unit tests for the gate boundary.
- `packages/polyfill-connectors/connectors/{claude_code,codex}/source-inventory.fixture.test.ts`
  — two-run no-re-version integration tests + optional-state forwarding.
- `reference-implementation/scripts/compact-record-history.mjs` — new
  `buildInventoryChurnGatePolicies` family (10 entries) + header docstring.
- `reference-implementation/test/compact-record-history.test.js` — registry
  shape assertion.
- `reference-implementation/test/compact-record-history-dry-run-all.test.js` —
  claude-code stream-list assertion.
- `reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
  — inventory parity fixture (with transition-boundary assertions) + static
  guard set.
- `openspec/specs/reference-implementation-architecture/spec.md` and
  `openspec/specs/local-agent-collector-completeness/spec.md` — via this
  change's deltas.
