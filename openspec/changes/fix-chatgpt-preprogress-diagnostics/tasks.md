## 1. Runtime and connector

- [x] Add a connector-scoped terminal error normalizer to the polyfill connector runtime.
- [x] Add ChatGPT-local pre-progress error normalization.
- [x] Keep the normalizer bounded and non-secret.

## 2. Tests

- [x] Add ChatGPT connector tests for normalized pre-progress failure classes.
- [x] Add or adjust reference runtime tests so a simulated ChatGPT pre-progress failure yields durable known gaps.

## 3. Validation

- [x] Run `openspec validate fix-chatgpt-preprogress-diagnostics --strict`.
- [x] Run focused connector/runtime tests.
- [x] Write the workstream report.
