## MODIFIED Requirements

### Requirement: Assistance attachments are optional and typed

The reference runtime SHALL model browser streaming, URLs, QR codes, file prompts, and fixtures as optional typed attachments to an assistance request. The generic assistance contract SHALL NOT expose Playwright `Page`, CDP WebSocket URLs, n.eko stream URLs, or other browser-control implementation details as generic assistance fields.

#### Scenario: Browser control is required
- **WHEN** a connector requires the owner to operate a live browser page
- **THEN** the reference SHALL represent the assistance as progress posture `blocked`, owner action `operate_attachment`, and response obligation `response_required`
- **AND** the assistance SHALL include a `browser_surface` attachment or explicitly report that no browser surface is available

#### Scenario: Non-browser connector uses a URL or QR attachment
- **WHEN** a connector that is not Playwright-driven asks the owner to open a URL or scan a QR code
- **THEN** the reference SHALL represent the URL or QR code as an attachment
- **AND** the assistance SHALL remain valid without any browser-surface attachment

#### Scenario: Stream attach fails
- **WHEN** an assistance request requires browser operation but browser-surface registration or minting fails
- **THEN** the reference SHALL preserve the assistance state
- **AND** the dashboard SHALL show that browser control is unavailable rather than implying that the owner can complete the action through a missing stream

#### Scenario: Route-resolved browser target is used
- **WHEN** a current no-response browser-surface assistance request is backed by a ready leased browser surface
- **THEN** the streaming session SHALL use the route-resolved browser target for that assistance request
- **AND** it SHALL NOT fall back to a legacy registry lookup that can drop the leased browser surface and produce a dead stream.
