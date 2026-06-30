## MODIFIED Requirements

### Requirement: Assistance lifecycle is durable and redacted

The reference runtime SHALL expose assistance request, resolution, timeout, cancellation, and escalation transitions in the reference run timeline using safe machine-readable metadata. The reference timeline SHALL NOT persist submitted secrets, raw bearer URLs, durable credentials, or sensitive attachment payloads.

#### Scenario: Background auth repair is required but not attempted

- **WHEN** a non-manual run detects that a source session is inactive and that repair requires owner participation
- **THEN** the run SHALL record bounded terminal evidence that classifies the failure as credential or source-session repair
- **AND** the run SHALL NOT emit repeated owner assistance or interaction prompts from the automatic path
