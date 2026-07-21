## MODIFIED Requirements

### Requirement: A backend/session transition's viewport measurement SHALL describe the incoming surface, never an outgoing one

When the console's stream viewer requests a viewport measurement immediately
after a backend/session transition (e.g. n.eko's `backend_ready`), the
measurement SHALL read the container of the surface the transition is about
to describe, not whichever surface was rendered before the transition.

#### Scenario: Desktop controlling attachment does not echo a letterboxed placeholder

- **WHEN** a desktop operator (viewport 1400x1005, hasTouch=false) attaches
  and n.eko's `backend_ready` fires for a NEW `browser_session_id`
- **AND** the CDP placeholder surface (or any prior surface) is still
  attached to the DOM at that instant
- **THEN** the viewport measurement SHALL be deferred until the new
  `browser_session_id`'s own surface container attaches
- **AND** the posted viewport SHALL equal the desktop stage's box, never the
  prior surface's letterboxed box

#### Scenario: A same-session backend_ready replay measures immediately

- **WHEN** `backend_ready` fires again for a `browser_session_id` that
  already matches the currently-attached surface (an EventSource
  auto-reconnect replay; the surface's React key is unchanged and its
  container will not re-attach)
- **THEN** the viewport measurement SHALL happen immediately, synchronously,
  without deferring
- **AND** no request SHALL be left pending afterward

#### Scenario: A superseded transition never drains against a later, unrelated attach

- **WHEN** a transition requests a deferred measurement for
  `browser_session_id` A
- **AND** a second transition requests a deferred measurement for a
  different `browser_session_id` B before A's surface ever attached
- **THEN** A's request SHALL be discarded, not carried forward
- **AND** only an attach tagged with B's key SHALL drain a measurement
