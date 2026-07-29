## ADDED Requirements

### Requirement: Failed browser successors SHALL remain system runtime evidence

The reference implementation SHALL project an unresolved scoped process-replacement receipt as non-green credential-continuity evidence. It SHALL additionally project a failed receipt only when it terminalizes an `external_or_host_loss` successor boundary. Failed `idle_ttl`, `operator_requested`, `capacity_pressure`, or other retirement/stop history SHALL NOT become system-actionable successor evidence. This evidence SHALL NOT create, repeat, or satisfy a browser-session owner repair. A browser-session repair remains authorized only by typed verified provider invalidation proof; a successful owner repair remains subject to its confirming-run contract and subsequent unattended runs SHALL retain the connection-scoped profile binding.

#### Scenario: Failed successor is not credential invalidity

- **WHEN** a scoped successor allocation terminalizes after external or host loss
- **THEN** the connection SHALL expose non-green runtime continuity evidence
- **AND** it SHALL NOT manufacture a repeated credential-invalidity owner action from that terminal receipt alone.

#### Scenario: Failed retirement is not failed successor evidence

- **WHEN** an idle dynamic surface has a failed `idle_ttl` or `operator_requested` retirement receipt
- **THEN** idle health SHALL NOT project that receipt as a failed successor or non-green credential-continuity evidence.
