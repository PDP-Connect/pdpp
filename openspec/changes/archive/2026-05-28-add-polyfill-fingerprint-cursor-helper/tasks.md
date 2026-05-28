## 1. Helper

- [x] 1.1 Add `packages/polyfill-connectors/src/fingerprint-cursor.ts` exporting `openFingerprintCursor`, `FingerprintCursor`, `FingerprintCursorOptions`, and `recordFingerprint` (the deterministic per-record hash). The helper SHALL be the only place the cursor's state lives — callers do not poke at internal maps.
- [x] 1.2 Implement `shouldEmit` so it always updates the next-map and seen-set, returns `true` iff the new fingerprint differs from the prior, and is a no-op for ids that are null/undefined/empty.
- [x] 1.3 Implement tolerant prior-state decoding: accept `undefined`, missing `fingerprints` key, non-string values, empty strings, and arrays-as-stream-state without throwing; silently drop entries that do not decode.
- [x] 1.4 Implement `pruneStale` so it drops every id absent from the seen-set this run. Idempotent. Safe to call zero or one times.
- [x] 1.5 Implement `toState` returning a `Record<string, string>`, preserving carry-forward for skipped records (`shouldEmit` already populated the next-map).
- [x] 1.6 Implement `priorFingerprint(id)` returning the prior cursor's value if any, for connector-specific derived-field policies.

## 2. Tests

- [x] 2.1 Add `packages/polyfill-connectors/src/fingerprint-cursor.test.ts` covering: identical second run emits nothing, run-clock-only diff does not re-emit, source-field change re-emits, prior id absent from this run is pruned, malformed/legacy state is tolerated, anonymous (id-less) records pass through, `priorFingerprint` returns the prior value.
- [x] 2.2 Migrate `packages/polyfill-connectors/connectors/slack/fingerprint.test.ts` to drive the helper. Behavior assertions stay; only the test seam (`StreamDeps` carries `fingerprintCursors` instead of three raw maps) changes.
- [x] 2.3 Confirm Slack connector tests are green.

## 3. Slack migration

- [x] 3.1 Replace Slack's `emitWithFingerprint` (now a thin per-stream gate), `pruneStaleFingerprints`, `readPriorFingerprintMap`, and `readAllPriorFingerprints` with one cursor per fingerprinted stream opened in `collect`. The deterministic `recordFingerprint` is now exported from the shared module; the previous copy in `slack/parsers.ts` is removed.
- [x] 3.2 Preserve Slack's STATE shape: each cursor emits `cursor.fingerprints` under the stream's STATE cursor when non-empty, alongside `synced_at`. No wire change.
- [x] 3.3 Preserve prune semantics: cursors for requested streams prune; cursors for unrequested streams keep their full carry-forward. The Slack `collect` loop decides this, not the helper.
- [x] 3.4 Preserve carry-forward seeding: each cursor starts with the prior fingerprint map already loaded so an id skipped this run survives into the next STATE write.
- [x] 3.5 Grep the repo for the removed Slack helper names (`pruneStaleFingerprints`, `readPriorFingerprintMap`, `readAllPriorFingerprints`) and confirm zero remaining references outside the change diff.

## 4. Authoring guide

- [x] 4.1 Update `packages/polyfill-connectors/docs/connector-authoring-guide.md` §6 (Cursor and incremental discipline) to introduce the primitive: source-local ids, semantic fingerprints, run-clock exclusions, full-scan prune semantics, and the runtime byte-equivalence backstop framing.
- [x] 4.2 Note explicitly which connectors already use the pattern (Slack via the helper; Gmail / Codex / YNAB still hand-rolled) so authors of those connectors do not assume a hidden contract.

## 5. Validation

- [x] 5.1 `pnpm workstreams:status -- --no-fail` for an inventory snapshot before reporting.
- [x] 5.2 `openspec validate add-polyfill-fingerprint-cursor-helper --strict`.
- [x] 5.3 Targeted Slack fingerprint test (`node --test --import tsx connectors/slack/fingerprint.test.ts`).
- [x] 5.4 Targeted new helper test (`fingerprint-cursor.test.ts`).
- [x] 5.5 Package-level typecheck (`pnpm --filter @pdpp/polyfill-connectors typecheck`).
- [x] 5.6 `git diff --check`.

## Acceptance Checks

- The new helper exposes exactly the API described in `design.md` and nothing more.
- Slack's `fingerprint.test.ts` asserts the same observable behavior as before (same scenarios, same expected counts, only the test seam differs).
- `openspec validate add-polyfill-fingerprint-cursor-helper --strict` and `openspec validate --all --strict` pass.
- Grep for removed Slack helper names yields no surviving references.
- No production code outside the polyfill-connectors package changes.
