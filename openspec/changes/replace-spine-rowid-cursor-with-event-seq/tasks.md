## 1. Spine Cursor Audit

- [ ] 1.1 Locate all rowid-based spine cursor encode/decode/listing code.
- [ ] 1.2 Identify the schema/query migration needed for a stable `event_seq`.
- [ ] 1.3 Confirm public timeline response shapes that must remain unchanged.

## 2. Conformance Coverage

- [ ] 2.1 Add a disclosure-spine conformance scenario for tied timestamps.
- [ ] 2.2 Add a scenario for interleaved appends across correlations preserving stable pagination order.
- [ ] 2.3 Add or update a broken driver so the new ordering scenario is falsifiable.

## 3. Implementation

- [ ] 3.1 Add or backfill stable spine `event_seq` state non-destructively.
- [ ] 3.2 Rewrite spine cursor encode/decode/listing to use stable event ordering, not SQLite `rowid`.
- [ ] 3.3 Update registered spine SQL artifacts and wrapper calls as needed.
- [ ] 3.4 Grep for remaining rowid dependencies in spine cursor code and remove them.

## 4. Validation

- [ ] 4.1 Run disclosure-spine conformance tests.
- [ ] 4.2 Run `_ref` run/grant/trace timeline tests.
- [ ] 4.3 Run operation-boundary tests.
- [ ] 4.4 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [ ] 4.5 Run `pnpm --filter pdpp-reference-implementation check`.
- [ ] 4.6 Run `openspec validate replace-spine-rowid-cursor-with-event-seq --strict`.
- [ ] 4.7 Run `openspec validate --all --strict`.
