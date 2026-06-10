## ADDED Requirements

### Requirement: Reference schedules SHALL express desired freshness without causing manual-attention retry storms

Reference schedules SHALL express desired data freshness and launch eligibility for a connection/source. A due schedule SHALL NOT be interpreted as a guarantee that every due instant creates a run.

#### Scenario: Due schedule is blocked by unresolved attention

- **WHEN** a connection schedule becomes due
- **AND** an equivalent unresolved attention request exists for that connection/source
- **THEN** the reference scheduler SHALL NOT start another automatic run for that schedule
- **AND** it SHALL record or expose that the schedule was skipped, paused, or suppressed because owner/operator attention remains unresolved
- **AND** the connection SHALL preserve an explicit operator path to resume, run now, or re-enable automatic scheduling after the attention request is resolved

#### Scenario: Freshness intent remains visible while launch is suppressed

- **WHEN** a schedule is paused or suppressed because owner/operator attention is required
- **THEN** the reference SHALL continue to expose the desired freshness policy separately from the current launch eligibility
- **AND** it SHALL NOT report the connection as fresh merely because automatic launches are suppressed

#### Scenario: Resolved attention does not replay an unbounded schedule backlog

- **WHEN** a schedule has missed one or more due instants while launch was paused or suppressed for owner/operator attention
- **AND** the attention request is resolved or explicitly overridden
- **THEN** the reference SHALL NOT automatically start one run for every missed due instant
- **AND** it SHALL make the schedule eligible for the next normal launch or at most one latest-state catch-up run by default
- **AND** any broader backfill SHALL be explicit, bounded, and available only when the connector declares safe interval semantics

### Requirement: Reference runs SHALL be bounded attempts when owner/operator attention is required

Reference runs SHALL remain bounded execution attempts. A run that discovers a required owner/operator action SHALL finish with a typed waiting-for-operator outcome or equivalent terminal evidence rather than remaining active indefinitely.

#### Scenario: Run creates durable attention evidence

- **WHEN** a run cannot proceed without owner/operator action such as login, OTP, account review, consent, filesystem availability, or device availability
- **THEN** the run SHALL finish as a bounded attempt
- **AND** the reference SHALL create or update a durable typed attention request linked to the connection/source and the run evidence when available
- **AND** the run outcome SHALL be distinguishable from retryable infrastructure failure and terminal connector failure

#### Scenario: Manual attention does not hide partial data state

- **WHEN** a run produces usable data but cannot fully complete without owner/operator action
- **THEN** the reference MAY expose a succeeded-with-gaps outcome
- **AND** it SHALL preserve attention evidence for the missing action
- **AND** it SHALL NOT require another automatic run until the unresolved action is resolved or explicitly overridden

### Requirement: Reference attention requests SHALL be durable, typed, notified, and resumable

The reference SHALL model owner/operator attention as a durable typed request keyed to connection/source and optionally linked to a run. The request SHALL include enough policy state to notify the owner safely, suppress duplicate noise, and resume intentionally.

#### Scenario: Attention request captures the operator contract

- **WHEN** the reference creates or updates an attention request
- **THEN** the request SHALL include a machine-readable reason
- **AND** it SHALL include safe human-readable instructions that do not expose secrets
- **AND** it SHALL include status, creation time, last-observed time, optional expiry or review time, and a resume action or re-enable path
- **AND** it SHALL include notification state and quiet-hour or suppression metadata sufficient to avoid repeated noisy notifications

#### Scenario: Equivalent attention is deduplicated per connection

- **WHEN** repeated attempts encounter the same unresolved owner/operator requirement for a connection/source
- **THEN** the reference SHALL update or reuse the existing attention request instead of creating unbounded duplicate requests
- **AND** suppression for that request SHALL apply only to the affected connection/source unless the operator explicitly chooses a broader scope

### Requirement: Reference notification policy SHALL avoid silent failures and noisy repeats

The reference SHALL surface manual-attention requirements through explicit notification policy. It SHALL avoid both silent suppression and repeated unresolved alerts. Notification delivery state SHALL be persisted on the durable attention record so the operator console can answer "did we tell the owner?" without rereading transport logs.

#### Scenario: Owner is notified with bounded repetition

- **WHEN** a new attention request requires owner/operator action
- **THEN** the reference SHALL mark notification as pending, sent, suppressed, failed, or acknowledged according to delivery outcome
- **AND** the notification state SHALL be a durable axis on the attention record, persisted alongside lifecycle and updated by the notification fanout path even when delivery is short-circuited (channel unavailable, no opted-in subscription, policy-suppressed)
- **AND** repeated notifications for the same unresolved request SHALL be governed by quiet-hour and suppression policy
- **AND** the reference SHALL keep the request visible until it is resolved, expired, or intentionally dismissed

#### Scenario: Notification failure does not cause a run storm

- **WHEN** notification delivery fails for an attention request
- **THEN** the reference SHALL preserve the unresolved attention request and notification failure state
- **AND** the durable attention record SHALL record `notification_state: failed` without changing `lifecycle`, so the projection continues to surface needs_attention
- **AND** it SHALL NOT treat notification failure as permission to repeatedly launch the same scheduled run

#### Scenario: Owner-side acknowledgement is recorded as a notification outcome

- **WHEN** the owner advances an attention prompt past `open` (lifecycle transitions to `acknowledged` or `in_progress`)
- **THEN** the durable notification state SHALL be updated to `acknowledged`
- **AND** the operator console SHALL be able to distinguish "we delivered the push" from "the owner has seen the prompt" without inspecting transport logs

#### Scenario: Operator-visible notification state degrades honestly when evidence is missing

- **WHEN** the projection has no structured attention record and is falling back to the schedule's `human_attention_needed` flag
- **THEN** the operator-visible notification state for that CTA SHALL be null (unknown)
- **AND** the dashboard SHALL NOT fabricate a `sent`/`pending` claim that the durable evidence cannot support

### Requirement: Reference local collector scheduling SHALL remain host-supervisor-owned

The reference SHALL keep server schedule policy separate from local collector host supervision. Server-side schedule intent MAY inform local collector diagnostics or prompts, but it SHALL NOT claim control over host-local timing, filesystem availability, or device wake behavior.

#### Scenario: Local collector requires host action

- **WHEN** a local collector cannot run because the device, filesystem, credentials, or host supervisor requires action
- **THEN** the reference MAY create or expose an attention request or diagnostic
- **AND** server schedules SHALL NOT repeatedly launch remote attempts that cannot control the local host condition
- **AND** the remediation path SHALL identify the local collector or host supervisor as the action owner
