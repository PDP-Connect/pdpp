## MODIFIED Requirements

### Requirement: Scheduler SHALL preserve runtime results and avoid unsafe retries

The reference scheduler SHALL preserve runtime result metadata in history, stats, and completion callbacks while preventing overlapping runs for the same connector and avoiding retries for deterministic failures. The reference attention read model SHALL NOT surface expired non-terminal owner-action rows as current unresolved attention.

#### Scenario: Run succeeds

- **WHEN** a scheduled connector run succeeds
- **THEN** the scheduler SHALL record status, source, run id, trace id, record count, checkpoint summary, known gaps, and connector state returned by the runtime
- **AND** scheduler stats SHALL expose the same last-run projection

#### Scenario: Failure is retryable

- **WHEN** a connector-declared failure is retryable or the runtime failure is a retryable rate-limit or transient server failure
- **THEN** the scheduler SHALL retry up to the configured retry limit
- **AND** it SHALL use bounded exponential backoff between attempts
- **AND** it SHALL record the succeeding or terminal attempt number

#### Scenario: Failure is deterministic

- **WHEN** the runtime reports a connector protocol violation, authentication error, permission error, deterministic grant lifecycle error, deterministic connector-invalid error, or the connector declares `retryable: false`
- **THEN** the scheduler SHALL NOT retry that run
- **AND** it SHALL preserve the failure reason, terminal reason, connector error summary, checkpoint summary, and known gaps

#### Scenario: Connector already has an active scheduled run

- **WHEN** a schedule tick fires while the same connector has an active scheduled run
- **THEN** the scheduler SHALL NOT start an overlapping connector process

#### Scenario: Scheduler stops during retry backoff

- **WHEN** the scheduler is stopped while a retryable failure is waiting for backoff
- **THEN** it SHALL NOT launch the next retry attempt

#### Scenario: Scheduled run requires human attention

- **WHEN** an automatic scheduled run reaches a pending interaction that requires credentials, OTP, or manual browser action
- **THEN** the scheduler SHALL avoid repeatedly launching new automatic attempts for the same unresolved condition
- **AND** schedule state SHALL explain that human attention is needed

#### Scenario: Expired manual action is stale after later success

- **WHEN** an older failed run leaves an open `manual_action_required` attention row whose `expires_at` is at or before the attention read clock
- **AND** a later run for the same connector instance succeeds
- **THEN** the reference attention read model SHALL NOT return the expired row as open unresolved attention
- **AND** the later successful run SHALL NOT be projected as needing current owner attention solely because of that expired row

#### Scenario: Policy delays or skips a run

- **WHEN** refresh policy, backoff, overlap prevention, or human-attention state prevents a scheduled run from starting
- **THEN** the reference SHALL preserve an inspectable skip or delay reason in schedule/run history
- **AND** manual `run now` SHALL remain available unless the connector is already active
