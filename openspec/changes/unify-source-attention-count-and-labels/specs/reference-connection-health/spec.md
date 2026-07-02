# reference-connection-health (delta)

## MODIFIED Requirements

### Requirement: Owner Surfaces SHALL Share One Projection Contract

Dashboard, CLI, and owner-control-plane API surfaces SHALL consume the same connection health projection and condition contract.

Owner-console surfaces that classify connection status or owner actionability SHALL use a shared actionability projection over the server-owned rendered verdict. A surface MAY render a different layout or join additional surface-specific data, but it SHALL NOT independently decide whether the primary action is owner-satisfiable, whether the connection requires owner action now, or whether a source belongs in owner-required, review, system-issue, or checking work.

Owner surfaces that present a headline count of sources needing attention SHALL derive that headline count from one shared function over the shared actionability projection. The headline "needs your action" count SHALL equal the size of the owner-required (needs-you) work group and SHALL NOT sum in the review, system-issue, or checking groups. A surface MAY additionally show a separate, distinctly-labeled secondary count for the wider reviewable set, but SHALL NOT present that wider number as the headline "needs you" count. When a surface renders the owner-required work group as rows, the headline count SHALL equal the number of rows in that primary group on the same surface.

The owner-facing label and one-line explanation for each of the owner-required, review, system-issue, and checking work groups SHALL come from the shared actionability projection. Owner surfaces SHALL NOT re-author per-surface group labels or notes for these four groups, so the dashboard and Runs surfaces render identical category copy. The non-urgent owner-runnable (review) group SHALL be presented as concrete available actions — labeled as available actions and, per row, preferring the rendered verdict's action CTA — rather than as a "ready for review" taxonomy noun. This owner-facing copy SHALL stay product-facing and neutral: it SHALL NOT expose the internal term "reference" for the product, and SHALL NOT use dramatic phrasing for non-urgent states.

#### Scenario: Dashboard and CLI agree

**WHEN** the same connection is listed in the dashboard and CLI
**THEN** the dominant state, reason, freshness, coverage, and remediation summary SHALL be derived from the same projection payload.

#### Scenario: Owner console surfaces agree on primary action

**WHEN** the owner console renders the same connection in Overview, Sources, Runs, or connection detail
**THEN** each surface SHALL use the same owner-satisfiable primary-action predicate
**AND** a maintainer-only or wait-only primary action SHALL NOT be counted as owner-required on any of those surfaces
**AND** any Runs action card SHALL be visibly grouped by the same owner-required, review, system-issue, or checking work classification used by the source-attention surfaces.

#### Scenario: Headline count equals its primary group and matches across surfaces

**WHEN** an owner has one source in the owner-required (needs-you) group and at least one source in each of the review, system-issue, and checking groups
**THEN** the dashboard hero headline "needs you" count SHALL equal the number of owner-required sources
**AND** that headline count SHALL be strictly less than the total number of source-attention rows rendered on the dashboard
**AND** the Runs surface's primary "needs you" count SHALL equal the dashboard hero headline count for the same connector set
**AND** neither surface SHALL sum the review, system-issue, or checking groups into the headline "needs you" count.

#### Scenario: Work-group labels are shared, not re-authored

**WHEN** the dashboard and the Runs surface each render the owner-required, review, system-issue, and checking work groups
**THEN** the label and one-line note for each group SHALL be sourced from the shared actionability projection
**AND** the group labels rendered on the dashboard SHALL be identical to those rendered on Runs.

#### Scenario: The non-urgent owner-action group reads as concrete available actions

**WHEN** a source belongs to the review (owner-runnable, non-urgent) work group and the rendered verdict supplies its owner-satisfiable primary-action CTA
**THEN** the owner-facing group label SHALL name available actions rather than a review taxonomy noun
**AND** the owner-facing row SHALL prefer the concrete action from the verdict CTA (for example "Amazon - Personal: Refresh now" or "Chase - Personal: Retry now") over generic "ready for review" copy
**AND** a dashboard hero raised for that group SHALL lead with the same concrete action rather than "ready for review" copy.

#### Scenario: Owner-facing work-group copy stays product-facing and neutral

**WHEN** the shared actionability projection supplies the owner-facing label or note for any of the four work groups
**THEN** that copy SHALL NOT use the internal term "reference" for the product (it uses the product-facing name PDPP or neutral phrasing)
**AND** it SHALL NOT use dramatic or alarming phrasing for a non-urgent state.

#### Scenario: Surface layout remains local

**WHEN** a surface needs additional layout-specific data such as run rhythm, schedule editing state, or diagnostics detail
**THEN** it MAY derive that data locally
**AND** it SHALL still consume the shared actionability projection for status and owner-action semantics.

#### Scenario: Grant-scoped clients are isolated

**WHEN** a grant-scoped client queries records or streams
**THEN** owner-only diagnostics such as credential rejection details SHALL NOT be exposed unless a separate owner-debug authorization explicitly permits them.

### Requirement: Owner actions SHALL be a typed required-action list with derived terminality and one unified satisfaction contract

The rendered verdict's primary required action SHALL remain the single action source consumed by owner surfaces. Owner surfaces SHALL NOT replace an owner-runnable required action with a generic run control. Owner surfaces SHALL render run-start controls only for required-action kinds that actually start a run from that surface, and SHALL route other owner-runnable actions to the appropriate detail flow.

When a server action starts or reports an existing run, the owner surface SHALL expose a concrete run-detail link whenever a run id is present. It SHALL preserve the full run id string returned or named by the server.

A credential-rejection condition's remediation label SHALL name the same single recovery action as the rendered verdict's reconnect CTA. The reference SHALL NOT emit a competing credential-recovery phrasing (for example one that offers "reconnect or update" as if they were two different actions) alongside the rendered verdict's single reconnect CTA for the same rejected credential.

#### Scenario: Owner-runnable non-run action is not rendered as generic sync

**WHEN** a source verdict's primary required action is owner-runnable but is not `refresh_now` or `retry_gap`
**THEN** the Sources view renders it as a detail hint using the server-owned CTA
**AND** the Sources view SHALL NOT render a generic `Sync now` button for that action.

#### Scenario: Run-start result links to the concrete run

**WHEN** the owner starts a run or the server reports a run is already active
**THEN** the Sources view shows the run-start result inline
**AND** when a run id is present, the result links to that run's detail route while preserving the full run id.

#### Scenario: Credential rejection names one reconnect action

**WHEN** a connection's credentials are rejected and both the rendered verdict CTA and the connection-health remediation label are produced for that condition
**THEN** the remediation label SHALL name the same single reconnect action as the rendered verdict CTA
**AND** the reference SHALL NOT present a "reconnect or update" phrasing that reads as two distinct owner actions for the one rejected credential.
