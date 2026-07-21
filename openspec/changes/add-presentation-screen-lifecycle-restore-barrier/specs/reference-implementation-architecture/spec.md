## MODIFIED Requirements

### Requirement: n.eko streaming preserves an owner-controlled browser UX

When the reference implementation uses n.eko as a streaming backend, it SHALL
keep the sidecar behind the same stream-token lifecycle while presenting the
owner with an embedded browser-control surface rather than a general n.eko room
UI. The n.eko surface SHOULD use direct n.eko client integration when available
so the reference can preserve native input, clipboard, focus, and geometry
behavior without exposing n.eko product controls. Routine n.eko assistive
browser control SHALL use a Patchright-mediated browser-client seam rather than
adapter-owned raw page-CDP helper commands; strict/browser-owner mode SHALL
remain usable for baseline viewing and input without a page-level browser
attach.

Presentation-driven n.eko screen changes SHALL capture the pre-presentation
screen configuration exactly once before the first mutation and SHALL serialize
capture, apply, rotation, and restoration under one lease-scoped presentation
epoch. A stale epoch operation SHALL NOT mutate the screen. The controlling
stream attachment alone SHALL be permitted to request a screen resize; an
observer attachment SHALL NOT change shared screen geometry.

Terminal interaction handling SHALL restore the captured baseline before
connector work can resume. If restore cannot succeed, the reference SHALL
recycle a replaceable managed surface or terminal the affected run safely; it
SHALL NOT continue on presentation-mutated geometry. Startup reconciliation
SHALL restore, recycle, or block reuse of every captured-but-unrestored managed
surface before admitting it to another run.

The presentation terminalization identity SHALL remain available independently
of an expiring stream bearer record until restoration or recovery completes.
Bearer expiry, invalidation, and supersession SHALL enter the same terminal
barrier; they SHALL NOT merely remove authentication metadata while a mutated
presentation remains active.

#### Scenario: The first presentation mutation captures a baseline

- **WHEN** a controlling attachment first applies or rotates a n.eko screen
- **THEN** the reference SHALL read and persist the current screen
  configuration before its first screen mutation
- **AND** an SSE reconnect for the same presentation SHALL NOT capture a new
  baseline.

#### Scenario: Concurrent viewport changes are fenced

- **WHEN** concurrent controlling-attachment viewport updates and terminal
  restoration are submitted for one presentation
- **THEN** their screen mutations SHALL run as one ordered stream
- **AND** an operation queued under an older epoch SHALL be discarded before it
  can mutate the screen.

#### Scenario: An observer posts a viewport

- **WHEN** a non-controlling stream attachment posts a viewport update
- **THEN** the reference SHALL reject the screen mutation with a typed
  attachment-control error
- **AND** the observer MAY continue using the scoped viewer for allowed
  non-geometry operations.

#### Scenario: An interaction resolves after presentation geometry changed

- **WHEN** an interaction resolves, is cancelled, times out, or its stream
  session is invalidated after baseline capture
- **THEN** the reference SHALL restore the baseline before resolving the
  connector's pending interaction
- **AND** on restore failure it SHALL recycle the managed surface or terminal
  the run without resuming connector automation.

#### Scenario: A response arrives after the stream bearer expires

- **WHEN** a presentation stream bearer has expired but its interaction later
  resolves, is cancelled, or times out
- **THEN** the reference SHALL find the presentation terminalization identity
  without consulting the expired bearer record
- **AND** it SHALL await restoration or recovery before connector work can
  resume.

#### Scenario: The reference restarts with an unrestored baseline

- **WHEN** startup reconciliation finds a managed surface with a captured but
  unrestored presentation baseline
- **THEN** the reference SHALL restore or recycle that surface before it can be
  leased again
- **AND** it SHALL NOT silently classify the surface as ready for reuse.
