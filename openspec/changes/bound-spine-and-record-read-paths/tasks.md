## 1. Owner Review Reconciliation

- [x] 1.1 Preserve the memory-regression memo in
  `design-notes/run-timeline-memory-regression-memo-2026-04-27.md`.
- [x] 1.2 Preserve the DB call-site audit in
  `design-notes/audit-call-sites-2026-04-27.md`.
- [x] 1.3 Narrow `proposal.md`, `design.md`, and the spec delta so they do not
  claim every historical `db.prepare(...)` call site is migrated.

## 2. Wrapper And Registry Foundation

- [x] 2.1 Add `reference-implementation/lib/db.ts` with `getOne`, `getMany`,
  `iterate`, `exec`, `allowUnboundedReadAcknowledged`,
  `iterateDynamicSqlAcknowledged`, and `transaction`.
- [x] 2.2 Extend `reference-implementation/server/queries/index.ts` to load
  static SQL artifacts, parse frontmatter, validate terminators, and prepare
  artifacts against the live schema.
- [x] 2.3 Enforce the registered-artifact invariant: `terminator: many` queries
  must contain `LIMIT ?` or declare `small_enumeration_table` bounds.
- [x] 2.4 Re-export wrapper query types and the frozen registry through
  `lib/db.ts`.
- [x] 2.5 Add wrapper and registry tests for invalid limits, malformed
  artifacts, cursor behavior, and small-enumeration overflow.

## 3. Spine Timeline Regression Fix

- [x] 3.1 Replace unbounded spine timeline reads with
  `listSpineEventsPage(...)`.
- [x] 3.2 Add `limit`, `cursor`, `truncated`, and `next_cursor` support to the
  run, grant, and trace `_ref` timeline endpoints.
- [x] 3.3 Bound correlation summary hydration with `SUMMARY_EVENT_CAP`.
- [x] 3.4 Use SQL aggregate values for correlation `first_at`, `last_at`, and
  `event_count` after hydration.
- [x] 3.5 Update dashboard timeline consumers to tolerate the additive
  pagination envelope.

## 4. Prevention Gate

- [x] 4.1 Add the staged-file `reference-implementation:no-direct-prepare`
  lefthook gate.
- [x] 4.2 Limit the allowlist to the wrapper, engine bootstrap, and query
  registry validation files.
- [ ] 4.3 Add or document a reproducible synthetic violation check for the
  gate. Do not mark this complete until the rejection has been exercised.

## 5. Known Follow-Ups

- [ ] 5.1 Migrate or explicitly redesign the remaining grandfathered direct
  prepares reported by:
  `rg -n "(^|[^A-Za-z_])(db|getDb\\(\\))\\.prepare\\(" reference-implementation/{lib,server,runtime,cli} --glob "*.{ts,js}"`.
- [ ] 5.2 Decide whether `iterateDynamicSqlAcknowledged` needs a stronger
  runtime guard for SQL `LIMIT` presence, or whether review plus tests are the
  right enforcement layer.
- [ ] 5.3 Add indexed terminal-event hydration so lifecycle display fields are
  exact even when correlation hydration is capped.
- [ ] 5.4 Add response-size budgets, route concurrency, and supervisor
  recovery if a measured remaining failure justifies them.
- [ ] 5.5 Extend the crash repro harness to cover long run, grant, and trace
  timelines.
- [ ] 5.6 Add a visible "load more timeline events" affordance wherever the
  dashboard currently only exposes `truncated` structurally.

## 6. Validation

- [x] 6.1 `openspec validate bound-spine-and-record-read-paths --strict`.
- [x] 6.2 `openspec validate --all --strict`.
- [x] 6.3 `pnpm --dir reference-implementation run check`.
- [x] 6.4 `pnpm --dir reference-implementation run typecheck`.
- [x] 6.5 Targeted reference tests for wrapper, registry, and control-plane
  timeline behavior.
- [x] 6.6 `pnpm --filter pdpp-web run check`.
- [x] 6.7 `pnpm --filter pdpp-web run types:check`.
- [ ] 6.8 Full reference test suite and web build before merge.
