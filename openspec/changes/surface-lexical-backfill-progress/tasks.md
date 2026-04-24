## 1. Server Progress Tracking

- [x] 1.1 Add lexical backfill job tracking to `reference-implementation/server/search.js`.
- [x] 1.2 Update lexical stream rebuild loops with scanned record and FTS-row counts.
- [x] 1.3 Export a read-only lexical progress getter.

## 2. Diagnostics Surface

- [x] 2.1 Add lexical progress types and report fields to deployment diagnostics.
- [x] 2.2 Add a lexical rebuilding warning when progress is active.
- [x] 2.3 Wire `/_ref/deployment` to the lexical progress getter.

## 3. Dashboard

- [x] 3.1 Update dashboard diagnostics client types.
- [x] 3.2 Render lexical index status and progress on `/dashboard/deployment`.

## 4. Acceptance Checks

- [x] 4.1 Add focused unit coverage for lexical progress and warnings.
- [ ] 4.2 Run `cd reference-implementation && node --test --test-force-exit test/deployment-diagnostics.test.js`.
- [ ] 4.3 Run `openspec validate surface-lexical-backfill-progress --strict`.
