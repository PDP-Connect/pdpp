## ADDED Requirements

### Requirement: Failed browser successors SHALL remain system runtime evidence

The reference implementation SHALL project an unresolved or failed scoped process-replacement receipt as non-green credential-continuity evidence. This evidence SHALL be system-actionable and SHALL NOT create, repeat, or satisfy a browser-session owner repair. A browser-session repair remains authorized only by typed verified provider invalidation proof; a successful owner repair remains subject to its confirming-run contract and subsequent unattended runs SHALL retain the connection-scoped profile binding.

#### Scenario: Failed successor is not credential invalidity

- **WHEN** a scoped successor allocation terminalizes after external or host loss
- **THEN** the connection SHALL expose non-green runtime continuity evidence
- **AND** it SHALL NOT manufacture a repeated credential-invalidity owner action from that terminal receipt alone.
