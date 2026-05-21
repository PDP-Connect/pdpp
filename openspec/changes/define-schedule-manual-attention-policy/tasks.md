## 1. Policy Contract

- [x] 1.1 Review the existing prior-art design note and adjacent schedule/freshness changes.
- [x] 1.2 Create a focused OpenSpec change for the schedule/manual-attention policy.
- [x] 1.3 Specify schedule freshness intent, bounded run attempts, durable attention requests, notification state, and per-connection suppression.
- [x] 1.4 Run second-pass SLVP prior-art review and specify latest-only catch-up as the default after attention clears.

## 2. Future Implementation

- [ ] 2.1 Add storage and projections for durable typed attention requests.
- [ ] 2.2 Teach scheduled launches to skip or suppress when equivalent unresolved attention exists.
- [ ] 2.3 Terminate owner-attention runs as bounded attempts while preserving resume evidence.
- [ ] 2.4 Add notification policy state and operator-visible safe instructions.
- [ ] 2.5 Add tests proving no silent retry storm and no cross-connection suppression bleed.
- [ ] 2.6 Add scheduler behavior proving missed ticks do not replay as an unbounded backlog after attention resolves.

## 3. Acceptance Checks

- [x] 3.1 Run `openspec validate define-schedule-manual-attention-policy --strict`.
- [x] 3.2 Confirm no package publishing, PWA, local collector runner, or behavioral runtime files were touched.
- [x] 3.3 Owner-review the policy against the prior-art note and confirm it remains a design-only tranche.
- [x] 3.4 Re-run `openspec validate define-schedule-manual-attention-policy --strict` after second-pass SLVP updates.
