## MODIFIED Requirements

### Requirement: Browser-backed connectors SHALL preserve session-establishment retryability

The polyfill connector runtime SHALL preserve a browser-backed connector's declared retryability semantics when session establishment fails. When `ensureSession` throws, the runtime SHALL wrap the failure as a terminal session failure while applying the connector's `retryablePattern` to both the original message and the wrapped terminal message. A connector-declared retryable source condition SHALL NOT become a non-retryable credential or code-fix condition solely because the failure occurred before collection began.

#### Scenario: Session establishment fails with a connector-retryable source condition

**WHEN** a browser-backed connector declares a retryable pattern that matches a session-establishment failure
**AND** `ensureSession` throws before collection begins
**THEN** the terminal connector error SHALL preserve `retryable=true`
**AND** the runtime recovery hint SHALL route the condition to runtime retry rather than credential repair unless separate credential-rejection evidence exists.
