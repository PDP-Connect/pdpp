## ADDED Requirements

### Requirement: Protocol-facing prose states implementation neutrality

Root PDPP protocol prose and derived public-site documentation SHALL make clear that PDPP conformance does not depend on any specific vendor-hosted service, token, chain, centralized registry lookup, or repository deployment.

#### Scenario: A reviewer reads the root Core spec
- **WHEN** the Core spec describes PDPP identifiers, grants, manifests, or conformance
- **THEN** the prose SHALL preserve the existing URI-federated and grant-pinned model
- **AND** it SHALL NOT imply that a deployment depends on a vendor-controlled service, token, chain, or hosted registry for protocol validity

#### Scenario: The public site renders protocol documentation
- **WHEN** `apps/site` renders protocol-facing documentation or metadata
- **THEN** it SHALL use current protocol-site URLs
- **AND** stale vendor-domain examples SHALL be replaced unless they are intentionally source-repository links or fixtures

### Requirement: Protocol governance is stated without changing wire semantics

Repository prose MAY describe the public contribution workflow, OpenSpec-backed change process, active maintainers/editors, and license posture, but those statements SHALL NOT change PDPP wire formats, grant semantics, identifier semantics, AS behavior, RS behavior, or Collection Profile behavior.

#### Scenario: Governance text is added to a root spec
- **WHEN** governance prose is added to the Core spec
- **THEN** it SHALL be factual repository/process text
- **AND** it SHALL avoid redefining protocol behavior that is already governed by normative sections of the spec
