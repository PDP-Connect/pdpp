## ADDED Requirements

### Requirement: Stream phone presentation parity is behavior-bound

The reference implementation SHALL verify phone presentation through the controlling run-interaction stream attachment. The verification SHALL require portrait and rotated phone selections, their window-control acknowledgements, and restoration of the captured desktop baseline. A standalone visit to a target URL or source-marker recognition SHALL NOT satisfy this requirement.

#### Scenario: Owner selects and restores a phone presentation

- **WHEN** the controlling stream attachment posts `412x915` and then `915x412`
- **THEN** the n.eko presentation SHALL select and acknowledge both phone configurations
- **AND** resolving the interaction SHALL restore the captured `1440x900`-class baseline

### Requirement: Stream terminalization restores presentation before terminal outcome

The reference implementation SHALL pass interaction response, timeout, attached-token expiry, and cancellation through presentation restoration before a connector can resume. A restore failure SHALL cancel the run, and boot SHALL recycle a captured surface that was not restored.

#### Scenario: Attached stream token expires

- **WHEN** an attached stream token reaches expiry
- **THEN** the stream token SHALL be invalidated before restoration completes
- **AND** terminalization SHALL await the presentation restore barrier

### Requirement: Keyboard editable-cache evidence is behavior-backed

The reference implementation SHALL verify editable-rectangle cache invalidation with state-machine cases and the production viewer's navigation, geometry, and remount wiring. Function-name recognition alone SHALL NOT satisfy this requirement.

#### Scenario: Viewer context invalidates a warm cache

- **WHEN** navigation, a geometry epoch, or a n.eko remount occurs
- **THEN** the viewer SHALL invalidate the warm editable-rectangle cache
- **AND** a subsequent tap SHALL not use the invalidated cache
