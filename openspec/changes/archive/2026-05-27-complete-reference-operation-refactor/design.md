## Design

The route adapter boundary is now the rule:

- `server/index.js` owns HTTP framework wiring, auth/session guards, request id
  and trace id setup, response writing, instrumentation dispatch, and concrete
  capability wiring.
- Canonical operation modules own request semantics, response/disclosure data
  shape, typed operation errors, and dependency ordering that is part of the
  protocol contract.
- Operation modules depend on explicit capabilities rather than Fastify,
  `server/index.js`, raw SQL handles, concrete stores, or process environment.

The final slice is implemented by route family to keep ownership disjoint while
remaining one umbrella refactor:

- `final-refactor-rs-search-discovery-state`
- `final-refactor-rs-blob-record-mutations`
- `final-refactor-as-oauth-device-consent`
- `final-refactor-ref-diagnostics`
- `final-refactor-integration-owner`

Each implementation worker updates the umbrella tasks for its owned route
family, adds operation and boundary tests, commits on its branch, and writes an
owner-review report. The integration owner is read-only unless fixing
integration-only conflicts after owner approval.

## Risk Controls

- Preserve current public behavior by pinning existing protocol tests plus new
  operation behavior tests.
- Preserve auth gates and event ordering with focused route-level tests where
  behavior is security- or audit-sensitive.
- Keep workers disjoint by route family and file ownership.
- Merge only after owner review of diffs, reports, and validation.
