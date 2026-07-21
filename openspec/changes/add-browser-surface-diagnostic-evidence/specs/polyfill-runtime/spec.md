## ADDED Requirements

### Requirement: Browser failure diagnostics retain structural evidence safely

The reference runtime SHALL provide and enforce a shared closed schema for a
connector to attach browser-surface structural evidence to an existing failure
diagnostic. The schema SHALL not change Collection Profile messages,
connector manifests, stream requiredness, or coverage policy.

The evidence SHALL contain exactly one of the fixed pairs
`chase_current_activity/final_snapshot` or
`usaa_transaction_export/no_export_affordance`; closed route, managed-surface,
wait, and posture enums; and bounded non-negative structural counts. The
runtime SHALL freshly construct the persisted evidence from that allowlist and
drop all sibling diagnostics when `browser_surface` is present. It SHALL omit
fixture references until a trusted scrubbed-fixture registry is introduced.
It SHALL NOT contain page text, raw DOM, raw URLs, account identifiers,
credentials, cookies, tokens, raw fixture paths, arbitrary phase/surface
strings, DOM tag/class/id values, errors, artifact metadata, or filenames.
It SHALL derive posture from validated surface-specific counts rather than
trusting the connector-supplied posture. Chase-only dashboard/table/parser/
empty facts SHALL be zero for USAA; USAA-only account/transaction/navigation
facts SHALL be zero for Chase.

#### Scenario: recognized surface has parser output

**WHEN** a connector reports a known marker and positive parsed-row or
affordance count through the closed schema
**THEN** the runtime SHALL persist `recognized` structural evidence
**AND** the evidence SHALL be safe to attach to existing `SKIP_RESULT`
diagnostics when the connector needs to report a separate failure.

#### Scenario: explicit empty state is verified

**WHEN** a connector supplies a verified empty-state marker and parser output
is zero through the closed schema
**THEN** the runtime SHALL persist `verified_empty` evidence
**AND** it SHALL NOT itself accept absence or alter stream coverage policy.

#### Scenario: contradictory posture is supplied

**WHEN** the connector supplies a posture that disagrees with the validated
surface-specific counts
**THEN** the runtime SHALL persist only the posture it derives from those
counts
**AND** zero relevant facts SHALL persist as `unexpected`
**AND** `verified_empty` SHALL require a positive empty marker with zero
target/parser counts
**AND** `parser_zero` SHALL require Chase dashboard or table evidence with
zero target/parser/empty counts and SHALL never persist for USAA.

#### Scenario: no known structure is present

**WHEN** marker, affordance, empty-state, and parser counts are zero
**THEN** the runtime SHALL persist `unexpected` evidence
**AND** it SHALL NOT attribute the observation to a provider outage.

#### Scenario: sensitive browser data is supplied

**WHEN** a caller provides a URL containing query or fragment data, free text,
an identifier, an unknown enum, an extra nested key, or a fixture reference
**THEN** the runtime SHALL reject the invalid structural object or reconstruct
only its registered fields
**AND** no sensitive or sibling diagnostic value SHALL persist.
