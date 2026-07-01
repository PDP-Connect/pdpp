## ADDED Requirements

### Requirement: Connectors SHALL checkpoint during a long non-blocking observation window in session establishment

The connector SHALL call the session-establishment `checkpoint` hook on each poll
iteration of a non-blocking observation window (polling for an
externally-approvable completion signal) during session establishment, so the
session-establishment watchdog observes forward progress and does not fail the
run closed while the connector is legitimately waiting on an approval it can
observe.

#### Scenario: Connector receives and uses the checkpoint hook during the observation window
- **WHEN** the runtime invokes a connector's `ensureSession` with a `checkpoint` hook
- **AND** the connector enters a non-blocking observation poll whose budget can exceed the watchdog's no-progress deadline
- **THEN** the connector SHALL call `checkpoint` on each poll iteration
- **AND** the run SHALL NOT trip the session-establishment watchdog while the poll is iterating

### Requirement: ChatGPT push-approval SHALL auto-resume on session readiness across its full observation budget

The ChatGPT auto-login push-approval handler SHALL poll session readiness across
an owner-configurable observation budget and SHALL continue the run automatically
without emitting any `INTERACTION` when readiness is observed during that budget.
The handler SHALL emit the blocking `manual_action` fallback only after the
observation budget is exhausted.

#### Scenario: Session becomes active during the observation budget
- **WHEN** the ChatGPT push-approval page is detected and the connector begins its readiness observation poll
- **AND** `isChatGptSessionActive(page)` becomes true at any point within the observation budget
- **THEN** the connector SHALL complete the push-approval assistance as `resolved`
- **AND** the connector SHALL continue collection without emitting an `INTERACTION` or requiring an owner response

#### Scenario: Observation budget is exhausted
- **WHEN** the ChatGPT push-approval observation budget elapses without `isChatGptSessionActive(page)` becoming true
- **THEN** the connector SHALL complete the push-approval assistance as `escalated`
- **AND** the connector SHALL then emit the blocking `manual_action` fallback and re-check readiness once after the owner responds

#### Scenario: Observation budget is owner-configurable
- **WHEN** `PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS` is set to a positive integer
- **THEN** the connector SHALL use it as the push-approval observation budget
- **AND** the `act_elsewhere` assistance `timeout_seconds` SHALL be derived from the same budget

### Requirement: ChatGPT push-approval changes SHALL NOT alter other session fallbacks

The ChatGPT push-approval auto-resume behavior SHALL NOT change the connector's
captcha, login, OTP, or unexpected-login-UI manual fallbacks.

#### Scenario: Unexpected login UI fallback is unchanged
- **WHEN** the ChatGPT login inputs are absent (for example a Cloudflare challenge) and the operator completes login in the streaming companion
- **THEN** the connector SHALL behave exactly as before this change, continuing when the session is active and failing only when login still has not happened
