## MODIFIED Requirements

### Requirement: The CLI SHALL make owner approval link-based and inspectable

The reference CLI SHALL let an agent create a pending grant request and communicate an owner approval URL and/or verification code that the owner can complete in a browser. After approval, the CLI SHALL also provide grant-scoped read commands that use the cached client credential to call public resource-server read endpoints without owner credentials.

#### Scenario: Approved grant is used for reads

- **WHEN** an agent has an approved cached client grant
- **THEN** the CLI SHALL be able to call grant-scoped schema, stream, record, search, and aggregate read endpoints with that grant
- **AND** it SHALL NOT require an owner token for those reads
- **AND** it SHALL surface canonical response warnings on stderr.
