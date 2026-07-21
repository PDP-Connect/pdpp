## MODIFIED Requirements

### Requirement: n.eko streaming preserves an owner-controlled browser UX

When the reference implementation uses n.eko as a streaming backend, it SHALL keep the sidecar behind the same stream-token lifecycle while presenting the owner with an embedded browser-control surface rather than a general n.eko room UI. A managed n.eko surface SHALL carry its own validated window-settle endpoint, and the reference SHALL not mark a presentation restored, resume collection, or release its lease until baseline geometry has settled or the surface has been retired. Routine n.eko assistive browser control SHALL use a Patchright-mediated browser-client seam rather than adapter-owned raw page-CDP helper commands; strict/browser-owner mode SHALL remain usable for baseline viewing and input without a page-level browser attach.

#### Scenario: A managed presentation reaches a terminal path

- **WHEN** a managed n.eko presentation terminates through a response, cancellation, expiry, child death, or watchdog cleanup
- **THEN** the reference SHALL await baseline restoration and the surface-specific window-settle acknowledgement before marking it restored or releasing its lease
- **AND** if restoration or settlement fails, it SHALL retire or recycle the surface rather than release it for reuse

#### Scenario: A controller and observer attach to the same stream

- **WHEN** a secondary attachment connects to an active stream session
- **THEN** the reference SHALL allow it to receive frames and events as an observer
- **AND** it SHALL reject every state-changing presentation request unless the request carries that session's controlling attachment

#### Scenario: Concurrent stream sessions attach in one browser

- **WHEN** two stream sessions establish controllers in one cookie jar
- **THEN** each controller SHALL retain authority only for its own session
- **AND** neither session's controller or observer SHALL mutate the other session
