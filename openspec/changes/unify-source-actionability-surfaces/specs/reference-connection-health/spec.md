## MODIFIED Requirements

### Requirement: Owner Surfaces SHALL Share One Projection Contract

Dashboard, CLI, and owner-control-plane API surfaces SHALL consume the same connection health projection and condition contract.

Owner-console surfaces that classify connection status or owner actionability SHALL use a shared actionability projection over the server-owned rendered verdict. A surface MAY render a different layout or join additional surface-specific data, but it SHALL NOT independently decide whether the primary action is owner-satisfiable, whether the connection requires owner action now, or whether a source belongs in owner-required, review, system-issue, or checking work.

#### Scenario: Dashboard and CLI agree

**WHEN** the same connection is listed in the dashboard and CLI
**THEN** the dominant state, reason, freshness, coverage, and remediation summary SHALL be derived from the same projection payload.

#### Scenario: Owner console surfaces agree on primary action

**WHEN** the owner console renders the same connection in Overview, Sources, Runs, or connection detail
**THEN** each surface SHALL use the same owner-satisfiable primary-action predicate
**AND** a maintainer-only or wait-only primary action SHALL NOT be counted as owner-required on any of those surfaces
**AND** any Runs action card SHALL be visibly grouped by the same owner-required, review, system-issue, or checking work classification used by the source-attention surfaces.

#### Scenario: Surface layout remains local

**WHEN** a surface needs additional layout-specific data such as run rhythm, schedule editing state, or diagnostics detail
**THEN** it MAY derive that data locally
**AND** it SHALL still consume the shared actionability projection for status and owner-action semantics.

#### Scenario: Grant-scoped clients are isolated

**WHEN** a grant-scoped client queries records or streams
**THEN** owner-only diagnostics such as credential rejection details SHALL NOT be exposed unless a separate owner-debug authorization explicitly permits them.
