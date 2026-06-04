## ADDED Requirements

### Requirement: Run timeline envelope SHALL expose a window-independent terminal status

The reference run-timeline endpoint `GET /_ref/runs/{run_id}/timeline` SHALL include a `terminal_status` field in its response envelope. The value SHALL be one of `completed`, `failed`, `cancelled`, or `abandoned` when the run has recorded a terminal spine event (`run.completed`, `run.failed`, `run.cancelled`, `run.abandoned` respectively), and `null` when the run has no terminal event. The value SHALL be derived from the run's most-recent terminal spine event and SHALL NOT depend on the `limit` or `cursor` of the request — a consumer reading any single page SHALL receive the same `terminal_status`.

The terminal-status lookup SHALL NOT require scanning the run's full event list; it SHALL use the bounded most-recent-terminal-event query. The field applies to the run timeline kind; trace and grant timelines are unaffected.

#### Scenario: Long run reports terminal status on the first page

- **WHEN** a run has more events than the requested `limit` and its terminal event is beyond the first page
- **THEN** the first-page timeline response SHALL include `terminal_status` set to the run's terminal class
- **AND** the value SHALL be identical for any page or `limit` of the same run

#### Scenario: In-progress run reports null terminal status

- **WHEN** a run has no terminal spine event
- **THEN** the timeline response SHALL include `terminal_status: null`

#### Scenario: Consumer determines liveness without paging to the tail

- **WHEN** a consumer needs to know whether a run is still active
- **THEN** it SHALL be able to read `terminal_status` from a single timeline page response
- **AND** it SHALL NOT need to page through the timeline to find the terminal event

### Requirement: Run detail surface SHALL determine liveness from the envelope terminal status

The operator console run detail surface SHALL determine whether a run is active from the timeline envelope's `terminal_status` field, not from scanning a single page of events. The active/terminal decision that drives the run status badge, the live-update poller's enabled state, and the active-run cancel control SHALL be `terminal_status == null`.

#### Scenario: Terminal run past the first page renders as terminal

- **WHEN** the run detail page renders a run whose `terminal_status` is non-null but whose terminal event is not within the fetched event page
- **THEN** the page SHALL show the terminal status badge for that run
- **AND** SHALL NOT render the active-run cancel control
- **AND** SHALL NOT keep the live poller enabled
