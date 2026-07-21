## ADDED Requirements

### Requirement: Runtime SHALL govern recoverable detail work through a connector-neutral recovery governor

The polyfill runtime SHALL treat durable recoverable detail gaps as recovery
work items governed across runs. A connector-local per-run cap MAY stop the
current run, but it SHALL NOT be the mechanism by which an owner drains a
backlog. Remaining eligible work SHALL remain queued with attempt metadata and,
when applicable, a next eligible attempt time.

#### Scenario: Per-run cap defers remaining detail work

- **WHEN** a connector reaches a configured per-run detail-attempt cap while
  recoverable detail gaps remain
- **THEN** the runtime SHALL preserve the remaining gaps as queued recovery work
- **AND** it SHALL NOT require the owner to start repeated immediate runs to
  continue draining that backlog
- **AND** the deferral SHALL NOT be treated as source pressure.

#### Scenario: Recovery resumes from durable gaps

- **WHEN** a later eligible run starts for the same connection
- **AND** durable pending detail gaps exist for in-scope streams
- **THEN** the runtime SHALL make those gaps available for recovery before or
  apart from forward collection
- **AND** it SHALL preserve attempt metadata across recovery pages and runs.

### Requirement: Recovery attempts SHALL use one provider work-domain admission path

Each recovery attempt that touches an upstream provider SHALL pass through a
single provider work-domain admission path before the provider is contacted.
Retries and ordinary owner-started reruns SHALL pass through the same admission
path. The runtime SHALL NOT compose independent pre-flight waiters over the same
provider work domain.

#### Scenario: Manual retry respects provider cooldown

- **WHEN** a connection has pending recovery work whose provider work domain is
  cooling down until a future `next_attempt_after`
- **AND** the owner starts an ordinary retry or refresh
- **THEN** the runtime SHALL decline to start provider work before that time
- **AND** it SHALL return the next eligible time rather than bypassing the
  cooldown.

#### Scenario: Retry does not bypass the send governor

- **WHEN** a recovery attempt fails with a retryable provider response
- **AND** a retry is attempted within the same run
- **THEN** the retry SHALL pass through the same provider work-domain admission
  path as the original attempt.

#### Scenario: Provider work domains are isolated

- **WHEN** recovery work for provider domain A is cooling down
- **THEN** recovery work for unrelated provider domain B SHALL NOT be delayed
  solely because provider domain A is cooling down.

### Requirement: Recovery outcomes SHALL be classified before scheduling or owner projection

The runtime SHALL normalize recovery attempt outcomes into scheduling classes
before they affect cross-run scheduling or owner-facing projection. Planned run
caps, retry exhaustion, temporary unavailability, source pressure, owner-required
repair, and connector defects SHALL remain distinct.

#### Scenario: Planned run cap is not source pressure

- **WHEN** recovery stops because a run cap, wall-clock cap, or retry-budget cap
  was reached
- **THEN** the remaining work SHALL be classified as planned resumable recovery
- **AND** it SHALL NOT arm the source-pressure cooldown governor.

#### Scenario: Provider pressure arms cooldown

- **WHEN** recovery observes a provider pressure signal such as rate limiting or
  upstream pressure
- **THEN** the affected work domain SHALL receive a cooldown or next eligible
  attempt time
- **AND** future automatic and ordinary manual attempts SHALL respect that
  timing.

#### Scenario: Repeated deterministic no-progress becomes connector issue

- **WHEN** the same recovery class repeatedly fails without provider-pressure or
  owner-required evidence
- **THEN** the runtime SHALL stop presenting the work as owner-drainable retry
- **AND** it SHALL surface a connector/system issue with diagnostic capture when
  capture is available.

### Requirement: Browser recovery SHALL share the recovery seam without inheriting API rate policy

Browser-backed recovery attempts SHALL enter the same connector-neutral recovery
admission seam as API-backed attempts, but the browser policy SHALL remain
distinct from API AIMD rate policy. Browser recovery SHALL be serial by default,
SHALL NOT perform unattended owner-interactive auth repair, and SHALL classify
challenge, session, and deterministic DOM failures before retrying.

#### Scenario: Browser recovery does not open unattended auth repair

- **WHEN** an unattended browser-backed recovery run cannot reuse the existing
  authenticated session
- **THEN** the connector SHALL classify the run as owner-required session repair
  or system issue
- **AND** it SHALL NOT submit credentials, request OTP, or open an interactive
  owner browser handoff inside the unattended recovery run.

#### Scenario: Browser recovery uses conservative serial provider work

- **WHEN** a browser-backed connector recovers detail gaps
- **THEN** provider-touching recovery attempts SHALL be serial unless a later
  accepted connector policy explicitly allows concurrency
- **AND** successful attempts SHALL NOT by themselves authorize automatic
  speed-up beyond the configured browser policy.

### Requirement: The connector-runtime source boundary SHALL carry a stable attach-exhaustion code through DONE.error.code, not just message text

A managed browser surface can pass pre-flight readiness (`run.browser_surface_ready`, verified in `reference-implementation-runtime`) and still wedge mid-run: the allocator and CDP HTTP metadata endpoints keep answering, but the underlying browser session is dead, so `connectOverCDP`'s auto-attach races Patchright's floated `setRequestInterception` against a transient n.eko target teardown (`Network.setCacheDisabled ... session closed`). `connectOverCdpWithRetry` (`packages/polyfill-connectors/src/browser-launch.ts`) already retries this narrow, well-understood race with a bounded attempt budget. The connector runtime SHALL carry a stable, machine-actionable `code` (`browser_surface_attach_exhausted`) on the `TerminalError` it raises when that budget is exhausted, through `DONE.error.code`, so downstream layers never have to re-parse the connector error's message text to learn the same fact.

This code SHALL survive a connector's own `normalizeTerminalError` override even when that override only destructures `{ message, retryable }` and returns a fresh object with no `code` — that is data loss, not a deliberate choice, because the connector never had the chance to see or reject a code it never destructured. A connector's own deliberate `code` (e.g. `credential_rejected`) on the normalized result SHALL still take precedence; the infrastructure code only backfills a `code` field the normalizer left empty.

#### Scenario: connectOverCdpWithRetry tags exhaustion of the narrow attach-session race

- **WHEN** `connectOverCdpWithRetry` exhausts its bounded `maxAttempts` retrying the narrow CDP attach-session race (`isCdpAttachSessionRaceError`)
- **THEN** it SHALL throw a typed error carrying `code: "browser_surface_attach_exhausted"`
- **AND** a different failure (auth, unreachable endpoint, real browser crash) SHALL be rethrown with its original identity, untagged.

#### Scenario: The typed code reaches DONE.error.code

- **WHEN** the connector runtime's `acquireBrowser` catches the typed attach-exhaustion error from `connectOverCdpWithRetry`
- **THEN** it SHALL construct its `TerminalError` with that same stable `code`
- **AND** the terminal `DONE.error` the connector emits SHALL carry that `code` unless a connector's own `normalizeTerminalError` explicitly set a different `code`.

#### Scenario: A connector-supplied normalizeTerminalError cannot silently drop the code

- **WHEN** a connector's `normalizeTerminalError` destructures only `{ message, retryable }` and returns a fresh object with no `code` (the current shape of every connector normalizer, including ChatGPT's)
- **THEN** the runtime SHALL backfill the infrastructure `code` onto the normalized result before emitting `DONE.error`
- **AND** a connector-chosen `code` already present on the normalized result SHALL NOT be overwritten.

### Requirement: Recovery progress SHALL be observable without exposing record payloads

The runtime SHALL expose owner-only recovery progress as counts, floors, timing,
and classes. It SHALL NOT expose record payloads, provider credentials, raw
URLs, or detail locators in owner summary surfaces.

#### Scenario: Recovery backlog count is bounded

- **WHEN** the runtime reads pending recovery work through a bounded read
- **AND** the read reaches its bound
- **THEN** the owner projection SHALL mark the count as a floor
- **AND** owner UI SHALL NOT present it as an exact total.

#### Scenario: Recovery progress omits payloads

- **WHEN** recovery progress is shown on an owner surface
- **THEN** it MAY include counts, next eligible time, last progress time, stream
  id, and recovery class
- **AND** it SHALL NOT include record contents, credentials, or raw provider
  page payloads.

### Requirement: Source-pressure cooldown SHALL NOT starve non-pressure recovery

A source-pressure cooldown armed by provider-pressure-classified work SHALL gate
only provider-pressure retry timing within its work domain. It SHALL NOT by
itself make queued non-pressure recovery work ineligible, and it SHALL NOT by
itself defer the entire dispatch for a connection that has eligible non-pressure
recovery work. Pressure classifications SHALL re-arm a cooldown only from fresh
pressure evidence; residual pressure-classified rows without fresh evidence
SHALL NOT hold a domain in indefinite cooldown.

#### Scenario: Pressure minority does not hold non-pressure majority

- **WHEN** a work domain has queued recovery items classified as provider
  pressure with a future eligible time
- **AND** the same connection has queued recovery items whose classes are not
  provider pressure
- **THEN** the scheduler SHALL still consider the non-pressure items when
  deciding envelope eligibility
- **AND** the non-pressure items SHALL remain drainable on normal recovery
  cadence while pressure-class retries wait for their eligible time.

#### Scenario: Cooldown expiry resumes recovery without owner action

- **WHEN** a provider-pressure cooldown reaches its expiry
- **AND** eligible recovery work remains queued
- **THEN** automatic recovery SHALL resume on the next eligible envelope
- **AND** no owner click SHALL be required to resume it.

#### Scenario: Stale pressure classifications do not re-arm cooldown

- **WHEN** a work domain holds old pressure-classified rows
- **AND** no fresh provider-pressure evidence has been observed within the
  cooldown evidence window
- **THEN** those residual rows SHALL NOT re-arm the domain cooldown on their own.

### Requirement: Runtime SHALL continue eligible recovery without owner action

The runtime scheduler SHALL admit eligible queued recovery work into recovery
envelopes on its normal cadence without owner action. Queued recovery SHALL be a
live scheduling state, not a passive label. When eligible work receives no
attempt within the expected cadence window, the runtime SHALL surface that stall
as an observable system condition rather than leaving the queue silently idle.

#### Scenario: Eligible queued work is self-scheduled

- **WHEN** durable recovery work is eligible now
- **AND** no provider cooldown, owner-required repair, or system issue blocks it
- **THEN** the scheduler SHALL admit a recovery envelope for it within the
  connection's normal cadence
- **AND** draining SHALL NOT depend on owner-initiated runs.

#### Scenario: Owner-started recovery continues after durable queue progress

- **WHEN** an owner-started run resolves one or more durable detail gaps by
  recovering them or terminalizing/quarantining poison items
- **AND** eligible non-pressure recovery work remains queued for the same
  connection
- **THEN** the runtime SHALL start a bounded recovery-only continuation envelope
  without requiring another owner gesture
- **AND** it SHALL stop continuation when the run makes no durable queue
  progress or the remaining work is blocked by cooldown, owner-required repair,
  or a system issue.

#### Scenario: Stalled eligibility becomes observable

- **WHEN** eligible queued recovery work has received no attempt for longer than
  the expected cadence window
- **THEN** the runtime SHALL record the stall as a system condition with the
  blocking evidence it has
- **AND** the condition SHALL be visible to owner-only diagnostics rather than
  presented as normal queued progress.

#### Scenario: Recovery and forward collection share the envelope without starvation

- **WHEN** a connection has both eligible recovery work and eligible forward
  collection
- **THEN** envelope admission SHALL give each a bounded share over successive
  envelopes
- **AND** neither SHALL be indefinitely deferred by the other.

### Requirement: Existing eligible recovery work SHALL take priority over starting new forward-walk work for an implicit, unscoped run

When a connection has eligible non-source-pressure recovery work queued, an
envelope that would otherwise begin new forward-walk work — a scheduled tick
that is due, or a manual/owner-triggered run that is IMPLICIT and UNSCOPED
(no explicit `recoveryOnly` choice, and no caller-requested resource/stream
scope) — SHALL launch as a bounded recovery-only envelope instead, draining
the existing backlog before any fresh forward-walk envelope starts for that
connection. This applies uniformly to the scheduler's automatic dispatch and
to `controller.runNow`'s default work selection for implicit, unscoped runs —
one connector-neutral policy consumed by both call sites, not two
independently-authored rules that can drift apart. Forward-walk collection
resumes on its ordinary eligibility once no eligible recovery work remains.

Two things express genuine caller work intent and are never overridden by
this priority:

- An explicit `recoveryOnly` choice (either value) from the caller.
- A caller-requested resource/stream scope (e.g. a targeted channel or
  account backfill): scoping a run to specific resources is forward work
  intent by construction and must never be silently reinterpreted as
  recovery-only.

A "force" override (bypassing the provider-pressure cooldown gate) carries no
work-mode meaning and is NOT a basis for skipping recovery priority: a forced
run with no other explicit intent still prefers eligible recovery work
exactly like an unforced one. Force and recovery priority are orthogonal —
force answers "may this run start now despite pressure timing," recovery
priority answers "should this run drain the backlog or start fresh forward
work," and a caller must set both independently if it wants a forced run that
also skips the backlog (an explicit `recoveryOnly: false`).

This corrects a starvation gap the original "bounded share over successive
envelopes" framing left open: a tick or manual run where forward-walk was
independently already due always launched forward collection first, because
neither seam consulted existing recovery work when ordinary eligibility was
already satisfied. Live evidence: a Gmail connection with 10,264 pending
non-pressure attachment gaps had a due manual/ordinary run claim a fresh
forward-walk page and make no bounded-recovery progress for over 5 minutes
while the backlog sat untouched, because ordinary forward-walk eligibility
alone was sufficient to launch forward collection regardless of the queued
recovery backlog.

#### Scenario: A due scheduled tick with an eligible recovery backlog launches recovery-only

- **WHEN** a connector's scheduled tick is due for ordinary forward-walk
  dispatch
- **AND** eligible non-source-pressure recovery work is queued for the same
  connection
- **THEN** the scheduler SHALL launch a bounded recovery-only envelope for that
  tick instead of a fresh forward-walk envelope.

#### Scenario: A due scheduled tick with no recovery backlog launches ordinary forward-walk

- **WHEN** a connector's scheduled tick is due for ordinary forward-walk
  dispatch
- **AND** no eligible non-source-pressure recovery work is queued
- **THEN** the scheduler SHALL launch ordinary forward-walk collection.

#### Scenario: An implicit, unscoped manual run with an eligible recovery backlog launches recovery-only

- **WHEN** an owner or owner-agent starts a manual run without an explicit
  `recoveryOnly` choice and without a resource/stream scope
- **AND** eligible non-source-pressure recovery work is queued for the same
  connection
- **THEN** the controller SHALL launch that run as a bounded recovery-only
  envelope, regardless of whether a force override was also passed.

#### Scenario: An implicit, unscoped manual run with no recovery backlog launches ordinary forward-walk

- **WHEN** an owner or owner-agent starts a manual run without an explicit
  `recoveryOnly` choice and without a resource/stream scope
- **AND** no eligible non-source-pressure recovery work is queued
- **THEN** the controller SHALL launch ordinary forward-walk collection,
  regardless of whether a force override was also passed.

#### Scenario: An explicit recoveryOnly choice is never coerced by recovery priority or by force

- **WHEN** a caller explicitly requests recovery-only or explicitly requests
  forward-walk (`recoveryOnly: false`), with or without a force override
- **THEN** the runtime SHALL honor that explicit choice
- **AND** it SHALL NOT re-evaluate or override it against the recovery
  backlog.

#### Scenario: A caller-requested resource/stream scope is never coerced into recovery-only

- **WHEN** a caller starts a manual run with an explicit resource/stream scope
  and no explicit `recoveryOnly` choice
- **AND** eligible non-source-pressure recovery work is queued for the same
  connection
- **THEN** the controller SHALL launch ordinary forward-walk collection scoped
  to the requested resources
- **AND** it SHALL NOT silently convert the run to recovery-only.

#### Scenario: A force override alone does not disable recovery priority

- **WHEN** a caller passes a force override (bypassing the provider-pressure
  cooldown gate) with no explicit `recoveryOnly` choice and no resource/stream
  scope
- **AND** eligible non-source-pressure recovery work is queued for the same
  connection
- **THEN** the controller SHALL still launch that run as a bounded
  recovery-only envelope
- **AND** force SHALL NOT be interpreted as an implicit forward-only or
  recovery-disabling choice.

#### Scenario: A blocked connection never launches recovery under this priority rule

- **WHEN** a connection's recommended health state is blocked
- **THEN** neither the scheduler nor a manual run SHALL launch a recovery-only
  envelope under this priority rule
- **AND** the existing blocked-owner gating SHALL take precedence over
  recovery priority.

### Requirement: Recovery attempts SHALL be idempotent and crash-accounted

Re-attempting a recovery item SHALL NOT duplicate emitted records; recovered
records SHALL deduplicate on their durable identity. Attempt accounting SHALL
survive interruption: an attempt that starts and is interrupted SHALL count
against the item's attempt metadata, and repeated interruption of the same item
SHALL escalate through the same no-progress path as repeated deterministic
failure.

#### Scenario: Re-attempt does not duplicate records

- **WHEN** a recovery attempt emitted a record but its gap state update did not
  complete
- **AND** a later envelope re-attempts the same item
- **THEN** the re-attempt SHALL NOT produce a duplicate record visible to reads.

#### Scenario: Interrupted attempts are counted

- **WHEN** a recovery attempt is interrupted by a crash, timeout, or kill before
  classification
- **THEN** the item's attempt metadata SHALL reflect that an attempt occurred
- **AND** repeated interruption SHALL escalate to connector/system issue rather
  than retrying indefinitely.

### Requirement: Persistently failing items are quarantined individually

The runtime SHALL quarantine a single recovery item that repeatedly fails
deterministically while sibling items make progress, assigning it a terminal
class and captured evidence instead of letting it consume recovery budget
indefinitely or block the rest of the backlog. Quarantined items SHALL remain
visible in recovery accounting; they SHALL NOT be silently dropped.

#### Scenario: Poison item does not block the backlog

- **WHEN** one item reaches its per-item no-progress threshold
- **AND** other queued items in the same domain are making progress
- **THEN** the runtime SHALL quarantine the failing item with evidence
- **AND** subsequent envelopes SHALL continue draining the remaining backlog.

#### Scenario: Quarantine is visible, not silent

- **WHEN** items are quarantined
- **THEN** recovery progress accounting SHALL include a quarantined class and
  count
- **AND** owner-only diagnostics SHALL expose the per-item evidence trail.

#### Scenario: Quarantined items can be deliberately retried after repair

- **WHEN** a quarantined item is terminal because it exhausted its no-progress
  budget
- **AND** an operator explicitly requeues that quarantined class after a
  connector or runtime repair
- **THEN** the runtime SHALL move only the scoped quarantined items back to
  pending recovery with a fresh no-progress budget
- **AND** it SHALL preserve bounded evidence that the prior terminal state was
  a quarantine retry
- **AND** it SHALL NOT requeue terminal rows whose reason is a permanent
  unavailable class such as `not_found`, `gone`, or `permanent_forbidden`.

### Requirement: Recovery admission decisions SHALL be observable

Each recovery admission decision SHALL be recorded with its outcome, reason
class, and next eligible time when applicable, queryable from owner-only
diagnostics. Force admissions SHALL be distinguishable from normal admissions in
that record. A force path SHALL NOT unlock unattended owner-interactive auth
repair regardless of who initiated it.

#### Scenario: Denials carry machine-readable reasons

- **WHEN** the governor declines to admit recovery work
- **THEN** the decision record SHALL carry the reason class and, when known, the
  next eligible time
- **AND** owner-only diagnostics SHALL be able to answer why the most recent
  attempt did not run.

#### Scenario: Force is audited and bounded

- **WHEN** an explicit force path admits work past a cooldown
- **THEN** the admission record SHALL mark it as forced with its initiator
- **AND** the forced run SHALL still refuse unattended owner-interactive auth
  repair.
