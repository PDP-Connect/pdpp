# Tasks: Add browser surface diagnostic evidence

## 1. Shared evidence boundary

- [x] 1.1 Add a bounded structural browser-surface diagnostic builder in
  `packages/polyfill-connectors/src/`.
- [x] 1.2 Reuse existing `SKIP_RESULT.diagnostics` trace persistence; omit
  fixture references until a trusted scrubbed-fixture registry exists.
- [x] 1.3 Reject or omit URLs, page text, IDs, credentials, cookies, tokens,
  and raw DOM from the resulting evidence.

## 2. Connector wiring

- [x] 2.1 Wire Chase `current_activity` parser-zero evidence without changing
  `selectors_pending` or adding an empty-state policy/selector.
- [x] 2.2 Wire USAA `no_export_affordance` evidence without changing
  `export_affordance_missing`, coverage semantics, or export selectors.

## 3. Verification

- [x] 3.1 Add unit/privacy-negative tests for recognized marker/affordance,
  verified empty state, parser zero, unexpected surface, closed-enum rejection,
  no-PII output, and runtime-derived posture invariants.
- [x] 3.2 Add connector/runtime integration tests for the two retained
  degraded paths and exact spine persistence allowlisting.
- [x] 3.3 Run connector tests, rebuilt native SQLite persistence integration,
  typecheck, changed-file lint, strict OpenSpec validation, and diff checks.
- [ ] 3.4 Obtain an owner-assisted post-deploy Chase/USAA acceptance run; this
  is intentionally deferred because this implementation lane has no live-run
  authority.
