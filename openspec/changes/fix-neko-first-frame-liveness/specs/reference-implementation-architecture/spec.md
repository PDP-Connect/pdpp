## MODIFIED Requirements

### Requirement: n.eko streaming preserves an owner-controlled browser UX

When the reference implementation uses n.eko as a streaming backend, it SHALL keep the sidecar behind the same stream-token lifecycle while presenting the owner with an embedded browser-control surface rather than a general n.eko room UI. A managed n.eko surface SHALL carry its own validated window-settle endpoint, and the reference SHALL not mark a presentation restored, resume collection, or release its lease until baseline geometry has settled or the surface has been retired. The n.eko surface SHOULD use direct n.eko client integration when available so the reference can preserve native input, clipboard, focus, and geometry behavior without exposing n.eko product controls. Routine n.eko assistive browser control SHALL use a Patchright-mediated browser-client seam rather than adapter-owned raw page-CDP helper commands; strict/browser-owner mode SHALL remain usable for baseline viewing and input without a page-level browser attach. The adapter SHALL NOT promote a frame that represents a presentation epoch whose screen geometry has not been acknowledged. When a fetched frame is stale after the presentation-mutation tail settles, the adapter SHALL coalesce replacement delivery to the latest presentation epoch and make at most one immediate replacement fetch in that polling cycle.

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

#### Scenario: A managed connector is configured by canonical connector URL

- **WHEN** `PDPP_NEKO_MANAGED_CONNECTORS` names a connector by its canonical `/connectors/{connector_id}` URL
- **AND** the run source identifies the same connector by short `connector_id`
- **THEN** the reference SHALL treat the run as managed by the n.eko browser-surface pool
- **AND** it SHALL acquire or queue a browser-surface lease before spawning the connector child

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
- **AND** the reference SHOULD propagate the new dimensions to n.eko screen configuration and to Patchright-owned page viewport controls where those control paths are available
- **AND** failures in those best-effort control paths SHALL NOT expose unrelated browser authority or invalidate the stream token

#### Scenario: A stale first frame follows a settled presentation change

- **WHEN** a JPEG fetched for an earlier presentation epoch reaches the delivery gate after a newer epoch has settled
- **THEN** the reference SHALL discard the earlier JPEG
- **AND** it SHALL fetch a replacement for the latest epoch before the normal poll delay
- **AND** it SHALL promote only that replacement after its epoch remains current at the acknowledgement gate

#### Scenario: Viewport churn exceeds one presentation change

- **WHEN** a fixed number of viewport oscillations occur while a JPEG for an earlier epoch is in flight and the newest epoch settles
- **THEN** the reference SHALL promote a frame for the newest epoch within two fetches from that polling cycle
- **AND** it SHALL NOT queue one replacement fetch per oscillation or retry recursively after the bounded replacement is stale

#### Scenario: The owner pastes text into the remote browser

- **WHEN** the owner pastes text while using a n.eko-backed stream
- **THEN** the reference SHOULD preserve the native same-origin n.eko clipboard/input path
- **AND** any explicit fallback paste bridge SHALL route pasted text only to the scoped browser interaction
- **AND** the reference SHOULD NOT mirror mobile IME text-entry echoes into the owner's local clipboard

#### Scenario: The owner focuses a remote text field from a phone

- **WHEN** an assistive n.eko-backed stream detects that the remote page focused an editable element
- **THEN** the dashboard SHOULD focus n.eko's owner-side keyboard overlay so the mobile software keyboard opens
- **AND** when the remote page blurs the editable element, the dashboard SHOULD blur the overlay so the software keyboard can dismiss
- **AND** strict browser-owner mode SHALL still work without requiring that page-level focus bridge

#### Scenario: Assistive n.eko browser control uses the Patchright seam

- **WHEN** a n.eko-backed stream is in assistive mode and needs page navigation, page viewport sizing, page status, focus bridging, copy, or paste helpers
- **THEN** the reference SHALL perform those operations through the Patchright-mediated browser-client seam
- **AND** the n.eko adapter SHALL NOT open its own page-target WebSocket for those routine controls
- **AND** the n.eko adapter SHALL NOT send `Runtime.enable`, `Runtime.addBinding`, direct `Page.addScriptToEvaluateOnNewDocument`, `Browser.setWindowBounds`, `Emulation.setUserAgentOverride`, or direct device/touch emulation commands for those routine controls

#### Scenario: Balanced n.eko mode is accepted for compatibility

- **WHEN** existing configuration requests n.eko `balanced` mode
- **THEN** the reference SHALL treat it as the assistive Patchright-mediated path or reject it with an operator-actionable compatibility message
- **AND** it SHALL NOT preserve `balanced` as a third browser-control posture with a separate raw-CDP helper path

#### Scenario: A stealth-sensitive n.eko stream is opened

- **WHEN** a n.eko stream is marked stealth-sensitive or browser-owner-managed
- **THEN** the reference SHALL NOT require page-level CDP scripts, Runtime bindings, or CDP paste helpers for baseline viewing and input
- **AND** browser fingerprint controls such as user agent, client hints, device scale, touch capability, proxy, and profile SHALL be owned by the browser launch/profile boundary rather than silently mutated by the viewer mid-page
- **AND** any page-level helper SHALL be gated behind explicit assistive mode or equivalent operator choice

#### Scenario: A local non-n.eko browser-backed connector launches

- **WHEN** a browser-backed connector runs without a managed n.eko browser-surface lease
- **THEN** the reference SHALL prefer Patchright's bundled Chromium unless the operator explicitly configures a browser channel override
- **AND** the reference SHALL keep the explicit browser channel override as an operator compatibility control rather than silently preferring branded Chrome
- **AND** the local launch path SHALL preserve Patchright-owned launch defaults instead of duplicating n.eko-specific X11/window flags
