## 1. Design (this lane)

- [x] Confirm the gap and grounding facts in tree (enroll route hardcodes
      `local_device`; intent route classifies `browser` → `browser_bound` →
      `unsupported`; Amazon manifest declares `bindings.browser.required`).
- [x] Decide `browser_collector` is a connector-instance source kind, a peer of
      `local_device`, and explicitly not the spine `SourceKind` union.
- [x] Specify binding-aware enrollment gating (manifest-derived, contradiction
      rejection, no defaulting).
- [x] Specify owner-mediated browser-bound initiation reaching a typed next step
      with `connection_active: false`.
- [x] Specify the proof precondition before any route flips Amazon off
      `unsupported`.
- [x] State Core / Collection Profile / reference boundaries and defer the
      `browser` binding-name reconciliation to its design note.
- [x] Write proposal, design, and spec deltas.

## 2. Validation (this lane)

- [x] `pnpm exec openspec validate add-browser-collector-enrollment-primitive --strict` (valid)
- [x] `pnpm exec openspec validate --all --strict` (39 passed, 0 failed)
- [x] `git diff --check` (clean, exit 0)

## 3. Implementation

- [x] Add `browser_collector` to the connector-instance source-kind type and the
      enroll handler's `sourceBinding` construction. (Widened the
      `connector_instances.source_kind` CHECK in sqlite `db.js` + postgres
      `postgres-storage.js`, with forward migrations for already-migrated DBs,
      and the store-level `VALID_SOURCE_KINDS` guard. Enroll handler now writes
      the manifest-derived kind for both `sourceKind` and `sourceBinding.kind`.)
- [x] Add a manifest-derived source-kind resolver shared by the enrollment-code
      and enroll routes; reuse the intent classifier's binding precedence.
      (`server/routes/connector-source-kind.ts`; `filesystem` wins over
      `browser`, matching `classifyConnectorIntentModality`.)
- [x] Reject contradicting / unresolvable source kinds with typed errors; unit
      coverage for filesystem→`local_device`, browser→`browser_collector`,
      contradiction→reject, no-binding→reject. (Unit tests in
      `test/connector-source-kind.test.js`; route-level enroll tests in
      `test/device-exporter-routes.test.js`. The enrollment-code route rejects a
      contradicting/unresolvable kind before minting a code.)
- [ ] Land an Amazon end-to-end proof test that drives enrollment → browser
      session → device-exporter ingest, plus a scrubbed Amazon fixture.
      (DEFERRED: requires a real browser session against a logged-in provider,
      which cannot be produced honestly in a no-human worktree. See report
      Residual proof gate.)
- [ ] Flip the `browser_bound` intent branch to return `enroll_browser_collector`
      only after the proof lands; add `add-owner-agent-control-surface` tasks
      5.3 / 8.5 Amazon second-account acceptance coverage.
      (DEFERRED: intentionally left as honest `unsupported` until the proof
      above lands — the spec forbids advertising the next step without committed
      proof.)

## Acceptance checks

Reproducible from the worktree root:

1. `pnpm exec openspec validate add-browser-collector-enrollment-primitive --strict`
   exits 0.
2. `pnpm exec openspec validate --all --strict` exits 0.
3. `git diff --check` reports no whitespace errors.
4. The design names: `browser_collector` (distinct from `local_device` and from
   the spine `SourceKind`), binding-aware enrollment, the owner-mediated
   next-step-without-active-connection rule, and the proof-before-flip gate.
