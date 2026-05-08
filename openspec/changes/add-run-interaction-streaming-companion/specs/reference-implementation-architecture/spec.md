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

- **WHEN** the owner requests a streaming session on a reference deployment that has no CDP companion configured (no `PDPP_RUN_INTERACTION_CDP_WS_URL`, no `PDPP_RUN_INTERACTION_CDP_HTTP_URL`, and no injected companion factory)
- **THEN** the mint endpoint SHALL respond with `503 streaming_companion_unavailable`
- **AND** the response SHALL name the configuration the operator must set
- **AND** the dashboard SHALL render a configuration-pointer state instead of the streaming canvas

### Requirement: n.eko streaming preserves an owner-controlled browser UX

When the reference implementation uses n.eko as a streaming backend, it SHALL keep the sidecar behind the same stream-token lifecycle while presenting the owner with an embedded browser-control surface rather than a general n.eko room UI. The n.eko surface SHOULD use direct n.eko client integration when available so the reference can preserve native input, clipboard, focus, and geometry behavior without exposing n.eko product controls.

#### Scenario: The owner opens a n.eko-backed stream

- **WHEN** the stream companion selects the n.eko backend for a pending manual action
- **THEN** the dashboard SHALL render the n.eko browser surface through the token-scoped same-origin proxy
- **AND** it SHALL suppress n.eko branding, resolution menus, and non-essential room chrome in the embedded owner view
- **AND** the sidecar SHALL NOT be reachable without the scoped stream token or stream proxy cookie

#### Scenario: The owner resizes or rotates the viewer

- **WHEN** the n.eko-backed viewer viewport changes size or mobile/touch characteristics
- **THEN** the reference SHOULD preserve geometry agreement between the visible browser viewport, n.eko's screen model, and input coordinates
- **AND** it SHOULD use exact 1:1 dimensions when n.eko/X11/Chromium can represent them
- **AND** otherwise it SHOULD use local crop/remap only for residual capture gutters rather than arbitrary stretching
- **AND** the reference SHOULD propagate the new dimensions to n.eko screen configuration and Chromium window bounds where those control paths are available
- **AND** failures in those best-effort control paths SHALL NOT expose unrelated browser authority or invalidate the stream token

#### Scenario: The owner pastes text into the remote browser

- **WHEN** the owner pastes text while using a n.eko-backed stream
- **THEN** the reference SHOULD preserve the native same-origin n.eko clipboard/input path
- **AND** any explicit fallback paste bridge SHALL route pasted text only to the scoped browser interaction
- **AND** the reference SHOULD NOT mirror mobile IME text-entry echoes into the owner's local clipboard

#### Scenario: The owner focuses a remote text field from a phone

- **WHEN** a non-strict n.eko-backed stream detects that the remote page focused an editable element
- **THEN** the dashboard SHOULD focus n.eko's owner-side keyboard overlay so the mobile software keyboard opens
- **AND** when the remote page blurs the editable element, the dashboard SHOULD blur the overlay so the software keyboard can dismiss
- **AND** strict browser-owner mode SHALL still work without requiring that page-level focus bridge

#### Scenario: A stealth-sensitive n.eko stream is opened

- **WHEN** a n.eko stream is marked stealth-sensitive or browser-owner-managed
- **THEN** the reference SHALL NOT require page-level CDP scripts, Runtime bindings, or CDP paste helpers for baseline viewing and input
- **AND** browser fingerprint controls such as user agent, client hints, device scale, touch capability, proxy, and profile SHALL be owned by the browser launch/profile boundary rather than silently mutated by the viewer mid-page
- **AND** any page-level helper SHALL be gated behind an explicit assistive mode or equivalent operator choice

### Requirement: Stream viewer control policy is replayable

The reference implementation SHALL keep stream viewer protocol parsing,
viewport classification, keyboard-occlusion policy, and media-settle policy
observable through pure, replayable modules. The React viewer SHALL remain
responsible for DOM lifecycle and side effects, but SHOULD NOT be the only
place where stream control decisions can be observed or tested.

#### Scenario: A mobile viewport emits transient resize events

- **WHEN** the owner opens a stream on a mobile browser and browser chrome,
  orientation, or software keyboard events change viewport geometry
- **THEN** the reference SHOULD classify the observed layout viewport, visual
  viewport, focus intent, and orientation facts before POSTing a remote viewport
- **AND** it SHOULD avoid resizing the remote browser for keyboard occlusion
  alone
- **AND** it SHOULD hold local presentation remaps during orientation and
  browser-chrome settle so transient dimensions are not shown as stretched
  stream frames
- **AND** it SHOULD make the classification replayable from redacted telemetry

#### Scenario: A n.eko resize is requested

- **WHEN** the viewer requests a new n.eko-backed viewport size
- **THEN** the reference SHOULD distinguish the requested viewport from the
  n.eko screen status, media intrinsic size, and WebRTC inbound frame size
- **AND** it MAY request bounded high-DPR n.eko screen/capture dimensions
  separately from the CSS viewport dimensions when the viewer display would
  otherwise upscale the decoded media
- **AND** it SHOULD avoid treating the stream as visually settled until those
  facts agree or a degraded state is diagnosed
