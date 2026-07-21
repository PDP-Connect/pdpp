## MODIFIED Requirements

### Requirement: Managed n.eko surfaces SHALL prove required runtime behavior before stream attachment

The reference implementation SHALL probe the required n.eko window-settle behavior before attaching a managed stream. A successful no-query response with `settled: true` and positive dimensions is the authoritative evidence; deployment metadata MAY assist diagnosis but SHALL NOT gate the decision.

#### Scenario: A deploy converges a static surface

- **WHEN** a deployment includes application code that requires the n.eko window-settle behavior
- **THEN** its deployment workflow SHALL rebuild and converge the static n.eko surface with the application
- **AND** a stale running image SHALL fail pre-attach verification rather than starting a viewer stream

#### Scenario: A managed surface is stale

- **WHEN** a dynamic surface fails the required window-settle behavior probe
- **THEN** an idle surface SHALL be retired and recreated while preserving its profile storage
- **AND** a surface with an active run SHALL remain available to that run and SHALL be retired after terminal release

#### Scenario: A stream targets an incompatible surface

- **WHEN** stream minting or attachment observes a failed required-behavior probe
- **THEN** the reference implementation SHALL return a typed retryable user-visible failure before proxy/bootstrap traffic begins
- **AND** it SHALL NOT emit a black presentation frame as the failure surface
