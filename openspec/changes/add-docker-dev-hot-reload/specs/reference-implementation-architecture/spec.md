## ADDED Requirements

### Requirement: Docker support SHALL provide an opt-in development hot-reload mode
The reference Docker support SHALL provide an opt-in Compose development mode
that supports iterative source edits without rebuilding production images for
each change.

#### Scenario: Docker dev mode starts
- **WHEN** an operator starts the Docker development override
- **THEN** the web service SHALL run a development server with source hot reload
- **AND** the reference service SHALL restart or reload when server source files
  change
- **AND** the composed public/internal URL topology SHALL remain the same as the
  default Docker stack

#### Scenario: Docker dev mode is accessed through another host
- **WHEN** an operator accesses Docker development mode through a LAN IP,
  hostname, or reverse proxy
- **THEN** the web service SHALL provide a documented configuration knob for
  additional Next development origins
- **AND** Docker development documentation SHALL state that reverse proxies must
  forward WebSocket upgrade traffic for Next HMR

#### Scenario: Docker dev mode runs connector flows
- **WHEN** the reference service runs inside the Docker development override
- **THEN** it SHALL load the repo-root local development env file when present
- **AND** connector credentials from that file SHALL be available to
  controller-managed connector runs without requiring production images to load
  `.env.local`

#### Scenario: Docker smoke mode remains reproducible
- **WHEN** an operator runs the default Docker smoke validation
- **THEN** it SHALL continue to build and run the production-style Docker stack
- **AND** it SHALL NOT require the development override
