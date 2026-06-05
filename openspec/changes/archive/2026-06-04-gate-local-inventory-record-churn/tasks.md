# Tasks

## 1. Forward connector fix (inventory churn gate)

- [x] 1.1 Add `INVENTORY_FINGERPRINT_EXCLUDE_KEYS = ["mtime_epoch", "size_bytes"]`
  and `openInventoryFingerprintCursor(priorState)` to
  `packages/polyfill-connectors/src/local-source-inventory.ts`, delegating to
  the shared `openFingerprintCursor`.
- [x] 1.2 Claude Code: add `emitGatedInventoryStream`; rewire
  `emitLocalInventoryStreams` to gate every `recordsByStream` inventory stream
  plus the `file_history` directory listing, prune on the full scan, and write a
  per-stream STATE `{ fingerprints?, fetched_at }`. Thread `emit` and the prior
  `state` through; add the `ClaudeCodeState` index signature for per-stream
  inventory cursor state.
- [x] 1.3 Codex: add `emitGatedInventoryStream` and `CODEX_GATED_INVENTORY_STREAMS`;
  rewire `emitLocalInventoryStreams` to gate every requested inventory stream
  (`history`, `session_index`, `shell_snapshots`, `config_inventory`,
  `cache_inventory`, `logs`) from `recordsByStream`/the directory listing,
  threading `nowIso` and the prior `startMsg.state`.
- [x] 1.4 Codex: remove the trailing bare `{ fetched_at }` STATE writes for the
  gated inventory streams from `emitStateCursors` (they would clobber the
  fingerprint map). Keep `coverage_diagnostics`' point-in-time STATE.

## 2. Register the compaction policies

- [x] 2.1 Add a `buildInventoryChurnGatePolicies` family
  (`excludeKeys: ["mtime_epoch", "size_bytes"]`, `connectorIds` covering both
  the short name and the `local-device:` prefix) to `COMPACTION_POLICIES` in
  `reference-implementation/scripts/compact-record-history.mjs` for the four
  Claude Code and six Codex inventory streams; update the header docstring with
  the third policy family.

## 3. Tests

- [x] 3.1 Unit: `src/local-source-inventory.test.ts` pins the gate boundary —
  mtime/size-only tick is a no-op, type/classification change re-emits,
  carry-forward survives a skip, prune drops a disappeared store, legacy cursor
  re-emits once.
- [x] 3.2 Integration: two-run no-re-version tests in both
  `connectors/{claude_code,codex}/source-inventory.fixture.test.ts` (run 1 emits
  + writes a `fingerprints` STATE; run 2 seeded with that STATE does not
  re-emit, still writes a carry-forward STATE).
- [x] 3.3 Compaction registry + parity: registry-shape assertion in
  `compact-record-history.test.js`; claude-code stream-list assertion in
  `compact-record-history-dry-run-all.test.js`; inventory parity fixture +
  static-guard set in `compact-record-history-fingerprint-parity.test.js`, with
  "mtime/size delta is not a distinct fingerprint" and "inventory transition is
  a distinct fingerprint" assertions.

## 4. Spec + validation

- [x] 4.1 Extend the reference-implementation-architecture compaction-tool
  requirement with the inventory churn-gate family and a scenario.
- [x] 4.2 Extend the local-agent-collector-completeness inventory requirement
  with the no-incidental-re-version rule and a scenario.
- [x] 4.3 `pnpm --dir packages/polyfill-connectors run typecheck`; targeted
  connector + compaction tests green; `openspec validate gate-local-inventory-record-churn --strict`.

## Acceptance checks

- [x] A pure `mtime_epoch`/`size_bytes` tick on an unchanged inventory store is
  suppressed (no new version) — proven by unit + two-run integration tests.
- [x] A `type`/`classification`/`path` inventory transition still re-emits —
  proven by unit + parity tests.
- [x] The compaction policy's removable classification equals the connector
  no-op classification — proven by the fingerprint-parity test.
- [x] (Owner-only, deferred → Residual Risk at archive) Live `--apply` (or the
  live `main` release lane) clears the retained `claude-code/backup_inventory`
  and `codex/history` redundant history on the deployed instance. Deferred — no
  production mutation in this lane. Recorded as a residual risk in `design.md`
  per the AGENTS.md archive rule; the offline fingerprint-parity test pins
  `removable == connector no-op`, so the live step is residue cleanup, not a
  correctness gate.
