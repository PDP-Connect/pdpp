## ADDED Requirements

### Requirement: Remote-surface client SHALL provide a backend-agnostic viewport-match loop

`@opendatalabs/remote-surface/client` SHALL expose a backend-agnostic viewport-match controller that consumes container geometry from the container-fit viewer surface, classifies viewport transitions with the package viewport classifier, suppresses keyboard-occlusion and browser-chrome-only changes, debounces postable layout/orientation changes, shapes target viewport payloads with the package geometry helper, and applies the result only through an injected backend function.

#### Scenario: A container layout resize should resize the remote viewport

- **WHEN** the viewer container changes size because of a layout or orientation transition
- **THEN** the controller SHALL debounce the transition
- **AND** it SHALL call the injected backend apply function with the target viewport after applying any configured snap policy

#### Scenario: A mobile keyboard occludes the local viewport

- **WHEN** the observed viewport transition is classified as keyboard occlusion, browser chrome movement, zoom, or stable churn
- **THEN** the controller SHALL suppress the backend resize effect
- **AND** it SHALL still report mismatch telemetry for the current visible stream

#### Scenario: A backend supplies its own resize mechanism

- **WHEN** the host uses CDP, n.eko, or another backend
- **THEN** the controller SHALL not import backend runtime clients or host routing code
- **AND** the backend-specific resize operation SHALL be supplied through the injected apply-viewport function

### Requirement: Viewport-match telemetry SHALL expose visible mismatch

The viewport-match controller SHALL expose telemetry that lets a host display whether the fitted media matches the viewer container. The telemetry SHALL include the current target viewport, actual stream viewport when known, letterbox bars, maximum mismatch in CSS pixels, and a boolean matched status using a configurable threshold.

#### Scenario: The remote viewport catches up to the local container

- **WHEN** the backend has applied the requested viewport and the stream surface reports the new actual viewport
- **THEN** the controller telemetry SHALL report reduced letterbox bars
- **AND** `matched` SHALL become true when the maximum bar is below the configured threshold

### Requirement: n.eko viewport application SHALL remain behind a seam

The remote-surface package SHALL define a n.eko apply-viewport seam for future runtime integration without performing n.eko Docker/runtime work in the client controller.

#### Scenario: n.eko support is completed later

- **WHEN** a n.eko-backed host adopts the viewport-match controller
- **THEN** it SHALL provide an apply-viewport implementation behind the n.eko seam
- **AND** that implementation MAY add aligned-modeline snapping, `Browser.setWindowBounds`, screen/media settle checks, and gutter-crop reporting without changing the shared controller decision logic
