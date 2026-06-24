## ADDED Requirements

### Requirement: Owner console SHALL be governed by core owner journeys

The reference owner console SHALL be evaluated against core owner journeys before broad UI changes are accepted. The core journeys SHALL include source inventory, source setup/configuration, record inspection, source recovery, access/grants, activity/audit evidence, and fresh-owner onboarding.

#### Scenario: A console change affects a primary owner surface

- **WHEN** a change affects dashboard, sources, add-data, explore, recovery, grants, reads, runs, traces, owner credentials, or connector setup
- **THEN** the change SHALL identify the affected owner journey before implementation
- **AND** it SHALL define the owner-visible acceptance check for that journey

#### Scenario: A change passes local tests but fails the journey

- **WHEN** unit tests, type checks, or copy scanners pass
- **AND** the affected owner journey still leaves the owner unable to complete the job or understand the next action
- **THEN** the change SHALL NOT be considered complete

#### Scenario: A fresh owner deploys or opens a personal instance

- **WHEN** a motivated Docker, Railway, or self-hosted owner opens the console without repository context
- **THEN** the console SHALL make readiness, the next source-setup action, first-record progress, and the normal AI-client connection path discoverable from owner-facing surfaces
- **AND** the owner SHALL NOT need a monorepo checkout, raw owner bearer token, internal identifier, or prior chat context to complete the normal path

### Requirement: Owner console SHALL preserve one owner-facing noun model

The owner console SHALL use a consistent owner-facing noun model for data-producing instances, streams, records, grants, reads, runs, traces, devices, credentials, and schedules. Owner-facing navigation, page headings, CTA labels, and URLs SHALL NOT require the owner to translate between unrelated terms for the same object.

#### Scenario: A configured data-producing instance is displayed

- **WHEN** the console displays a configured provider account, local collector binding, browser-backed source, or imported artifact source
- **THEN** the console SHALL use `Source` as the owner-facing noun consistently in navigation, headings, and actions
- **AND** any internal identifier such as `connection_id`, connector instance ID, or source instance ID SHALL be shown only when it helps an advanced/debug task

#### Scenario: A route uses a legacy name

- **WHEN** a legacy route remains reachable for compatibility
- **THEN** the owner-facing page SHALL still render the current noun model
- **AND** the legacy route SHALL NOT introduce contradictory terminology in normal owner copy

### Requirement: Evidence surfaces SHALL be subordinate to their subject in normal owner journeys

Runs, traces, timelines, diagnostics, device exporters, and low-level protocol artifacts SHALL be treated as evidence layers for a source, grant, read, run, or credential unless the owner intentionally enters an advanced/debug view.

#### Scenario: A source needs recovery

- **WHEN** a source requires owner action
- **THEN** the primary CTA SHALL lead to a focused source recovery surface or panel
- **AND** the owner SHALL NOT have to infer the action by browsing generic traces, generic run lists, or unrelated device-exporter lists

#### Scenario: A grant or read is inspected

- **WHEN** an owner inspects what a client can read or has read
- **THEN** the console SHALL show the grant/read subject first
- **AND** trace or timeline events SHALL be linked as supporting evidence rather than replacing the subject summary

### Requirement: Add-data surfaces SHALL distinguish available setup from unavailable or advanced paths

The primary add-data flow SHALL show only setup or import actions that the current deployment can honestly perform. Unavailable, future, operator-gated, proof-gated, or advanced-development paths SHALL be separated from the primary add-now flow and labeled in owner language.

#### Scenario: A connector can be set up now

- **WHEN** the current deployment can capture the required credential, import the required artifact, enroll the required local collector, or start the required browser setup path
- **THEN** the add-data surface SHALL show a primary setup action
- **AND** the flow SHALL support adding another source for a connector type already in use when the connector semantics allow multiple accounts or devices

#### Scenario: A connector cannot be set up from the current surface

- **WHEN** a connector is known but cannot be set up from the current owner surface
- **THEN** the connector SHALL NOT appear as a primary setup action
- **AND** any visible entry SHALL state the owner-readable reason and the real next step, if one exists

### Requirement: Record inspection surfaces SHALL preserve one record truth

Source stream views and Explore SHALL render records through a shared record model and SHALL distinguish total records held, records collected during a run, and records visible under current filters.

#### Scenario: An owner opens a stream from a source

- **WHEN** the owner opens a stream from a source detail view
- **THEN** the stream count and record list SHALL either match the scoped record workbench
- **OR** clearly state the filter, pagination, or delta that explains the difference

#### Scenario: A record is visible in multiple surfaces

- **WHEN** the same record is rendered in source stream detail and Explore
- **THEN** the human-readable record rendering SHALL be consistent
- **AND** raw JSON SHALL be available as supporting source detail rather than as a competing primary rendering

#### Scenario: A list contains more records than the initial page can render

- **WHEN** an owner opens a source, stream, grant-readable record set, or Explore result whose backing set is larger than the initial rendered page
- **THEN** the surface SHALL provide pagination, virtualization, or another full-set navigation affordance that can reach the remaining records
- **AND** the surface SHALL NOT present a performance cap or bounded sample as the final answer to the owner's request

#### Scenario: A bounded sample is used as a preview

- **WHEN** a surface intentionally renders a bounded preview or sample for performance or orientation
- **THEN** the sample SHALL be labeled as a preview with its basis, such as current filter and known total when available
- **AND** the same surface SHALL provide a direct path to the full paginated or virtualized set
- **AND** the sample SHALL NOT be described as "all time", "default filters", or a stream total unless it is the full set

### Requirement: Owner console SHALL meet interaction-archetype standards

The owner console SHALL evaluate changed surfaces against the interaction archetype they implement, not only against information architecture and data correctness. Archetypes SHALL include record workbench, source setup, source inventory/status, recovery/long-running operations, access review, evidence timeline, and cross-surface craft.

#### Scenario: An owner-facing journey surface is changed

- **WHEN** a change affects a primary owner-facing journey surface
- **THEN** the surface SHALL present its owner job, primary meaning, and primary next action before implementation evidence
- **AND** debug details, protocol terms, raw identifiers, and diagnostic payloads SHALL remain secondary unless the owner intentionally enters an advanced or debug path
- **AND** the surface SHALL avoid alarmist copy, false reassurance, buried risk, and wall-of-text explanations as the default owner experience

#### Scenario: A record workbench is changed

- **WHEN** a change affects Explore, source stream records, grant-readable records, or another record-inspection surface
- **THEN** the surface SHALL provide obvious and reversible selection affordances
- **AND** it SHALL preserve rapid multi-select intent during loading
- **AND** search, filters, date controls, sorting, ID jump, and pagination or virtualization SHALL behave as modern workbench controls rather than as debug-only inputs
- **AND** the current record view state SHALL be URL-addressable when it represents a shareable owner query

#### Scenario: A setup or connector-catalog surface is changed

- **WHEN** a change affects Add Data, connector setup, provider-secret capture, browser setup, artifact import, or local collector enrollment
- **THEN** the primary action SHALL be a real setup/import/enrollment path for the current deployment
- **AND** prerequisites, scope requirements, owner naming, identity echo, validation, and first-collection progress SHALL be visible before the flow is considered complete

#### Scenario: A browser-backed source supports stored credentials

- **WHEN** an owner configures a browser-backed source whose connector declares source-scoped credential capture
- **THEN** the setup surface SHALL make stored credentials an explicit owner choice for that source
- **AND** the setup surface SHALL explain that stored credentials may be reused to try login again when the browser session expires
- **AND** a browser-only setup path SHALL remain available when the owner does not want to store provider credentials
- **AND** provider-account credentials SHALL NOT be read from deployment-wide environment variables to satisfy that source setup or later collection

#### Scenario: A provider-secret source is created

- **WHEN** an owner creates a source by submitting a provider secret or provider token
- **THEN** the setup flow SHALL capture an owner-supplied source label or echo a non-secret verified account identity before first collection starts
- **AND** the resulting source SHALL preserve that label or identity-derived label as the source's owner-facing `display_name`
- **AND** provider-specific token URLs, scopes, permissions, and expiration guidance SHALL come from connector-authored setup metadata rather than connector-specific console branches

#### Scenario: A recovery or long-running operation is changed

- **WHEN** a change affects source recovery, first sync, upload drain, import processing, browser setup, reauthorization, or another owner-triggered long operation
- **THEN** the initiating surface SHALL show one owner-legible cause and one closing action when owner action is required
- **AND** it SHALL show progress while work is running
- **AND** it SHALL reconcile to a terminal state without requiring the owner to manually refresh

#### Scenario: An access-review surface is changed

- **WHEN** a change affects grants, Connect AI Apps, owner tokens, client detail, or read history
- **THEN** the owner SHALL be able to answer which client can read what data and what that client has actually read
- **AND** scope, activity, last-used facts, and revocation SHALL be presented as an access-review product rather than as raw trace forensics

#### Scenario: An evidence timeline is changed

- **WHEN** a change affects runs, traces, timelines, diagnostics, event subscriptions, or advanced evidence detail
- **THEN** evidence SHALL remain linked to the subject it explains
- **AND** event detail SHALL be scannable, filterable, linked to adjacent artifacts, and free of layout overflow as a normal owner experience

#### Scenario: Owner-facing craft is changed

- **WHEN** a change affects row selection, focus, layout, loading, transitions, or mobile behavior
- **THEN** clickable and selected states SHALL be visually distinct and consistent among sibling elements
- **AND** loading or route transitions SHALL preserve accepted owner input rather than dropping interaction intent
- **AND** desktop and mobile layouts SHALL preserve hierarchy without crushed sidebars, empty gutters, or horizontal overflow

### Requirement: Owner-visible counts SHALL be basis-labeled and drillable

Every owner-visible count SHALL state or imply its basis unambiguously. The console SHALL distinguish at least total records held, current-filter results, current-page or preview rows, records collected in the most recent run, and records collected during the most recent run that found new data. Rollup counts SHALL drill through to the counted subjects when those subjects are visible to the owner.

#### Scenario: A stream count differs from a record workbench count

- **WHEN** a source stream row shows a total held count
- **AND** Explore or a stream workbench renders only a page, preview, or filtered subset for that stream
- **THEN** each count SHALL carry its basis
- **AND** the workbench SHALL expose a full-set path rather than leaving the owner to infer that records are missing

#### Scenario: A summary says that items need review or action

- **WHEN** a dashboard, source list, runs/syncs view, grant page, or credential page shows "N needs review", "N needs action", "N wrong", or equivalent rollup language
- **THEN** the owner SHALL be able to reveal or navigate to exactly the N counted subjects
- **AND** the predicate used for the rollup SHALL match the predicate used for the listed subjects

#### Scenario: A collection count is shown

- **WHEN** a run, source, stream, or setup status shows a "collected" count
- **THEN** it SHALL distinguish records collected in the latest run, records collected in the latest run that found new data, and total records held when more than one of those facts is relevant
- **AND** it SHALL NOT collapse "checked and found no new data" into a label that looks like a record-yield count

### Requirement: Owner actions SHALL be subject-scoped and verb-honest

Every owner-facing action SHALL either perform the verb it names or navigate to a subject-scoped surface that can complete that verb. Actions SHALL preserve the source, stream, grant, run, credential, or client subject they were launched from.

#### Scenario: An owner clicks a subject-scoped action

- **WHEN** the owner clicks "View records", "Explore", "Review", "Reauthorize", "Open run", "Open trace", "Recover", or an equivalent action from a source, stream, grant, run, read, credential, or client
- **THEN** the target SHALL preserve the subject in URL state or route parameters
- **AND** the target SHALL render a headline or context marker that matches the subject
- **AND** the action SHALL NOT drop the owner into a generic list unless the generic list is filtered to that subject

#### Scenario: An action is not currently implementable

- **WHEN** the current deployment cannot complete a setup, reauthorization, recovery, provider-configuration, or bug-report action
- **THEN** the console SHALL NOT render it as a primary actionable CTA
- **AND** any visible secondary entry SHALL state the owner-readable reason and real next step, if one exists

### Requirement: Setup and recovery flows SHALL provide live progress and terminal reconciliation

Setup, first sync, local-collector recovery, provider/browser setup, upload drain, and other owner-triggered long-running operations SHALL show progress and reconcile to a terminal state without requiring the owner to manually refresh or infer completion from unrelated pages.

#### Scenario: A setup flow starts first collection

- **WHEN** a source setup accepts credentials, starts a first sync, or creates a source pending collection
- **THEN** the setup surface SHALL distinguish credential accepted, first collection running, first collection completed with visible yield, completed with zero yield, and failed
- **AND** the surface SHALL auto-refresh or subscribe until a terminal first-collection state is visible
- **AND** it SHALL not report final success while the stream counts or coverage facts the owner can see remain unsettled without explanation

#### Scenario: A browser-backed setup starts enrollment

- **WHEN** browser-backed source setup creates a pending enrollment shell or starts a browser run
- **THEN** the owner SHALL have a durable setup-status surface keyed to that exact setup attempt
- **AND** the status surface SHALL distinguish browser login needed, browser setup running, completed with visible yield, completed with zero yield, failed, and abandoned
- **AND** launch transport errors SHALL route the owner to that setup-status surface rather than only to a generic run or trace list

#### Scenario: A browser-backed setup creates another source for the same connector

- **WHEN** a browser-backed setup run is scoped to a pending or newly-created source identity
- **THEN** the run SHALL NOT use deployment-wide provider credentials or another source's browser session to complete setup
- **AND** setup SHALL require an owner-visible browser login or an already-authenticated browser profile scoped to that exact source identity before records are accepted for that source

#### Scenario: A supported browser-backed provider can capture source credentials

- **WHEN** a browser-backed connector declares manifest-owned credential capture for username/password or equivalent owner-provided credentials
- **THEN** the default Add Data route SHALL ask for the source-scoped credential before starting the browser-backed first collection
- **AND** after capture the owner SHALL be routed to a durable setup-status surface while first collection runs
- **AND** the secure browser SHALL be presented only when the run reports a current owner interaction for login, OTP, challenge, or identity confirmation
- **AND** the credential capture route SHALL live under the Sources/Add Data information architecture, not the AI-client connection surface
- **AND** owner-agent and CLI setup projections SHALL return the same capture endpoint

#### Scenario: A setup flow uses stored provider credentials

- **WHEN** source setup accepts a provider-account credential such as a password, app password, personal access token, cookie, recovery code, OAuth credential, or OTP helper
- **THEN** that credential SHALL be bound to the source being created or reauthorized
- **AND** the setup flow SHALL NOT read deployment-wide provider-account credentials to satisfy the source
- **AND** the setup flow SHALL show whether the source account identity has been verified before reporting setup success

#### Scenario: A browser-backed setup offers ephemeral login cleanup

- **WHEN** a browser-backed setup offers an option to clear session or credential material after collection
- **THEN** the option SHALL be explicit before setup begins
- **AND** the console SHALL state the tradeoff between lower persistence and increased future login friction
- **AND** the reference SHALL prove the cleanup behavior on at least one connector before advertising the option as generally available

#### Scenario: A local recovery command is offered

- **WHEN** the dashboard or source detail gives the owner a CLI command or UI action to recover a local collector
- **THEN** that command or action SHALL be the one that closes the recovery loop for the stated cause, or the limitation SHALL be explicit before the owner runs it
- **AND** the CLI and console SHALL agree on whether the command only stages work, uploads work, or completes recovery
- **AND** the console SHALL reconcile the source verdict, coverage, and upload progress after the command completes

### Requirement: Owner-console deploy gates SHALL include journey evidence

Substantive owner-console changes SHALL include journey evidence before deploy readiness is claimed. Journey evidence SHALL include desktop pixels, mobile pixels, browser console observations, failed-network observations for browser-driven paths, and data-truth checks when counts, statuses, actions, or grants are affected.

#### Scenario: A browser setup or recovery path is changed

- **WHEN** a browser setup, provider setup, local recovery, or source-status path is changed
- **THEN** mocked-fetch or route-level tests alone SHALL NOT be sufficient evidence
- **AND** the change SHALL include a real browser or equivalent live-path proof, unless the path is explicitly marked unverified

#### Scenario: A worker lane produces a UI change

- **WHEN** a delegated worker lane produces a broad owner-console UI change
- **THEN** the RI owner SHALL review the affected journey evidence before merge or deploy readiness
- **AND** the lane SHALL identify the interaction archetype it changed and provide archetype-specific evidence
- **AND** the worker lane SHALL NOT self-certify product completion solely from local tests

### Requirement: Hard owner-console surfaces SHALL have solution charters before broad implementation

Hard owner-console surfaces SHALL NOT be broadly implemented from raw defect lists alone. The console SHALL use a solution charter to connect documented friction, prior-art anchors, owner promises, product contracts, and acceptance evidence before broad implementation begins.

#### Scenario: A broad implementation affects a hard owner surface

- **WHEN** a change broadly affects Sources/Syncs/Runs, Add Data, Explore, Recovery, Grants/Connect AI Apps, evidence timelines, or fresh-owner onboarding
- **THEN** the work SHALL identify the owner promise it advances
- **AND** it SHALL cite the friction evidence being addressed
- **AND** it SHALL cite the prior-art anchor used as the design bar
- **AND** it SHALL state what useful facts or workflows must be preserved
- **AND** it SHALL state what incidental complexity is being demoted or removed
- **AND** it SHALL define pixel, data-truth, and journey acceptance evidence before implementation is accepted

#### Scenario: A defect is real but low leverage

- **WHEN** a candidate UI fix addresses a real defect
- **AND** it does not directly advance a product promise, remove a core trust blocker, establish a reusable cross-journey contract, or fit as a tiny opportunistic fix inside an accepted tranche
- **THEN** it SHALL be deferred rather than interrupting the active implementation wave

#### Scenario: A change affects counts, statuses, grants, or source state

- **WHEN** a change affects owner-visible counts, source status, coverage, freshness, grant membership, or read/disclosure state
- **THEN** the change SHALL include live read-only or fixture-backed data-truth evidence appropriate to the claim
- **AND** mocked assertions alone SHALL NOT be sufficient to prove the owner-visible truth

#### Scenario: A change affects owner-facing language

- **WHEN** a change affects owner-facing source, recovery, grant, setup, or diagnostic language
- **THEN** the change SHALL verify the owner/operator/protocol vocabulary boundary
- **AND** the verification SHALL NOT rely only on a denylist of previously leaked strings
