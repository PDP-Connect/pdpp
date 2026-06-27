## MODIFIED Requirements

### Requirement: Runtime SHALL persist safe run timeline events
The reference runtime SHALL emit durable spine events for runtime-observable run lifecycle milestones without storing connector secret responses in those events. When an owner cancels a run, the reference runtime SHALL record the cancellation request and a terminal event that preserves the owner-cancel intent. Browser-backed connectors MAY emit bounded auth/session-probe diagnostics as progress events when those diagnostics are necessary to distinguish session reuse from credentialed login, provided the diagnostic excludes raw DOM, screenshots, cookies, bearer tokens, credentials, raw URLs with identifiers, page titles, account names, record payload, and source content.

#### Scenario: ChatGPT initial auth probe is diagnostically decidable
- **WHEN** the ChatGPT connector checks whether a persisted browser session can be reused before credential login
- **THEN** the reference SHALL emit a bounded `chatgpt_auth_probe` progress diagnostic
- **AND** the diagnostic SHALL include only safe machine-readable booleans, a coarse route class, and the connector's probe decision
- **AND** the diagnostic SHALL NOT include DOM text, screenshots, cookies, bearer tokens, credentials, page titles, raw URLs with identifiers, account names, conversation identifiers, conversation text, or record payload
- **AND** emitting the diagnostic SHALL NOT change whether the connector accepts the session or proceeds to credential login
