## ADDED Requirements

### Requirement: A managed dynamic surface diagnosed attach-exhausted after readiness passed SHALL be recycled within the existing retry budget

The controller SHALL detect a managed dynamic browser surface that passed pre-flight readiness (`run.browser_surface_ready`) but wedged mid-run — the allocator reports the container healthy and CDP HTTP metadata endpoints (`json/version`, `json/list`) keep answering, while the underlying browser session is dead, so the connector's attach-session work fails before any record or progress is emitted — and SHALL recycle that surface so the next acquire cannot re-lease it. This is a distinct failure shape from the pre-flight readiness probe (which already reacquires once — see the reacquire path proven by task 5.6) and from mid-wait interaction-loss detection (which only covers `manual_action`/`otp` waits and is carried on the interaction-specific `run.browser_surface_lost` event).

The controller SHALL detect this shape from a single typed field: `connector_error.code === "browser_surface_attach_exhausted"`, set at the connector-runtime source boundary (`polyfill-runtime`'s `connectOverCdpWithRetry`) and carried unmodified through `DONE.error.code`. The controller SHALL NOT re-parse `connector_error.message` to re-derive this disposition — the textual classification happens exactly once, at the source boundary that actually knows the retry budget was exhausted.

When the typed code is present on a pre-progress failure (`records_emitted: 0`) for a `dynamic`-mode surface, the controller SHALL let the existing scheduler retry budget acquire a fresh surface for the next attempt. The controller SHALL NOT invent a second retry state machine for this case: it reuses the existing scheduler retry-classification (`retry_by_runtime`) and readiness-reacquire mechanisms rather than adding new backoff/state.

#### Scenario: Typed browser_surface_attach_exhausted code on a dynamic surface recycles the surface

- **WHEN** a managed connector run on a `dynamic`-mode browser surface terminates with `records_emitted: 0` and `connector_error.code === "browser_surface_attach_exhausted"`
- **THEN** the controller SHALL invalidate the leased surface in the in-memory lease manager so it cannot be re-leased
- **AND** it SHALL request the allocator stop the underlying dynamic container
- **AND** it SHALL emit a dedicated typed event (`run.browser_surface_invalidated`) carrying the lease projection and a stable, controller-authored `browser_surface_probe` code/detail — never the raw, unbounded connector error text (which is already persisted once, bounded, on the run's own terminal event) and never fabricated interaction fields (`interaction_id`, `kind` remain specific to the existing interaction-loss event, `run.browser_surface_lost`)
- **AND** the next scheduled or continuation attempt for the same connection SHALL acquire a fresh surface rather than the recycled one.

#### Scenario: The same error text without the typed code does not recycle the surface

- **WHEN** a managed connector run's terminal connector error message matches the browser-profile attach/session-closed text, but `connector_error.code` is not `"browser_surface_attach_exhausted"` (for example an older connector build that predates this code, or a different failure that happens to share wording)
- **THEN** the controller SHALL NOT invalidate or stop the surface, because it never re-derives the disposition from message text itself
- **AND** the surface SHALL remain leaseable by a following run.

#### Scenario: Reacquire is bounded, not an infinite rerun

- **WHEN** the attach-exhausted surface recycling above fires
- **THEN** the controller SHALL rely on the existing scheduler retry budget (`maxRetries`) to bound the number of fresh-surface attempts for that run
- **AND** repeated attach exhaustion across the retry budget SHALL exhaust into the existing terminal-failure path rather than looping indefinitely against newly acquired surfaces.

#### Scenario: Static/operator-owned surfaces are never destroyed

- **WHEN** the same typed `browser_surface_attach_exhausted` code occurs on a `static`-mode (operator-owned) surface
- **THEN** the controller SHALL NOT invalidate the surface entry, call allocator stop/destroy, or emit `run.browser_surface_invalidated`
- **AND** the run SHALL still be retryable against the same operator-owned surface, failing safely rather than destructively.

#### Scenario: Unrelated connector failures do not trigger surface recycling

- **WHEN** a managed dynamic-surface run fails for a reason other than `connector_error.code === "browser_surface_attach_exhausted"` (for example a credential rejection, grant failure, or connector parser defect)
- **THEN** the controller SHALL NOT invalidate or stop the surface
- **AND** existing terminal classification and owner-required/connector-defect handling SHALL proceed unchanged.

#### Scenario: A post-progress failure does not recycle the surface

- **WHEN** a managed dynamic-surface run carries the typed `browser_surface_attach_exhausted` code but `records_emitted` is greater than zero
- **THEN** the controller SHALL NOT invalidate or stop the surface, because the failure is out of scope for this pre-progress recycling path.

#### Scenario: Owner cancellation and event ordering are preserved

- **WHEN** the attach-exhausted surface recycling fires during normal terminal-event handling
- **THEN** it SHALL NOT alter owner-cancellation semantics, terminal-reason classification, or the existing spine event ordering: the run's own terminal event (`run.failed`) is already recorded before the controller evaluates this signal, `run.browser_surface_invalidated` (when emitted) follows it, and `run.browser_surface_released` still follows lease release in cleanup.
