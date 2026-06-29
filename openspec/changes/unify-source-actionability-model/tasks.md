## 1. Contract

- [x] 1.1 Capture prior-art findings in `docs/research/`.
- [x] 1.2 Add a `reference-connection-health` delta for owner-console actionability grouping.
- [x] 1.3 Validate the OpenSpec change strictly.

## 2. Implementation

- [x] 2.1 Add one pure actionability projection derived from `RefConnectorSummary.rendered_verdict`.
- [x] 2.2 Update Standing Overview to render grouped source work with scoped counts.
- [x] 2.3 Remove duplicate row construction between advisory owner actions and source issues.
- [x] 2.4 Keep source links exact to connection identity.

## 3. Tests

- [x] 3.1 Cover live-shaped rows with attention, owner review, maintainer/system issue, and checking groups.
- [x] 3.2 Cover the no-duplicate-row invariant for reviewable degraded rows.
- [x] 3.3 Cover count/heading copy so hero group counts match visible group rows.
- [x] 3.4 Run focused console view-model tests.

## 4. Validation

- [x] 4.1 Run `openspec validate unify-source-actionability-model --strict`.
- [x] 4.2 Run targeted console tests.
- [x] 4.3 Run console typecheck or record residual dependency blocker.
