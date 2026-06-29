## 1. Projection

- [x] Extend `source-actionability.ts` with shared status/action/stream-actionability helpers.
- [x] Keep the module pure, serializable, and free of route/server fetch dependencies.

## 2. Surfaces

- [x] Wire Sources view-model to the shared status/action helpers.
- [x] Wire Runs view-model priority/count semantics to the shared work classification.
- [x] Wire Runs action-card sections to the shared work classification.
- [x] Wire connection detail stream and primary-action helpers to the shared predicate/action helpers.
- [x] Leave schedule editing behavior unchanged.

## 3. Validation

- [x] Add or adjust regression tests for cross-surface owner-action parity.
- [x] Run targeted console view-model tests.
- [x] Run console typecheck and scoped lint on changed files.
- [x] Run `openspec validate unify-source-actionability-surfaces --strict`.
- [x] Run `openspec validate --all --strict`.
