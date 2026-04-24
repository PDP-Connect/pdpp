## ADDED Requirements

### Requirement: Reference runtime commitments are specified before graduation
Reference-specific runtime behavior SHALL be captured in canonical OpenSpec requirements before it graduates from active program work into durable reference substrate behavior.

#### Scenario: Runtime behavior is ready to graduate
- **WHEN** scheduler behavior, runtime validation, browser-profile binding, filesystem binding, connector runtime logging, inbox behavior, or notification behavior becomes durable reference-substrate behavior
- **THEN** this capability SHALL define the corresponding normative requirements and scenarios
- **AND** the requirements SHALL distinguish reference-specific commitments from root PDPP Collection Profile semantics

#### Scenario: Cleanup creates the follow-up stub
- **WHEN** corpus cleanup identifies reference-runtime behavior that is implemented or planned but not yet canonically specified
- **THEN** the cleanup MAY create this follow-up change without deciding the unresolved product scope
