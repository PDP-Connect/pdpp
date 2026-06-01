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

## 3. Implementation (deferred — next lane, do NOT do here)

- [ ] Add `browser_collector` to the connector-instance source-kind type and the
      enroll handler's `sourceBinding` construction.
- [ ] Add a manifest-derived source-kind resolver shared by the enrollment-code
      and enroll routes; reuse the intent classifier's binding precedence.
- [ ] Reject contradicting / unresolvable source kinds with typed errors; unit
      coverage for filesystem→`local_device`, browser→`browser_collector`,
      contradiction→reject, no-binding→reject.
- [ ] Land an Amazon end-to-end proof test that drives enrollment → browser
      session → device-exporter ingest, plus a scrubbed Amazon fixture.
- [ ] Flip the `browser_bound` intent branch to return `enroll_browser_collector`
      only after the proof lands; add `add-owner-agent-control-surface` tasks
      5.3 / 8.5 Amazon second-account acceptance coverage.

## Acceptance checks

Reproducible from the worktree root:

1. `pnpm exec openspec validate add-browser-collector-enrollment-primitive --strict`
   exits 0.
2. `pnpm exec openspec validate --all --strict` exits 0.
3. `git diff --check` reports no whitespace errors.
4. The design names: `browser_collector` (distinct from `local_device` and from
   the spine `SourceKind`), binding-aware enrollment, the owner-mediated
   next-step-without-active-connection rule, and the proof-before-flip gate.
