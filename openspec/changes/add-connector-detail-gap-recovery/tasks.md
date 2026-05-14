## 1. Model and Storage

- [ ] Define the reference-only durable detail-gap/backlog storage shape.
- [ ] Add migrations or storage initialization for pending, in-progress, recovered, and terminal gap states.
- [ ] Add safe serialization rules for gap locators and last-error metadata.

## 2. Runtime Semantics

- [ ] Add runtime handling for connector-reported recoverable detail gaps.
- [ ] Enforce that list-level cursor progress can commit only when missing required detail is emitted, explicitly optional/skipped, or durably recorded as a pending gap.
- [ ] Ensure failed, cancelled, and protocol-violating runs still preserve existing no-commit behavior unless the run reaches the new successful-with-gap condition.
- [ ] Add recovery selection so future runs load pending gaps for the same source and requested scope.

## 3. Connector Pilot

- [ ] Update the ChatGPT connector to report exhausted recoverable conversation-detail failures as pending detail gaps instead of fake records.
- [ ] Route ChatGPT gap recovery through the same adaptive lane, retry, pacing, and cancellation controls as normal conversation detail hydration.
- [ ] Mark recovered gaps only after the real hydrated record is emitted.

## 4. Observability

- [ ] Expose pending, in-progress, recovered, and terminal detail-gap state through reference-only observability.
- [ ] Label all new surfaces or events as reference-only rather than Collection Profile protocol.
- [ ] Redact secret-bearing URLs, cookies, bearer tokens, request bodies, and private payload fragments from gap observability.

## 5. Tests and Fixtures

- [ ] Add deterministic fixture coverage for a ChatGPT-style `30/278` pressure failure that records a pending gap and commits list progress honestly.
- [ ] Add recovery coverage proving a later run fetches the pending detail without replaying the full tranche.
- [ ] Add negative coverage proving cursor commit is rejected when required detail is missing without a durable gap.
- [ ] Add redaction coverage for gap locators and last-error metadata.

## 6. Acceptance Checks

- [ ] Run the relevant connector/runtime test suite.
- [ ] Run `openspec validate add-connector-detail-gap-recovery --strict`.
- [ ] Document whether implementation evidence supports keeping the behavior reference-only or promoting any part into Collection Profile work.
