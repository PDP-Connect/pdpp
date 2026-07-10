## MODIFIED Requirements

### Requirement: Connection Health SHALL Preserve Evidence Before Projection

The reference implementation SHALL model connection health as raw facts normalized into typed conditions and then into a derived projection.

Stored-credential-presence evidence SHALL be connection-binding-scoped: it applies only to a connection that is bound as static-secret. For such a connection the credential-readiness condition SHALL distinguish "no usable stored credential" from "stored credential rejected" as durable connection evidence, derived from credential-presence evidence rather than inferred solely from a transient run reason code; both project as an owner reauth/capture action, with non-conflated reason and copy. A connection bound as a browser session SHALL NOT project a "no usable stored credential" condition from an absent credential row, because it authenticates by owner-authenticated browser session rather than a stored credential. A credential-readiness or session-readiness condition SHALL NOT project the connection healthy or idle merely because a credential-shaped run reason code aged out; it SHALL remain derived from durable evidence until readiness is proven.

Credential/session remediation metadata SHALL include a bounded owner-action surface that tells owner surfaces which repair path to open. Stored-credential missing or rejected evidence SHALL project the `stored_credential` surface. Session-required evidence SHALL project the `browser_session` surface unless stronger evidence proves the stored credential itself was rejected. Provider-side prompts SHALL project `provider_interaction`; local collector/device repair SHALL project `local_device`; retry, schedule, maintainer, and no-action states SHALL project non-secret non-navigation surfaces.

#### Scenario: Browser-session-required failure routes to browser-session repair

**WHEN** a run failure reason proves that the provider browser session is required or inactive
**AND** there is no stronger evidence that the stored credential itself was provider-rejected
**THEN** the reference implementation SHALL record a `CredentialsValid` or session-readiness condition with an owner-action surface of `browser_session`
**AND** the projected required action SHALL carry the same surface
**AND** owner surfaces SHALL route the action to browser/session repair rather than static-secret credential capture.

#### Scenario: Flattened terminal auth gaps preserve the repair surface

**WHEN** a terminal run has a generic failure reason
**AND** its known-gap evidence proves a provider browser-session-required failure
**THEN** the reference implementation SHALL preserve the session-required reason when projecting connection health
**AND** it SHALL NOT collapse the condition to stored-credential repair.

#### Scenario: Stored credential evidence routes to stored-credential repair

**WHEN** a static-secret-bound connection has no usable stored credential or has a definitive provider credential rejection
**THEN** the reference implementation SHALL record a credential-readiness condition with an owner-action surface of `stored_credential`
**AND** owner surfaces SHALL route the action to stored credential capture or update for the existing connection
**AND** they SHALL NOT open browser-session repair for that condition.

#### Scenario: Provider interaction is not credential replacement

**WHEN** current evidence proves that the owner must approve a provider prompt, complete an OTP, consent, or challenge outside stored credential capture
**THEN** the reference implementation SHALL project an owner-action surface of `provider_interaction`
**AND** owner surfaces SHALL NOT label the action as stored-credential update unless stored-credential rejection evidence is also present.

### Requirement: Connection repair state SHALL be evidence-derived and connection-scoped

The reference implementation SHALL derive current repair state for a connection from typed evidence such as credential validity, provider-grant validity, browser-session readiness, local-collector health, runtime-binding availability, run assistance, coverage gaps, and satisfied required actions. A run may create evidence, but the repaired object SHALL be the existing connection.

Repair state SHALL NOT be closed solely because a run ended, an owner-action row aged out, or a connector-specific status string disappeared. A connection may stop showing an old prompt when it expires or is superseded, but it SHALL NOT be projected healthy until current evidence proves readiness or the relevant issue no longer applies.

A durable attention row is current owner-action evidence only when it is open, unexpired, owner-satisfiable, not superseded by newer evidence for the same connection generation, and has a required action with a non-`none` satisfaction contract. Expired, resolved, or cancelled rows SHALL remain available as history but SHALL NOT drive the primary CTA, headline attention count, or scheduler suppression.

Repair actions SHALL be scoped by `connection_id` / `connector_instance_id`, not by `connector_id` alone. If two connections use the same connector type, each connection SHALL preserve its own binding, schedule, repair surface, and post-repair confirmation outcome.

#### Scenario: Owner repairs the same connection

**WHEN** the owner satisfies a reauthorization, credential rotation, browser-session repair, local-collector repair, or recoverable-gap action
**THEN** the reference SHALL attach the repair evidence to the same `connection_id`
**AND** it SHALL preserve that connection's schedules, grants, stored credential identity, records, retained stream state, and run history unless the owner explicitly creates a new connection.

#### Scenario: Old repair prompt expires without proof

**WHEN** an owner-action prompt expires or is superseded without evidence that the connection is ready
**THEN** the expired prompt SHALL NOT remain the dominant current action
**AND** the connection SHALL still project any unresolved readiness, credential, session, coverage, or local-device condition that remains current.

#### Scenario: Resolved prompt is history after repair evidence

**WHEN** an owner-action prompt is resolved and newer evidence proves the corresponding connection readiness condition is satisfied
**THEN** the prompt SHALL remain available as historical attention evidence
**AND** it SHALL NOT appear in the current owner-action list
**AND** it SHALL NOT suppress scheduled automation.

#### Scenario: Duplicate connector instances do not share repair state

**WHEN** two active connections use the same connector type
**AND** one connection has a browser-session repair action while the other has no current repair action
**THEN** owner surfaces, scheduler checks, and repair routes SHALL use the connection identity to select the correct repair state
**AND** they SHALL NOT apply the first connection's action, schedule, or repair surface to the second connection.

#### Scenario: Browser-session repair is not password storage

**WHEN** the owner repairs a browser-session connection by logging in through the secure browser
**THEN** the reference implementation MAY capture the browser session state needed for that connector
**AND** it SHALL NOT silently persist the password typed into the provider page as a stored credential.

### Requirement: Owner actions SHALL be a typed required-action list with derived terminality and one unified satisfaction contract

The rendered verdict's primary required action SHALL remain the single action source consumed by owner surfaces. Owner surfaces SHALL NOT replace an owner-runnable required action with a generic run control. Owner surfaces SHALL render run-start controls only for required-action kinds that actually start a run from that surface, and SHALL route other owner-runnable actions to the appropriate detail flow.

Each owner-runnable required action SHALL include enough typed data for all owner surfaces and automation gates to make the same decision: action kind, audience, urgency/channel, owner-action surface, satisfaction contract, connection identity, and safe copy. The owner-action surface selects the repair route; the satisfaction contract defines when the action is complete; the connection identity selects which configured source is repaired.

#### Scenario: Repair action includes route and satisfaction facts

**WHEN** the rendered verdict contains a current owner-runnable repair action
**THEN** the action SHALL identify the action kind, owner-action surface, `satisfied_when` contract, and connection identity
**AND** owner surfaces SHALL NOT need connector-specific string matching or connector-level manifest capability inference to route the repair.

#### Scenario: Owner-runnable non-run action is not rendered as generic sync

**WHEN** a source verdict's primary required action is owner-runnable but is not `refresh_now` or `retry_gap`
**THEN** the Sources view renders it as a detail hint using the server-owned CTA
**AND** the Sources view SHALL NOT render a generic `Sync now` button for that action.

#### Scenario: Credential and session repairs have one label each

**WHEN** a connection requires stored-credential repair
**THEN** owner surfaces SHALL use credential capture or update copy for that action.

**WHEN** a connection requires browser-session repair
**THEN** owner surfaces SHALL use browser/session reconnect copy for that action.

**WHEN** one condition drives one required action
**THEN** owner surfaces SHALL NOT render competing buttons that imply two different repairs for the same underlying condition.

### Requirement: Owner Surfaces SHALL Share One Projection Contract

Dashboard, CLI, and owner-control-plane API surfaces SHALL consume the same connection health projection and condition contract.

Owner-console surfaces that classify connection status or owner actionability SHALL use a shared actionability projection over the server-owned rendered verdict. A surface MAY render a different layout or join additional surface-specific data, but it SHALL NOT independently decide whether the primary action is owner-satisfiable, whether the connection requires owner action now, or whether a source belongs in owner-required, review, system-issue, or checking work.

Owner surfaces that render a repair link for a required action SHALL use the rendered action's owner-action surface when it is present. They SHALL NOT choose between static-secret credential capture, browser-session repair, provider interaction, or local-device recovery from connector-level manifest capability alone. A surface MAY keep a compatibility fallback for older reference payloads that do not include the action surface.

A rendered `reauth` action's satisfaction contract SHALL match its repair mechanism. Only a `stored_credential` reauth has an owner-supplied credential to observe, so it alone SHALL be satisfied by that credential becoming present and unrejected. Every other reauth surface — `browser_session` today, and any future non-stored-credential repair mechanism — has no stored credential for the reference to observe, so it SHALL be satisfied by a confirming run succeeding instead. The reference SHALL NOT require a stored credential to satisfy a browser-session (or other non-stored-credential) repair, which would leave a credential-less connection permanently unsatisfiable.

#### Scenario: Repair link uses the rendered action surface

**WHEN** a rendered required action has `kind=reauth` and an owner-action surface of `stored_credential`
**THEN** the owner console SHALL route the action to stored credential update/capture for the existing connection
**AND** the action's satisfaction contract SHALL require the stored credential to become present and unrejected.

**WHEN** a rendered required action has `kind=reauth` and an owner-action surface of `browser_session`
**THEN** the owner console SHALL route the action to browser-session repair for the existing connection
**AND** the action's satisfaction contract SHALL be a confirming run succeeding, not stored-credential presence.

#### Scenario: Current browser repair stream is actionable

**WHEN** the current repair action is browser-session repair
**AND** the repair run is preparing, waiting for browser assistance, or registering a browser surface
**THEN** owner-facing stream surfaces SHALL continue to present the browser repair as current work
**AND** they SHALL NOT strand the owner on generic "no browser action is waiting" copy.

#### Scenario: Browser surface cannot be registered

**WHEN** a current browser-session repair cannot register or mint a browser surface
**THEN** the repair surface SHALL report the browser-surface failure directly
**AND** the owner console SHALL preserve the same repair action rather than presenting an unrelated credential update or a dead stream page.

### Requirement: Unattended repair SHALL defer owner-mediated actions

Scheduled and otherwise unattended runs SHALL NOT initiate owner-mediated repair actions that require active owner participation. They SHALL record evidence that the existing connection needs repair and allow the connection-health projection to surface the appropriate owner action.

Scheduled automation SHALL consult the same rendered owner-action projection before launching. When the current rendered verdict has an urgent owner-satisfiable repair action (`reauth` or `add_info`) whose satisfaction contract is not `none`, the scheduler SHALL treat that action as unresolved owner attention and skip the automatic run until the action is satisfied. It SHALL NOT require an in-memory needs-human flag or a separate structured-attention row for the same terminal run evidence. Non-blocking owner accelerants such as `refresh_now` and `retry_gap` SHALL NOT suppress automation.

#### Scenario: Scheduled run needs a browser login

**WHEN** a scheduled run detects that collection cannot proceed without owner browser operation
**THEN** it SHALL record bounded repair-required evidence for the connection
**AND** it SHALL NOT open an owner browser session, ask for a password, request OTP, or create repeated interactive prompts from the scheduled path.

#### Scenario: Automation respects rendered owner repair actions

**WHEN** the current rendered verdict for a scheduled connection carries an urgent owner-satisfiable repair action
**THEN** the scheduler SHALL treat that rendered action as unresolved owner action and skip the automatic run
**AND** it SHALL NOT require an in-memory needs-human flag or a separate structured-attention row for the same terminal run evidence.

**WHEN** the current rendered verdict carries only owner retry accelerants such as `refresh_now` or `retry_gap`
**THEN** the scheduler SHALL NOT treat those actions as unresolved owner action.

#### Scenario: Owner repair can resume automatic collection

**WHEN** the owner later starts and completes the required repair action
**THEN** the reference SHALL verify the repair through current evidence or one bounded confirming run
**AND** automatic collection MAY resume on the same connection if its schedule and policy allow it.

#### Scenario: Disabled schedule remains owner or policy controlled

**WHEN** a connection's schedule is disabled before repair begins
**AND** the owner completes the required repair action
**THEN** the reference SHALL NOT silently enroll that connection in automatic collection unless an explicit owner action or existing policy says to enable the schedule.

### Requirement: Implementation SHALL Include Regression Evidence

The change SHALL include tests or scripted checks for the primary failure modes that motivated the evidence model.

#### Scenario: Mixed-auth session failure regression

**WHEN** tests simulate a connector that supports stored credentials and browser-session-bound connections
**AND** a browser-session-bound connection emits flattened terminal evidence that the session is required
**THEN** the projection SHALL select `browser_session` repair
**AND** it SHALL NOT select stored-credential capture.

#### Scenario: Historical attention rows do not drive current actionability

**WHEN** tests provide expired, resolved, or cancelled owner-action rows for a connection
**THEN** those rows SHALL NOT drive the current primary CTA, headline owner-action count, or scheduler suppression
**AND** unresolved readiness evidence for the same connection SHALL still project the correct current repair state.

#### Scenario: Scheduler suppression is rendered-verdict driven

**WHEN** tests simulate a scheduled connection whose current rendered verdict carries urgent owner-satisfiable repair
**THEN** the scheduler SHALL skip the unattended run
**AND** tests SHALL also prove that retry accelerants such as `refresh_now` and `retry_gap` do not suppress automation.

#### Scenario: Same-connector connections stay independent

**WHEN** tests simulate two active connections for the same connector type with different binding or schedule state
**THEN** repair routing, scheduler suppression, and post-repair confirmation SHALL be connection-scoped.
