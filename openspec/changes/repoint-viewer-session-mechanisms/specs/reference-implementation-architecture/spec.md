## MODIFIED Requirements

### Requirement: The console SHALL make mounted viewer failures observable

The reference console SHALL use the mounted viewer session for viewer-owned keyboard and browser-selection clipboard mechanisms while retaining console-owned gesture and clipboard policy. A rejected viewport application or viewer mount rejection SHALL render the existing retryable inline stream-error affordance.

#### Scenario: Trusted keyboard activation

- **WHEN** the console's existing trusted-touch policy decides to focus the keyboard for a mounted n.eko viewer
- **THEN** it SHALL synchronously invoke the viewer session keyboard mechanism
- **AND** it SHALL preserve the policy's pointer, geometry, and focus-confirmation checks.

#### Scenario: Browser-selection copy

- **WHEN** console clipboard policy permits copying a mounted n.eko browser selection
- **THEN** it SHALL invoke the viewer session copy mechanism
- **AND** console policy and sheet presentation SHALL remain unchanged.

#### Scenario: Viewer session waits for injected adapter readiness

- **WHEN** a viewer has published a session but its injected n.eko adapter has not completed mounting
- **THEN** console keyboard-focus and browser-selection copy paths SHALL NOT invoke that session
- **AND** after both viewer and adapter report `mounted`, those paths SHALL invoke the session mechanism.

#### Scenario: Viewport application failure

- **WHEN** the viewer reports `getViewportState() === "error"` after applying a viewport
- **THEN** the console SHALL render its existing inline stream-error panel with a retry affordance.
