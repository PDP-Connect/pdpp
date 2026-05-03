## ADDED Requirements

### Requirement: Streaming interaction sessions are reference-only and interaction-scoped

The reference implementation SHALL treat browser streaming as a reference-only control-plane companion for pending run interactions. Streaming sessions SHALL be scoped to one pending run interaction and SHALL NOT authorize record reads, consent approval, grant issuance, collector ingest, or unrelated browser access.

#### Scenario: A pending manual action needs browser control

- **WHEN** a connector run reaches a pending interaction that requires browser control
- **THEN** the reference MAY mint a short-lived streaming session link for the owner
- **AND** the link SHALL be scoped to the current run and interaction
- **AND** the link SHALL expire or be invalidated when the interaction resolves, is cancelled, or the run ends

#### Scenario: A stale stream link is opened

- **WHEN** a streaming link is expired, already consumed, bound to a non-current interaction, or bound to a completed run
- **THEN** the reference SHALL refuse the stream
- **AND** it SHALL show an owner-actionable terminal state without exposing connector secrets or browser state

### Requirement: Streaming control does not replace collector or owner credentials

The reference implementation SHALL keep streaming session authority separate from collector credentials and owner tokens. A streaming session SHALL only authorize viewing and input for the scoped browser interaction.

#### Scenario: A stream viewer sends input

- **WHEN** a stream viewer sends mouse, keyboard, touch, or resize input
- **THEN** the reference SHALL route that input only to the browser session associated with the scoped pending interaction
- **AND** it SHALL NOT treat the streaming token as an owner session, collector device token, or client grant token

### Requirement: CDP is the default streaming implementation path

The reference implementation SHOULD use CDP screencast frames and CDP input events for the first streaming companion implementation. Heavier remote-browser substrates SHALL NOT be introduced unless a concrete connector case proves CDP insufficient.

#### Scenario: The owner opens the stream on a mobile device

- **WHEN** the stream viewer starts from a mobile-sized device
- **THEN** the reference SHALL size or map the browser viewport and input coordinates so the owner can complete the pending interaction from that device class
- **AND** it SHALL document unsupported controls such as multi-touch gestures if they are not implemented

### Requirement: Streaming companion fails closed when unconfigured

The reference implementation SHALL refuse to mint a streaming session token when no streaming companion is configured. It SHALL NOT issue a token that only fails at attach time, because that surfaces as a dead primary action in the dashboard with no operator-actionable error.

#### Scenario: The owner opens the stream on a server with no CDP companion configured

- **WHEN** the owner requests a streaming session on a reference deployment that has no CDP companion configured (no `PDPP_RUN_INTERACTION_CDP_WS_URL` and no injected companion factory)
- **THEN** the mint endpoint SHALL respond with `503 streaming_companion_unavailable`
- **AND** the response SHALL name the configuration the operator must set
- **AND** the dashboard SHALL render a configuration-pointer state instead of the streaming canvas

