## ADDED Requirements

### Requirement: Remote-surface package exports SHALL define an OSS-spinnable boundary

The reference implementation SHALL define `@pdpp/remote-surface` package exports around host-neutral remote-surface concepts before moving full streaming architecture code into the package. Exported APIs SHALL be organized by protocol, server broker, client viewer/controllers, backend adapters, diagnostics, leases, and test utilities rather than by PDPP route names or dashboard file structure.

#### Scenario: Package exports are introduced

- **WHEN** implementation adds full streaming architecture exports to `@pdpp/remote-surface`
- **THEN** the exports SHALL provide stable destinations for protocol schemas, server broker interfaces, client controllers, backend adapters, diagnostics, leases, and testing fakes
- **AND** new generic streaming code SHALL NOT be added to reference-only modules when a package export destination already exists

#### Scenario: Package documentation is inspected

- **WHEN** the package README or API docs describe the remote-surface architecture
- **THEN** they SHALL describe host-neutral remote-surface concepts and implemented package exports
- **AND** they SHALL NOT claim implemented controllers are scaffold-only or require PDPP `_ref` routes, run timelines, owner auth, connector registration, or Docker lifecycle as package concepts

### Requirement: Remote-surface streaming primitives SHALL be package-owned and host-adapted

The reference implementation SHALL extract backend-neutral remote-surface streaming primitives into `@pdpp/remote-surface` before treating the architecture as OSS-spinnable. The package SHALL own generic protocol shapes, session broker interfaces, client viewer interfaces, backend adapter interfaces, input/viewport/clipboard channel shapes, diagnostics schema, and allocator/session seams. The reference implementation SHALL remain the host adapter for PDPP-specific routes, run timelines, auth, persistence, and connector handoff.

#### Scenario: A host creates a remote-surface session

- **WHEN** reference owner auth has authorized a stream mint request for a pending run interaction
- **THEN** the reference SHALL map that authorized request into a package remote-surface session creation call
- **AND** the package session descriptor SHALL use generic remote-surface identity and capability fields
- **AND** PDPP `run_id`, `interaction_id`, owner auth, spine event names, and `_ref` route paths SHALL remain host-owned metadata and routing concerns

#### Scenario: The in-memory session broker is extracted

- **WHEN** the package provides a default in-memory session broker
- **THEN** it SHALL preserve token minting, idempotency replay, attach and authorize semantics, expiry, revocation, and invalidation behavior through package conformance tests
- **AND** hosts SHALL remain able to supply a durable store or host-specific persistence adapter

#### Scenario: A browser client opens a stream

- **WHEN** the dashboard opens a stream through reference `_ref` routes
- **THEN** the reference SHALL adapt the request to package attach, authorize, event-channel, input-channel, viewport-channel, clipboard-channel, and diagnostics primitives
- **AND** the browser-visible descriptor SHALL expose only scoped remote-surface capabilities and token-scoped proxy/session information
- **AND** it SHALL NOT expose raw CDP WebSocket URLs, allocator credentials, Docker hostnames, or connector-owned backend lifecycle authority

#### Scenario: Package dependency boundaries are checked

- **WHEN** `packages/remote-surface` is inspected
- **THEN** it SHALL NOT import from `reference-implementation`, `apps/web`, `packages/polyfill-connectors`, Docker implementation code, or server route modules

### Requirement: Remote-surface client behavior SHALL be reusable outside the dashboard

The package SHALL expose client APIs for mounting and unmounting a viewer, dispatching pointer/keyboard/text/clipboard input, managing mobile keyboard and IME behavior, reporting viewport and layout changes, enforcing clipboard capability policy, and subscribing to telemetry. Dashboard React components, owner-facing copy, URL resolution, route actions, and styling SHALL remain outside the package.

#### Scenario: The dashboard mounts a n.eko-backed viewer

- **WHEN** the dashboard receives a n.eko-capable stream descriptor
- **THEN** it SHALL mount the viewer through the package client API
- **AND** n.eko client implementation details SHALL remain behind the package adapter boundary
- **AND** dashboard code SHALL remain responsible only for React lifecycle, layout, owner messaging, and route-specific URL resolution

#### Scenario: Mobile input requires IME handling

- **WHEN** a mobile owner focuses a remote text field and enters text through a software keyboard or IME
- **THEN** package-owned client controllers SHALL translate keyboard, composition, and text-commit behavior into backend-neutral remote-surface input operations
- **AND** dashboard-only handlers SHALL NOT be the only implementation of IME, text commit, or keysym behavior

#### Scenario: Clipboard access is constrained

- **WHEN** a viewer copies from or pastes into the remote browser
- **THEN** the package client API SHALL model clipboard capabilities and explicit fallback paths
- **AND** host and dashboard code MAY decide how to present prompts or manual fallback UI
- **AND** clipboard contents SHALL NOT be written to diagnostics by default

### Requirement: Backend adapters SHALL hide backend authority behind capabilities

The package SHALL expose backend adapter interfaces that normalize n.eko, CDP fallback, and future remote-surface backends behind capability declarations. Backend-specific authority such as raw CDP targets, n.eko upstream origins, allocator credentials, Docker resources, or browser automation control SHALL remain server-side or host-owned unless explicitly represented as a safe scoped capability.

#### Scenario: n.eko is selected for an owner-operated browser session

- **WHEN** a package broker or host adapter selects a n.eko backend
- **THEN** the client-visible configuration SHALL route through token-scoped same-origin proxy/session information
- **AND** n.eko upstream origins and sidecar credentials SHALL be constrained by host-approved allowlists

#### Scenario: CDP fallback is selected

- **WHEN** a CDP-backed stream is used for fallback, debug, or automation-friendly sessions
- **THEN** raw CDP HTTP and WebSocket URLs SHALL remain server-side
- **AND** browser clients SHALL interact only with package event/input/viewport/clipboard channels exposed by the host adapter

#### Scenario: A future backend is added

- **WHEN** a CDP/VNC/Kasm-like backend is added later
- **THEN** it SHALL implement the package backend adapter interface and capability model
- **AND** it SHALL NOT require dashboard or connector code to learn backend-specific lifecycle authority

### Requirement: Dynamic n.eko allocation SHALL consume package seams without owning streaming extraction

Dynamic n.eko allocation SHALL depend on package-owned lease, allocator, session, target descriptor, and diagnostics seams. Docker Engine access, Compose wiring, allocator sidecar implementation, image pins, labels, networks, profile storage, readiness probes, and operator configuration SHALL remain reference-owned unless a later OpenSpec change extracts a backend allocator package.

#### Scenario: Dynamic allocation creates a surface

- **WHEN** dynamic mode ensures or starts a n.eko browser surface
- **THEN** it SHALL produce package-compatible lease/session/target descriptors for the reference streaming host adapter
- **AND** the connector SHALL receive only lease-scoped browser metadata needed for its run
- **AND** Docker lifecycle authority SHALL NOT be granted to connector code or browser clients

#### Scenario: Dynamic allocation work proceeds before full streaming extraction

- **WHEN** `add-dynamic-neko-surface-allocation` is implemented before this full streaming extraction is complete
- **THEN** it SHALL consume the existing package lease substrate and define only the minimal package-compatible streaming descriptors it needs
- **AND** it SHALL NOT absorb server broker, dashboard viewer, clipboard, keyboard, telemetry, or generic backend adapter extraction into the dynamic allocation tranche

#### Scenario: A backend allocator package is considered later

- **WHEN** the project decides Docker-backed dynamic allocation should become independently reusable
- **THEN** that decision SHALL be proposed as a separate OpenSpec change
- **AND** it SHALL NOT be implied by extracting `@pdpp/remote-surface`

### Requirement: Remote-surface extraction SHALL preserve behavioral parity by tranche

Each remote-surface extraction tranche SHALL include package conformance tests, reference parity tests, and import-boundary checks before it is marked complete. The reference SHALL preserve current `_ref` route behavior and dashboard owner UX until package-backed replacements are proven equivalent.

#### Scenario: Protocol parsing moves into the package

- **WHEN** event, frame, input, viewport, clipboard, target, or diagnostics parsing moves from reference or dashboard code into `@pdpp/remote-surface`
- **THEN** package tests SHALL include fixture cases generated from the current reference/dashboard payload shapes
- **AND** reference tests SHALL prove the existing route or viewer behavior still accepts and emits the same externally visible payloads

#### Scenario: Client viewer policy moves into the package

- **WHEN** viewport classification, geometry, clipboard policy, media-settle, visual-quality, keyboard, IME, or pointer policy moves into `@pdpp/remote-surface`
- **THEN** package tests SHALL preserve the current focused behavior tests
- **AND** dashboard code SHALL remain responsible for React lifecycle, route URL resolution, product copy, styling, and owner-specific affordances

#### Scenario: An extraction tranche completes

- **WHEN** an implementation tranche is reported complete
- **THEN** the report SHALL include an import-boundary sweep showing the package does not import reference, dashboard, connector, Docker, or server-route modules
- **AND** it SHALL identify any compatibility shim left in the reference implementation
