# reference-implementation-architecture Specification Delta

## ADDED Requirements

### Requirement: Stream reach give-up records a typed failure class

The reference implementation SHALL classify a stream-reach give-up into a typed
reason rather than reporting only a generic network failure when the stream
viewer's pre-attach retry loop gives up reaching a run-interaction browser
stream. Because the browser `EventSource` collapses every pre-attach HTTP status
into a payload-less error, the reference SHALL read the actual attach status with
a single token-scoped status probe before classifying. The typed reason SHALL be
drawn from a closed set and SHALL NOT include connector secrets, the stream
token, the stream proxy cookie, or raw viewer URLs.

#### Scenario: The attach loop gives up against a dead token

- **WHEN** the stream viewer exhausts its pre-attach reconnect attempts without a
  successful attach
- **THEN** the reference SHALL issue one token-scoped `GET` status probe against
  the same viewer URL to read the attach HTTP status the `EventSource` hid
- **AND** it SHALL classify the give-up as one of `invalid_token`,
  `session_consumed`, `session_expired`, `companion_unavailable`,
  `unreachable_origin`, or `unknown`
- **AND** it SHALL show the operator a message naming that failure class
- **AND** it SHALL NOT claim the stream connected or recovered

#### Scenario: The status probe cannot classify the failure

- **WHEN** the give-up status probe returns a status outside the recognized set,
  or the probe request itself fails before any HTTP status is read
- **THEN** the reference SHALL classify the give-up as `unreachable_origin` when
  the probe request failed to reach the server, otherwise `unknown`
- **AND** the operator message for `unknown` SHALL be no less informative than the
  prior generic give-up message
- **AND** the classification SHALL NOT fabricate a more specific reason than the
  probe evidence supports

#### Scenario: The status probe does not consume a still-valid session

- **WHEN** the give-up status probe runs against a stream token
- **THEN** the probe SHALL only read the attach response status and SHALL release
  the probe connection without invalidating the streaming session
- **AND** the probe SHALL NOT mint, supersede, or alter the streaming session
  beyond the reconnect-safe attach the viewer already performs

### Requirement: Stream reach failures are recorded on the run spine

The reference implementation SHALL record a stream-reach give-up as a bounded
`run.stream_reach_failed` spine event so the failure class is auditable from the
run timeline. The event SHALL be emitted through an owner-authenticated reference
route, scoped to the current run and interaction, and SHALL carry only the typed
reason and the observed HTTP status. The route SHALL clamp the reported reason to
the recognized closed set so a malformed or hostile client cannot write an
arbitrary reason into the spine.

#### Scenario: A classified give-up is reported

- **WHEN** the stream viewer classifies a give-up into a typed reason
- **THEN** the reference SHALL accept an owner-authenticated give-up beacon for the
  current run and interaction
- **AND** it SHALL emit `run.stream_reach_failed` carrying the typed reason and the
  observed HTTP status
- **AND** the event data SHALL NOT contain the stream token, stream proxy cookie,
  or raw viewer URL

#### Scenario: A give-up beacon reports an unrecognized reason

- **WHEN** a give-up beacon reports a reason outside the recognized closed set
- **THEN** the reference SHALL record the reason as `unknown` rather than the
  client-supplied string
- **AND** it SHALL still emit `run.stream_reach_failed` so the give-up remains
  auditable

#### Scenario: A give-up beacon targets a run or interaction that is not current

- **WHEN** a give-up beacon names a run or interaction that does not match a known
  run-interaction pairing
- **THEN** the reference SHALL reject the beacon
- **AND** it SHALL NOT emit a `run.stream_reach_failed` event for the mismatched
  identifiers
