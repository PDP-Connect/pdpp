## 1. Implementation

- [x] Add a per-stream floor flag to the Collection Report projection.
- [x] Thread the flag through the console client and source view models.
- [x] Render capped pending-gap counts with floor wording.

## 2. Validation

- [x] Add server projection coverage for capped pending-gap reads.
- [x] Add console formatter/view-model coverage for floor wording.
- [x] Run `openspec validate show-capped-detail-gap-counts --strict`.
- [x] Run targeted reference and console tests.
