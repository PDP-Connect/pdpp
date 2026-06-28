## MODIFIED Requirements

### Requirement: Controller SHALL expose safe owner run controls

The reference runtime controller SHALL provide owner-only run control behavior for manual runs, pending interactions, active-run conflict detection, single-run cancellation, schedule management, and abandoned controller-managed run reconciliation.

#### Scenario: Managed scheduled run proves owner auth repair is required

- **WHEN** a non-manual controller-managed connector run reaches a terminal failure whose bounded terminal evidence identifies credential or source-session repair as required
- **THEN** the scheduler SHALL mark the existing owner-attention gate for that connector instance
- **AND** a later scheduled tick SHALL skip through the existing needs-human gate instead of relaunching the connector
- **AND** a later owner-started manual run SHALL clear that gate before attempting repair
