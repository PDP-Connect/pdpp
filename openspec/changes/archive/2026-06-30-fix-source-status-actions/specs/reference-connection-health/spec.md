## MODIFIED Requirements

### Requirement: Owner actions SHALL be a typed required-action list with derived terminality and one unified satisfaction contract

The rendered verdict's primary required action SHALL remain the single action source consumed by owner surfaces. Owner surfaces SHALL NOT replace an owner-runnable required action with a generic run control. Owner surfaces SHALL render run-start controls only for required-action kinds that actually start a run from that surface, and SHALL route other owner-runnable actions to the appropriate detail flow.

When a server action starts or reports an existing run, the owner surface SHALL expose a concrete run-detail link whenever a run id is present. It SHALL preserve the full run id string returned or named by the server.

#### Scenario: Owner-runnable non-run action is not rendered as generic sync

**WHEN** a source verdict's primary required action is owner-runnable but is not `refresh_now` or `retry_gap`
**THEN** the Sources view renders it as a detail hint using the server-owned CTA
**AND** the Sources view SHALL NOT render a generic `Sync now` button for that action.

#### Scenario: Run-start result links to the concrete run

**WHEN** the owner starts a run or the server reports a run is already active
**THEN** the Sources view shows the run-start result inline
**AND** when a run id is present, the result links to that run's detail route while preserving the full run id.

### Requirement: The forward statement SHALL be derived from the disposition and required actions and SHALL NOT contradict them

When a connection has terminal coverage gaps but current evidence proves the latest collection succeeded and the snapshot is degraded rather than blocked, the rendered verdict SHALL keep the coverage gap visible while avoiding total-failure copy. The pill SHALL render as degraded, and the forward statement SHALL describe known coverage gaps without claiming that collection failed to run or that a future run recovers terminal data.

#### Scenario: Successful terminal coverage is degraded review, not total failure

**WHEN** a connection snapshot is degraded, has terminal coverage, and carries a current `CollectionSucceeded=true` condition
**THEN** the rendered verdict pill is `Degraded`
**AND** the primary maintainer-status action uses coverage-review copy rather than generic connector-code-fix copy
**AND** the forward statement says the latest collection completed with known coverage gaps
**AND** the verdict SHALL NOT claim that a retry, refresh, or next run recovers the terminal coverage gap.

## ADDED Requirements

### Requirement: Owner console SHALL consume the server-owned verdict without leaking local state across sources

The Sources view SHALL key source-detail state by the selected source identity so row-local toasts, confirmation ceremonies, and transient action state from one source cannot appear on another source after selection changes.

#### Scenario: Selecting another source clears local action state

**WHEN** the owner switches the selected source in the Sources view
**THEN** the rendered source-detail component remounts for the new source identity
**AND** transient local state from the previously selected source is not shown on the new source.
