## 1. Replacement lifecycle

- [x] 1.1 Keep external-loss receipts unresolved until a real successor outcome.
- [x] 1.2 Correlate changed-surface successor ensure attempts by connection, subject, and profile key.
- [x] 1.3 Retain failed successor evidence as a system-actionable runtime continuity state without selecting it as a current browser generation or creating owner credential repair.

## 2. Profile provenance

- [x] 2.1 Persist allocator profile bind paths in the browser-surface projection.
- [x] 2.2 Treat profile key, path, and volume as one compatibility boundary during partial upserts.

## 3. Verification

- [x] 3.1 Run focused lifecycle, persistence, and health tests.
- [x] 3.2 Run reference typecheck and lint.
- [x] 3.3 Run `openspec validate fix-browser-profile-successor-provenance --strict` and `openspec validate --all --strict`.
- [x] 3.4 Prove failed idle/operator retirements do not become successor runtime evidence.

## 4. Deploy/UAT (owner, after merge and deployment)

- [ ] 4.1 For each affected connection, record its `connection_id`, derived `profile_key`, persisted profile bind path, and any successor generation receipt before starting repair.
- [ ] 4.2 Complete the attended browser-session repair and require its confirming run to succeed on that same connection-scoped profile binding.
- [ ] 4.3 Allow the next scheduled unattended run to succeed and verify that it reused the same `profile_key` and profile bind path; retain its successor-generation receipt if replacement occurred.
