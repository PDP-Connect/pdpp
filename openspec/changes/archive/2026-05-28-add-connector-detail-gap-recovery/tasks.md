## 1. Model and Storage

- [x] Define the reference-only durable detail-gap/backlog storage shape.
- [x] Add migrations or storage initialization for pending, in-progress, recovered, and terminal gap states.
- [x] Add safe serialization rules for gap locators and last-error metadata.

## 2. Runtime Semantics

- [x] Add runtime handling for connector-reported recoverable detail gaps.
- [x] Add reference-only detail coverage handling for list-plus-detail cursor boundaries.
- [x] Enforce that list-level cursor progress can commit only when missing required detail is emitted, explicitly optional/skipped, or durably recorded as a pending gap.
- [x] Ensure failed, cancelled, and protocol-violating runs still preserve existing no-commit behavior unless the run reaches the new successful-with-gap condition.
- [x] Add recovery selection so future runs load pending gaps for the same source and requested scope.

## 3. Connector Pilot

- [x] Update the ChatGPT connector to report exhausted recoverable conversation-detail failures as pending detail gaps instead of fake records.
- [x] Update the ChatGPT connector to emit reference-only detail coverage for conversation list cursor advancement.
- [x] Route ChatGPT gap recovery through the same adaptive lane, retry, pacing, and cancellation controls as normal conversation detail hydration.
- [x] Mark recovered gaps only after the real hydrated record is emitted.

## 4. Observability

- [x] Expose pending, in-progress, recovered, and terminal detail-gap state through reference-only observability.
- [x] Label all new surfaces or events as reference-only rather than Collection Profile protocol.
- [x] Redact secret-bearing URLs, cookies, bearer tokens, request bodies, and private payload fragments from gap observability.
- [x] Add sanitized ChatGPT conversation-detail network-pressure diagnostics with route templates, status/error class, attempt budget, and safe retry-after metadata.

## 5. Tests and Fixtures

- [x] Add deterministic fixture coverage for a ChatGPT-style `30/278` pressure failure that records a pending gap and commits list progress honestly.
- [x] Add recovery coverage proving a later run fetches the pending detail without replaying the full tranche.
- [x] Add negative coverage proving cursor commit is rejected when required detail is missing without a durable gap.
- [x] Add redaction coverage for gap locators and last-error metadata.
- [x] Add redaction coverage for ChatGPT 429/retry-exhaustion pressure diagnostics.

## 6. Acceptance Checks

- [x] Run the relevant connector/runtime test suite.
- [x] Run `openspec validate add-connector-detail-gap-recovery --strict`.
- [x] Document whether implementation evidence supports keeping the behavior reference-only or promoting any part into Collection Profile work.
