## 1. Baseline

- [x] 1.1 Capture current `openspec list`, `openspec list --specs`, and active unchecked tasks into `reports/baseline.md`.
- [x] 1.2 Confirm `openspec validate --all --strict` passes before cleanup edits.
- [x] 1.3 Inventory all design-note locations and count notes by directory.

## 2. Active Change Inventory

- [x] 2.1 Audit `swap-sqlite-driver` and recommend keep, narrow, split, or archive.
- [x] 2.2 Audit `reference-implementation-program` and identify exact blockers to archival.
- [x] 2.3 Audit `add-polyfill-connector-system` and identify which tasks are shipped, stale, backlog, open question, or ready to split.
- [x] 2.4 Write `reports/active-change-inventory.md` with one row per active change and owner recommendation.

## 3. Design-Note Triage

- [x] 3.1 Audit `openspec/changes/reference-implementation-program/design-notes/`.
- [x] 3.2 Audit `openspec/changes/add-polyfill-connector-system/design-notes/`.
- [x] 3.3 Audit root `design-notes/`.
- [x] 3.4 Write `reports/design-note-triage.md` classifying notes or note clusters as `promote`, `sprint-needed`, `defer`, `superseded`, `connector-background`, or `historical`.
- [x] 3.5 Normalize headers on the highest-value notes that remain active intake.

## 4. Canonical Spec Gap Audit

- [x] 4.1 Compare canonical `openspec/specs/*` against shipped docs/routes/tests for reference architecture, retrieval, control plane, logging, and polyfill runtime behavior.
- [x] 4.2 Write `reports/spec-gap-audit.md` listing missing coverage and whether each gap should be fixed in this change or a follow-up.
- [x] 4.3 Add governance-only missing requirements in this change if found.
- [x] 4.4 Create follow-up OpenSpec change stubs for non-governance missing spec coverage if needed.

## 5. Program Decomposition

- [ ] 5.1 Split or draft follow-up changes for high-value `add-polyfill-connector-system` backlog clusters.
- [ ] 5.2 Move or relabel stale polyfill tasks so the active change stops mixing implementation backlog with open design questions.
- [ ] 5.3 Migrate or preserve `reference-implementation-program/design-notes` links so the program can be archived without breaking important references.
- [ ] 5.4 Decide whether to archive `reference-implementation-program` in this cleanup change.

## 6. Swap SQLite Driver Closeout

- [ ] 6.1 Decide whether query extraction remains part of `swap-sqlite-driver`.
- [ ] 6.2 If yes, leave it active with accurate tasks and a worker-ready implementation prompt.
- [ ] 6.3 If no, split query extraction into a separate inspectability change or retire it as deferred.
- [ ] 6.4 Ensure crash-verification tasks reflect the current better-sqlite3 and memory-pressure reality.

## 7. Final Validation

- [x] 7.1 Run `openspec validate clean-up-openspec-corpus --strict`.
- [x] 7.2 Run `openspec validate --all --strict`.
- [ ] 7.3 Confirm `openspec list` contains only genuinely active changes with clear next action.
- [x] 7.4 Commit the cleanup and report remaining follow-up changes.
