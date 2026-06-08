## 1. CLI Read Surface

- [x] 1.1 Add grant-scoped CLI read commands backed by the existing credential cache.
- [x] 1.2 Extend read-surface smoke to exercise CLI reads, not only token retrieval.
- [x] 1.3 Add offline tests for CLI command argument and request construction.

## 2. Hosted MCP Package Health

- [x] 2.1 Ensure package ambiguous-connection metadata does not present invalid child grants as normal available targets.
- [x] 2.2 Add focused package adapter tests for invalid child grant handling.

## 3. Validation

- [x] 3.1 Run OpenSpec strict validation.
- [x] 3.2 Run targeted unit tests.
- [ ] 3.3 Run live REST/MCP/CLI read-surface smoke when a grant is available.
