## 1. Shared Freshness Semantics

- [x] Add a shared pure derivation helper for `status`, `captured_at`, and `last_attempted_at`.
- [x] Add unit coverage for current, stale by age, stale by latest failed attempt, unknown without policy, and unknown without evidence.

## 2. Reference Runtime Wiring

- [x] Wire RS stream list, stream detail, and schema discovery to use connector run history and refresh policy when available.
- [x] Wire `_ref` connector summary/detail surfaces to use the same helper.
- [x] Preserve fallback behavior for native/device/exporter paths with record timestamps but no run history.

## 3. Documentation And Validation

- [x] Update Core Section 8 freshness text if the derivation semantics need additional clarification.
- [x] Run targeted reference tests covering query metadata and control-plane connector summaries.
- [x] Run `openspec validate make-reference-freshness-honest --strict`.
