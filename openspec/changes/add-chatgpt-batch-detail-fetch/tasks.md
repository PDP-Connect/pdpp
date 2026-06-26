## 1. API Seam

- [x] 1.1 Add `fetchBatch(ids)` to the ChatGPT API type and fakes.
- [x] 1.2 Implement `fetchBatch` against `POST /conversations/batch` with auth/device headers and JSON body.
- [x] 1.3 Ensure the batch helper rejects or chunks over-cap calls so no provider request exceeds 10 ids.

## 2. Detail Hydration

- [x] 2.1 Prefetch conversation detail in batches before existing per-conversation processing.
- [x] 2.2 Add a detail-cache check before the existing per-id GET.
- [x] 2.3 Preserve per-id GET fallback for batch omissions and batch endpoint unavailability.

## 3. Tests

- [x] 3.1 Add a batch happy-path test proving no per-id GET storm.
- [x] 3.2 Add a batch omission test proving only omitted ids fall back to per-id GET.
- [x] 3.3 Add a large-account chunking test proving 100 ids use 10 batch calls, not 100 GET calls.
- [x] 3.4 Add a batch-unavailable test proving the connector degrades to the existing GET path.

## 4. Version And Validation

- [x] 4.1 Add a connector version/change note for the detail-fetch strategy change.
- [x] 4.2 Run targeted ChatGPT connector tests.
- [x] 4.3 Run OpenSpec strict validation.
