## 1. Runtime Startup

- [x] 1.1 Update `readStart` so stdin `close`, `end`, or `error` before the first
  line rejects exactly once and removes all startup listeners.
- [x] 1.2 Preserve valid START parsing and malformed JSON/type validation.

## 2. Regression Tests

- [x] 2.1 Add a subprocess regression proving a connector entrypoint with no
  START exits quickly instead of timing out.
- [x] 2.2 Run focused connector-runtime/subprocess tests.

## 3. Validation

- [x] 3.1 Reproduce the pre-fix timeout in the reference container or local
  subprocess path.
- [x] 3.2 Verify the post-fix path exits non-zero with bounded failure output.
- [x] 3.3 Run `openspec validate fail-closed-on-missing-connector-start --strict`.
- [x] 3.4 Run `openspec validate --all --strict`.
