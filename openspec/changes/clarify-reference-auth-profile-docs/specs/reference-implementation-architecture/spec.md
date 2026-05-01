## ADDED Requirements

### Requirement: Reference auth docs SHALL distinguish shipped profile from future OAuth profiles

The reference documentation SHALL distinguish the live reference auth profile from generic OAuth authorization-code profiles that are not currently advertised.

#### Scenario: App token issuance is documented

- **WHEN** documentation explains how clients obtain app tokens
- **THEN** it SHALL NOT imply the current reference exposes a generic authorization-code redirect flow
- **AND** it SHALL describe the shipped PAR plus consent direct-token handoff as the current reference profile.
