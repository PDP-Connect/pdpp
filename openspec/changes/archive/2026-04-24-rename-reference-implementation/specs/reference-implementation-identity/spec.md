## ADDED Requirements

### Requirement: The forkable implementation substrate has a reference-implementation identity
The repo MUST present the forkable implementation substrate as the **reference implementation** in active code, package metadata, OpenSpec artifacts, and active implementation-facing docs.

#### Scenario: Directory and package identity are aligned
- **WHEN** an implementer looks for the runnable substrate in the repo
- **THEN** they find it under `reference-implementation/`
- **AND** its package metadata identifies it as the reference implementation rather than an end-to-end test harness

#### Scenario: Active docs point implementers at the reference implementation
- **WHEN** an active doc tells implementers where to find the runnable substrate
- **THEN** it points to `reference-implementation/`
- **AND** it does not describe that package as merely “e2e”
