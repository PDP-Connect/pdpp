## 1. Spec

- [x] 1.1 Add OpenSpec delta for safe ChatGPT auth-probe diagnostics.
- [x] 1.2 Validate the change with `openspec validate add-chatgpt-auth-probe-diagnostics --strict`.

## 2. Implementation

- [x] 2.1 Add a bounded initial ChatGPT auth-probe diagnostic.
- [x] 2.2 Preserve existing auth behavior exactly.
- [x] 2.3 Avoid raw DOM, screenshots, cookies, page titles, secret values, and raw URLs in the diagnostic.

## 3. Verification

- [x] 3.1 Add focused tests for emitted diagnostic shape and no behavior change.
- [x] 3.2 Run targeted ChatGPT auth tests.
- [x] 3.3 Run relevant type/lint checks if available in this worktree.
