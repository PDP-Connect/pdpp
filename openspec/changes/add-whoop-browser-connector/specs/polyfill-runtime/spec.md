## ADDED Requirements

### Requirement: The WHOOP connector SHALL use an owner-authenticated isolated browser session without receiving owner credentials

The WHOOP connector SHALL declare the existing browser binding as required and
use a WHOOP-specific persistent browser profile. On an owner-started run with
no valid session, it SHALL use the existing generic browser handoff for owner
login and SHALL re-probe source truth before collection. It SHALL NOT accept,
persist, or emit the owner's WHOOP username, password, access token, refresh
token, session cookie, or browser storage. An unattended refresh SHALL be
session-reuse-only and SHALL NOT initiate interactive login.

#### Scenario: Owner completes manual WHOOP login

- **WHEN** an owner-started run finds no authenticated WHOOP browser session
- **AND** the owner signs in through the bound browser handoff
- **THEN** the connector SHALL re-probe WHOOP in that browser context
- **AND** it SHALL collect only after the probe proves an authenticated session

#### Scenario: Unattended refresh has no valid WHOOP session

- **WHEN** an unattended run cannot prove a valid WHOOP browser session
- **THEN** the connector SHALL report owner repair required without opening an
  interactive login handoff
- **AND** it SHALL NOT emit successful empty collection or advance stream state

### Requirement: The WHOOP connector SHALL collect six validated owner-data streams from the authenticated web source

The WHOOP connector SHALL expose profile, body, cycles, recoveries, sleeps, and
workouts as independently requestable streams. It SHALL perform source requests
inside the bound browser context, validate every record before emission, retain
stable WHOOP-owned record identities, and advance each stream cursor only after
emitting the records covered by that cursor. Initial collection SHALL walk all
history exposed by the source using bounded source pagination or date ranges.

#### Scenario: Owner requests a subset of WHOOP streams

- **WHEN** a collection request names one or more supported WHOOP streams
- **THEN** the connector SHALL request and emit only those streams
- **AND** each emitted record SHALL satisfy the schema declared for its stream

#### Scenario: WHOOP returns multiple pages or bounded history ranges

- **WHEN** a requested historical stream advertises additional data
- **THEN** the connector SHALL continue through the advertised pages or ranges
- **AND** it SHALL emit cursor state only after the covered records are emitted

### Requirement: The WHOOP connector SHALL fail closed on authentication loss, provider pressure, or source drift

The WHOOP connector SHALL classify 401/403 as authentication loss, 429 as rate
limiting, and other non-success responses, invalid JSON, unexpected response
shapes, or incomplete pagination as source failures. It SHALL NOT translate any
of those conditions into successful empty collection, completed history, or an
advanced cursor.

#### Scenario: Authenticated request loses authorization

- **WHEN** a WHOOP source request returns 401 or 403
- **THEN** the connector SHALL fail with owner-authentication repair evidence
- **AND** it SHALL NOT advance the affected stream cursor

#### Scenario: WHOOP source response drifts

- **WHEN** a WHOOP endpoint returns invalid JSON or data that does not satisfy
  the expected source or emitted-record schema
- **THEN** the connector SHALL surface source drift as a failed run or explicit
  diagnostic result
- **AND** it SHALL NOT fabricate records or successful completion
