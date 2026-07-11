## MODIFIED Requirements

### Requirement: Browser-backed connectors SHALL preserve session-establishment retryability

The polyfill connector runtime SHALL preserve a browser-backed connector's declared retryability semantics when session establishment fails. When `ensureSession` throws, the runtime SHALL wrap the failure as a terminal session failure while applying the connector's `retryablePattern` to both the original message and the wrapped terminal message. A connector-declared retryable source condition SHALL NOT become a non-retryable credential or code-fix condition solely because the failure occurred before collection began.

#### Scenario: Session establishment fails with a connector-retryable source condition

**WHEN** a browser-backed connector declares a retryable pattern that matches a session-establishment failure
**AND** `ensureSession` throws before collection begins
**THEN** the terminal connector error SHALL preserve `retryable=true`
**AND** the runtime recovery hint SHALL route the condition to runtime retry rather than credential repair unless separate credential-rejection evidence exists.

#### Scenario: A declared-retryable source condition is admitted to the scheduler's bounded retry

**WHEN** a run's terminal `connector_error.retryable` is explicitly `true`
**AND** the terminal error's message text incidentally matches an owner-auth-shaped free-text pattern (for example, a shared error-wrapping seam's `_session_failed:` prefix)
**THEN** the scheduler's retry classifier SHALL trust the connector's explicit `retryable=true` signal over the free-text heuristic
**AND** SHALL admit the run to its bounded automatic retry/backoff loop
**AND** SHALL NOT require unchanged owner credentials or another owner action to attempt the retry.

#### Scenario: A genuine owner-auth failure is still denied a scheduler retry

**WHEN** a run's terminal `connector_error.retryable` is `false` or absent
**AND** the terminal error's message matches a genuine owner-auth pattern (for example, `session_required` or `session_expired`)
**THEN** the scheduler's retry classifier SHALL deny the automatic retry and route the run to owner credential/session repair, unchanged from prior behavior.
