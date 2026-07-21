## ADDED Requirements

### Requirement: Browser-session repair and saved sign-in-details capture SHALL remain connector-neutral

The reference runtime SHALL probe a live browser session first for browser-bound connectors. If the live session is still valid, the runtime SHALL reuse it and SHALL NOT ask the owner to re-enter credentials. If the live session is dead and the connector declares static-secret capture, the runtime SHALL allow the owner to save encrypted sign-in details for automatic session repair, and it SHALL fill only the verified login form when those stored details are available. If the connector does not declare static-secret capture, the runtime SHALL keep the secure-browser-only path. After a verified login submit, the runtime SHALL wait for a bounded page-state transition before any re-probe. Verification-code pages that can be satisfied by entering a code field SHALL use structured `otp` / `provide_value`, fill and submit the code in the browser, and re-probe before success. The runtime SHALL hand off to the secure browser and re-probe before success on any passkey, CAPTCHA, Incapsula, unknown-UI, timeout, or failed-auto-login path. Provider passwords SHALL NOT be persisted in browser/session state or logs.

#### Scenario: Live browser session is reused

- **WHEN** a browser-bound connector probes a live session and the session is still valid
- **THEN** the runtime SHALL reuse that session
- **AND** it SHALL NOT ask the owner to save or re-enter credentials

#### Scenario: Stored sign-in details repair a dead session

- **WHEN** a browser-bound connector declares static-secret capture and the live session is dead
- **AND** encrypted sign-in details are available
- **THEN** the runtime SHALL fill only the verified login form
- **AND** it SHALL submit the form and wait for a bounded post-submit page-state transition before re-probing

#### Scenario: Secure browser login remains the fallback when no stored credentials exist

- **WHEN** a browser-bound connector does not declare static-secret capture or no stored sign-in details are available
- **THEN** the runtime SHALL keep the secure-browser-only path
- **AND** it SHALL hand off to the owner rather than invent a credential path

#### Scenario: Optional alternative login affordances do not preempt a visible credential form

- **WHEN** the browser renders a visible, enabled email/password sign-in form
- **AND** the page body also advertises optional passkey or one-time-code affordances
- **THEN** the runtime SHALL fill the verified sign-in form
- **AND** it SHALL NOT hand off to the secure browser before attempting that form

#### Scenario: Verification-code pages are handled as structured OTP

- **WHEN** the browser renders a verification-code page with a code input that can be submitted in the browser
- **THEN** the runtime SHALL emit structured `otp` / `provide_value`
- **AND** it SHALL fill and submit the code in the browser
- **AND** it SHALL re-probe before reporting success
- **AND** it SHALL NOT route that page through `manual_action`

#### Scenario: A submitted login waits for a bounded transition before the orders probe

- **WHEN** the runtime submits a verified login form
- **THEN** it SHALL wait on the current page for a bounded authentication outcome or transition
- **AND** it SHALL NOT force the orders probe while the submitted login is still advancing

#### Scenario: Challenge, unknown UI, or timeout forces owner handoff and re-probe

- **WHEN** the browser shows a passkey, CAPTCHA, Incapsula, or unknown UI, or the automated submit times out without establishing a session
- **THEN** the runtime SHALL hand off to the secure browser with a precise owner instruction
- **AND** it SHALL re-probe before reporting success

### Requirement: Owner-facing setup surfaces SHALL expose the browser-session versus saved sign-in-details choice from capability shape

Owner-facing setup surfaces SHALL derive the choice between secure browser login and saved sign-in-details capture from connector capability shape. A browser-bound connector that also declares static-secret capture SHALL present a browser-session primary action and a saved-sign-in-details secondary action. The surface SHALL NOT branch on connector key. A non-browser static-secret connector SHALL keep its existing single static-secret setup path.

#### Scenario: Browser-bound static-secret connector gets a dual choice

- **WHEN** a browser-bound connector declares static-secret capture
- **THEN** the setup surface SHALL present a browser-session primary action
- **AND** it SHALL present a saved-sign-in-details secondary action
- **AND** the choice SHALL be derived from capability shape rather than connector key

#### Scenario: Non-browser static-secret connector keeps the existing single path

- **WHEN** a non-browser connector declares static-secret capture
- **THEN** the setup surface SHALL continue to present the existing single static-secret path
- **AND** it SHALL NOT render a browser-session alternate action
