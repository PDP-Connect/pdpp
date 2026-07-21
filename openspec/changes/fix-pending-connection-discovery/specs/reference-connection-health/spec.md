## ADDED Requirements

### Requirement: A newly created connection SHALL be discoverable before its first accepted record

The reference implementation SHALL project every owner-created connection — including one that has not yet completed credential capture / browser enrollment and has never ingested a record (a `draft` connector instance) — into the same owner-facing summary read the dashboard, Sources, and Syncs surfaces consume. A connection SHALL NOT be reachable only via a push notification or a bookmarked URL nothing else links to; the normal Sources list, Syncs list, and direct-by-id navigation to the connection SHALL all surface it.

This is scoped to the one owner-facing summary read (`/_ref/connectors` / `listConnectorInstanceRowsForDashboard`). Every other read of connector instances (`/_ref/connections`, `/_ref/connector-instances`, owner-agent reads, the connector-template "already connected" projection, device-exporter listings) SHALL continue to exclude a not-yet-ingested draft exactly as before, to preserve the existing protection against phantom zero-record rows on those surfaces.

#### Scenario: A freshly created draft connection appears on Sources and Syncs

**WHEN** an owner creates a new credential-backed connection and it is persisted as a `draft` connector instance
**THEN** the connection SHALL appear in the Sources list and the Syncs list
**AND** its owner state SHALL be `setup_in_progress`, never absent, never `healthy`.

#### Scenario: Direct navigation to a draft connection's detail route does not 404

**WHEN** an owner navigates directly to a draft connection's `/sources/:id` route (by bookmark, history, or typed URL)
**THEN** the reference implementation SHALL resolve the connection (not 404)
**AND** the console SHALL redirect the owner to the connection's durable setup-status page rather than rendering a health/coverage detail view the connection has no evidence for.

#### Scenario: Every other connector-instance read surface still hides the draft

**WHEN** an owner-agent bearer, the connector-template catalog, or a device-exporter listing reads connector instances for the owner
**THEN** a not-yet-ingested draft connection SHALL remain excluded from that read, exactly as before this change.

### Requirement: `setup_in_progress` SHALL be a first-class owner state, reachable only from explicit draft lifecycle evidence

The reference implementation SHALL derive a closed `setup_in_progress` owner-state resolver from explicit connector-instance lifecycle evidence (`status === "draft"`) — never inferred from health, coverage, or schedule shape. It SHALL take priority over every other resolver except `retired`, so a draft connection with no run/schedule/coverage evidence never falls through to `not_measured` or `healthy`. Its `owner_of_state` SHALL be `owner` (the owner has something to finish) and its `posture` SHALL be `observed` (there is no frozen defect being re-shown, only an honest "not started yet" fact).

#### Scenario: Draft lifecycle evidence resolves setup_in_progress regardless of health shape

**WHEN** the owner-state derivation receives lifecycle evidence with `status: "draft"`
**THEN** it SHALL resolve `setup_in_progress`, `owner_of_state: "owner"`, `posture: "observed"`
**AND** this SHALL hold regardless of what the connection's verdict/health snapshot would otherwise indicate.

#### Scenario: setup_in_progress is unreachable without explicit draft evidence

**WHEN** the owner-state derivation receives lifecycle evidence that is `null` or has any status other than `"draft"`
**THEN** it SHALL NOT resolve `setup_in_progress`, even for a connection with no run history.

### Requirement: Every Continue/Open action for a pending connection SHALL target the same authoritative surface

The console SHALL route every visible "Continue setup" affordance for a `setup_in_progress` connection — the Sources list row, the Sources next-action CTA, the Sources passport-foot action, the Syncs pending-setup card, and a direct-by-id `/sources/:id` navigation — to the SAME durable, binding-agnostic status target. This target SHALL work identically for both static-secret and browser-enrollment-shell connections; no connector SHALL be special-cased.

#### Scenario: All Sources affordances for a draft connection resolve to one URL

**WHEN** a draft connection is rendered in the Sources list
**THEN** its row link, next-action CTA, and passport-foot action SHALL all resolve to the same connection-setup-status URL.

#### Scenario: The Syncs pending-setup card targets the same URL as Sources

**WHEN** a draft connection is rendered as a Syncs pending-setup card
**THEN** its Continue action SHALL target the identical URL the connection's Sources row resolves to.

#### Scenario: Push notifications remain supplementary, not the sole discovery path

**WHEN** an interactive first sync starts on a draft connection
**THEN** a push notification MAY still be sent for faster discovery
**AND** the connection SHALL remain independently discoverable through Sources and Syncs whether or not the owner receives, opens, or acts on that notification.

## MODIFIED Requirements

### Requirement: Owner Surfaces SHALL Share One Projection Contract

The reference implementation SHALL project one shared verdict/actionability contract across the dashboard, Sources, Syncs, and connection-detail surfaces. Every owner surface consuming connector summaries SHALL render the same primary action, headline count, and work-group label for a given connection state — including the `setup_in_progress` state, which SHALL project identically (same label, same Continue target) wherever it renders.

#### Scenario: Dashboard and CLI agree

(unchanged — see reference-connection-health base spec)

#### Scenario: Owner console surfaces agree on primary action

(unchanged — see reference-connection-health base spec)

#### Scenario: A pending connection reads identically on every surface

**WHEN** a `draft` connection is rendered on the Sources list, the Syncs list, and (via redirect) the connection-setup-status page
**THEN** all three SHALL agree that the connection needs the owner's action to continue setup
**AND** none SHALL project it as healthy, degraded, or blocked — those tones require evidence a draft does not have.

### Requirement: Readiness SHALL Be First-Class

(unchanged base requirement — see reference-connection-health base spec — plus:)

A connection's readiness projection SHALL account for connector-instance lifecycle state as a precondition to any readiness claim: a `draft` connection SHALL project `setup_in_progress`, never a credential-readiness or session-readiness verdict, since neither concept applies until the connection has completed its first credential capture / enrollment.

#### Scenario: A draft connection does not project a credential-readiness verdict

**WHEN** a connection's connector-instance lifecycle status is `draft`
**THEN** its projected state SHALL be `setup_in_progress`
**AND** it SHALL NOT project `credential_required`, `credentials_valid`, or any other credential/session-readiness condition, since no credential has been captured yet.
