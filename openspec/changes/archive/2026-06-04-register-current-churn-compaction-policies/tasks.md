# Tasks

## 1. Forward connector fixes (new connector-side no-op gates)

- [x] 1.1 gmail `labels`: gate `emitLabelsStream` through
  `openFingerprintCursor({excludeFromFingerprint:["id"]})`, key on `id=name`,
  prune stale, persist `fingerprints` into the `labels` STATE cursor; add
  `readPriorLabelFingerprints`.
- [x] 1.2 usaa `statements`: gate `emitStatementRecords` through an optional
  `FingerprintCursor` with `excludeFromFingerprint:["fetched_at"]`, prune stale,
  persist `fingerprints` into the `statements` STATE cursor; add
  `readPriorStatementFingerprints`; open the cursor in `collect` only when
  `statements` is requested.
- [x] 1.3 chase `accounts`: gate `emitAccountsStream` through an optional
  `FingerprintCursor` with `excludeFromFingerprint:["fetched_at"]`, prune stale,
  emit a new `accounts` STATE carrying `fingerprints`; add
  `readPriorAccountFingerprints`; open the cursor in `collect` when
  `wantsAccounts`.

## 2. Register the compaction policies

- [x] 2.1 Add `gmail/labels` (`excludeKeys: []`), `usaa/statements`
  (`excludeKeys: ["fetched_at"]`), and `chase/accounts`
  (`excludeKeys: ["fetched_at"]`) to `COMPACTION_POLICIES` in
  `compact-record-history.mjs`, each with short + registry-URL `connectorIds`
  and a `connectorSource` pointing at the new connector gate. Update the header
  docstring's Family-1 enumeration.
- [x] 2.2 Add `slack/channel_memberships` (`excludeKeys: ["fetched_at"]`) to
  `COMPACTION_POLICIES`, mirroring the already-shipped connector forward gate
  (`FINGERPRINT_EXCLUDE.channel_memberships`). No new connector work — the gate
  was deferred-but-shipped; only the historical compaction policy was missing.

## 3. Test coverage

- [x] 3.1 Forward-gate tests: `connectors/gmail/labels-fingerprint.test.ts`,
  `connectors/usaa/statements-fingerprint.test.ts`,
  `connectors/chase/accounts-fingerprint.test.ts` — each proves
  unchanged-suppressed / real-change-emits / prune-on-disappear / STATE
  round-trip / legacy tolerance / connector-vs-compaction fingerprint parity.
- [x] 3.2 Add the initial three pairs (in array order) to the
  `COMPACTION_POLICIES exposes the registered policies` assertion in
  `compact-record-history.test.js`.
- [x] 3.3 Add `gmail/labels`, `usaa/statements`, `chase/accounts` parity
  fixtures to `compact-record-history-fingerprint-parity.test.js` and to the
  static-guard `fixturedPairs` set.
- [x] 3.4 Add `slack/channel_memberships` registry/findPolicy + selector tests
  to `compact-record-history.test.js` and a parity fixture (fetched_at-only
  collapse; real channel_id/user_id move is a boundary) to
  `compact-record-history-fingerprint-parity.test.js` + `fixturedPairs`.

## 4. Spec

- [x] 4.1 Extend the Family-1 enumeration in the
  reference-implementation-architecture capability spec to include
  `gmail/labels`, `usaa/statements`, `chase/accounts`, and the later
  `slack/channel_memberships` policy via this change's delta.
- [x] 4.2 Add a scenario describing the run-clock / stored-body collapse and the
  preserved boundaries (a renamed label / re-hydrated statement / renamed
  account stays a fingerprint boundary).

## Acceptance checks

- [x] `node --test reference-implementation/test/compact-record-history.test.js`
  — pass (DB-gated tests skipped without `PDPP_TEST_POSTGRES_URL`).
- [x] `node --test --import tsx reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
  — pass.
- [x] gmail/usaa/chase forward-gate tests + existing connector suites — pass.
- [x] slack forward-gate test — pass.
- [x] `pnpm exec openspec validate register-current-churn-compaction-policies --strict`
  — pass.
- [x] (Owner-only, deferred → Residual Risk at archive) Dry-run each scope
  against live data, confirm `removableVersions`, then `--apply` with the
  per-run backup table as the rollback handle. Not run in this lane (no live
  credentials; no production mutation permitted). Recorded as a residual risk in
  `design.md` per the AGENTS.md archive rule; the offline fingerprint-parity
  tests pin `removable == connector no-op`, so the live step is residue cleanup,
  not a correctness gate.
