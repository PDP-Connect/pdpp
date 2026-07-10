## MODIFIED Requirements

### Requirement: Assistance attachments are optional and typed
The reference runtime SHALL model browser streaming, URLs, QR codes, file prompts, and fixtures as optional typed attachments to an assistance request. The generic assistance contract SHALL NOT expose Playwright `Page`, CDP WebSocket URLs, n.eko stream URLs, or other browser-control implementation details as generic assistance fields.

Owner-facing assistance copy and delivery surfaces SHALL remain concise and instruction-shaped. They SHALL NOT embed raw connector diagnostics such as input probes, body previews, or internal request URLs in the owner instruction string. Detailed diagnostics MAY remain available as connector diagnostics, terminal errors, or other bounded diagnostic evidence, but the owner-facing assistance message and any push copy derived from it SHALL stay on the task the owner must perform.
When owner-facing assistance includes a typed exact-sync target, the CTA label SHALL remain the existing owner instruction string and SHALL NOT be rewritten into a generic run noun or raw run id label.

#### Scenario: Browser control is required

- **WHEN** a connector requires the owner to operate a live browser page
- **THEN** the reference SHALL represent the assistance as progress posture `blocked`, owner action `operate_attachment`, and response obligation `response_required`
- **AND** the assistance SHALL include a `browser_surface` attachment or explicitly report that no browser surface is available

#### Scenario: Non-browser connector uses a URL or QR attachment

- **WHEN** a connector that is not Playwright-driven asks the owner to open a URL or scan a QR code
- **THEN** the reference SHALL represent the URL or QR code as an attachment
- **AND** the assistance SHALL remain valid without any browser-surface attachment

#### Scenario: Assistance copy stays concise while diagnostics stay separate

- **WHEN** a connector needs to surface manual-action assistance and also has connector diagnostics such as a request URL, input probe list, or body preview
- **THEN** the owner-facing assistance message SHALL describe only the action the owner must take
- **AND** the connector diagnostics SHALL remain available outside the owner instruction string
- **AND** the owner-facing push copy SHALL not include raw diagnostic telemetry

#### Scenario: Exact sync links keep a concise CTA

- **WHEN** owner-facing assistance renders a typed exact-sync target
- **THEN** the CTA label SHALL remain the existing owner instruction string
- **AND** the CTA label SHALL NOT expose the raw run id or a generic run noun

### Requirement: Assistance lifecycle is durable and redacted

The reference runtime SHALL expose assistance request, resolution, timeout, cancellation, and escalation transitions in the reference run timeline using safe machine-readable metadata. The reference runtime SHALL NOT persist submitted secrets, raw bearer URLs, durable credentials, or sensitive attachment payloads.

#### Scenario: Background auth repair is required but not attempted

- **WHEN** a non-manual run detects that a source session is inactive and that repair requires owner participation
- **THEN** the run SHALL record bounded terminal evidence that classifies the failure as credential or source-session repair
- **AND** the run SHALL NOT emit repeated owner assistance or interaction prompts from the automatic path

#### Scenario: Connector diagnostics are kept out of owner help text

- **WHEN** a connector emits manual-action assistance after probing a failure condition
- **THEN** the owner-facing instruction text SHALL omit raw diagnostic probes and previews
- **AND** the detailed failure evidence SHALL remain in diagnostics or terminal run evidence
